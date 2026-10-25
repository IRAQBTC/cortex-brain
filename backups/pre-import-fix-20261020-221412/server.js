'use strict';
const express = require('express');
const http = require('http');
const path = require('path');
const Database = require('better-sqlite3');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const DB_PATH = process.env.CORTEX_DB_PATH || path.join(process.cwd(), "cortex-brain.db");

if (!fs.existsSync(DB_PATH)) {
  console.error("❌ Database not found. Run the scanner first.");
  process.exit(1);
}

// 🔥 فتح آمن للقراءة فقط (يمنع تعارضات القفل)
const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/stats', (req, res) => {
    try {
        res.json({ success: true, data: {
            files: db.prepare("SELECT COUNT(*) as c FROM nodes WHERE kind = 'file'").get().c,
            functions: db.prepare("SELECT COUNT(*) as c FROM nodes WHERE kind IN ('function', 'method')").get().c,
            classes: db.prepare("SELECT COUNT(*) as c FROM nodes WHERE kind = 'class'").get().c,
            imports: db.prepare("SELECT COUNT(*) as c FROM edges").get().c
        }});
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/analytics', (req, res) => {
    try {
        const files = db.prepare("SELECT COUNT(*) as c FROM nodes WHERE kind = 'file'").get().c;
        const functions = db.prepare("SELECT COUNT(*) as c FROM nodes WHERE kind IN ('function', 'method')").get().c;
        const classes = db.prepare("SELECT COUNT(*) as c FROM nodes WHERE kind = 'class'").get().c;
        const healthScore = Math.min(100, Math.max(10, Math.round((functions / Math.max(files, 1)) * 10)));
        res.json({ success: true, data: { 
            quality: { healthScore: healthScore, deadCodeEstimate: Math.floor(functions * 0.1) }, 
            distribution: { functions, classes, methods: Math.round(functions * 0.4) } 
        }});
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/search', (req, res) => {
    try {
        const q = (req.query.q || '').trim();
        if (!q || q.length < 2) return res.json({ success: true, data: [] });
        const safeQ = q.replace(/[^a-zA-Z0-9_\s]/g, ' ');
        const searchQuery = safeQ.split(/\s+/).filter(w => w.length > 0).map(w => w + '*').join(' ');
        const results = db.prepare(`
            SELECT n.id, n.name, n.kind, n.file_path, n.signature, substr(n.content, 1, 300) as content
            FROM nodes_fts f JOIN nodes n ON f.rowid = n.id 
            WHERE nodes_fts MATCH ? ORDER BY rank LIMIT 50
        `).all(searchQuery);
        res.json({ success: true, data: results });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/file', (req, res) => {
    try {
        const { id } = req.query;
        if (!id) return res.status(400).json({ success: false, error: 'ID required' });
        const node = db.prepare("SELECT content, kind, signature, file_path FROM nodes WHERE id = ?").get(id);
        if (node) res.json({ success: true, data: node });
        else res.status(404).json({ success: false, error: 'Not found' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/security', (req, res) => {
    try {
        const results = db.prepare(`
            SELECT file_path, name, substr(content, 1, 150) as snippet
            FROM nodes WHERE kind = 'file' 
            AND (LOWER(content) LIKE '%password%' OR LOWER(content) LIKE '%api_key%' OR LOWER(content) LIKE '%secret%' OR LOWER(content) LIKE '%token%')
            LIMIT 50
        `).all();
        res.json({ success: true, count: results.length, data: results });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/dead-code', (req, res) => {
    try {
        const results = db.prepare(`
            SELECT n1.id, n1.name, n1.file_path, n1.kind
            FROM nodes n1 WHERE n1.kind IN ('function', 'method') 
            AND n1.name NOT IN (
                SELECT DISTINCT n2.name FROM nodes n2 
                WHERE n2.kind = 'file' AND n2.content LIKE '%' || n1.name || '%' AND n2.file_path != n1.file_path
            ) LIMIT 50
        `).all();
        res.json({ success: true, count: results.length, data: results });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/graph', (req, res) => {
    try {
        const files = db.prepare(
            "SELECT id, name, file_path FROM nodes WHERE kind = 'file'"
        ).all();

        const imports = db.prepare(
            "SELECT source, target FROM edges WHERE kind = 'imports'"
        ).all();

        const nodes = files.map(f => ({
            id: String(f.id),
            label: f.name,
            title: f.file_path,
            group: 'file'
        }));

        const fileByPath = new Map();
        for (const file of files) {
            const normalized = String(file.file_path)
                .replace(/\\/g, '/')
                .replace(/^\.\/+/, '')
                .replace(/\/+/g, '/')
                .toLowerCase();

            fileByPath.set(normalized, file);
        }

        const extensions = ['', '.js', '.mjs', '.cjs', '.ts', '.tsx',
            '.jsx', '.py', '/index.js', '/index.mjs', '/index.cjs',
            '/index.ts', '/index.py'];

        const edges = [];
        const seen = new Set();

        for (const item of imports) {
            if (!item.source || !item.target) continue;

            // Only resolve relative imports. External packages are not
            // falsely represented as files inside this project.
            const targetSpecifier = String(item.target).trim();
            if (!targetSpecifier.startsWith('.')) continue;

            const sourcePath = String(item.source).replace(/\\/g, '/');
            const baseDirectory = path.posix.dirname(sourcePath);
            const resolvedBase = path.posix.normalize(
                path.posix.join(baseDirectory, targetSpecifier)
            ).replace(/\\/g, '/').replace(/^\.\/+/, '').toLowerCase();

            let targetFile = null;

            for (const suffix of extensions) {
                const candidate = (resolvedBase + suffix)
                    .replace(/\/+/g, '/')
                    .toLowerCase();

                targetFile = fileByPath.get(candidate);
                if (targetFile) break;
            }

            if (!targetFile) continue;

            const sourceFile = fileByPath.get(
                sourcePath.replace(/^\.\/+/, '').toLowerCase()
            );

            if (!sourceFile || sourceFile.id === targetFile.id) continue;

            const key = `${sourceFile.id}-${targetFile.id}`;
            if (seen.has(key)) continue;
            seen.add(key);

            edges.push({
                from: String(sourceFile.id),
                to: String(targetFile.id),
                arrows: 'to',
                color: '#3b82f6'
            });
        }

        res.json({
            success: true,
            nodes,
            edges,
            meta: {
                indexedFiles: files.length,
                importRecords: imports.length,
                resolvedLocalEdges: edges.length
            }
        });
    } catch (e) {
        console.error('Graph endpoint failed:', e);
        res.status(500).json({ error: 'Failed to build dependency graph.' });
    }
});
app.get('/api/export', (req, res) => {
    try {
        const format = req.query.format || 'json';
        const projectName = path.basename(process.cwd());
        
        if (format === 'handoff') {
            let docContext = `# 🤝 Project Handoff: ${projectName}\n`;
            docContext += `**Generated by Cortex AI Engine:** ${new Date().toISOString()}\n\n`;
            docContext += `> **Instructions for AI Agent:** You are taking over this project. Read the Auto-Generated Architecture and Action Items below, then review the Core Codebase Context to understand the implementation.\n\n`;

            // 1. استخراج معلومات المشروع
            docContext += `## 📦 Project Overview\n`;
            try {
                const pkgPath = path.join(process.cwd(), 'package.json');
                if (fs.existsSync(pkgPath)) {
                    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
                    docContext += `- **Name:** ${pkg.name || projectName}\n`;
                    docContext += `- **Description:** ${pkg.description || 'No description provided.'}\n`;
                    docContext += `- **Main Entry:** \`${pkg.main || 'index.js'}\`\n`;
                    const deps = Object.keys(pkg.dependencies || {}).slice(0, 10).join(', ');
                    docContext += `- **Key Dependencies:** ${deps || 'None'}\n\n`;
                } else {
                    docContext += `- *No package.json found. Raw project.*\n\n`;
                }
            } catch (e) { docContext += `- *Could not parse package.json.*\n\n`; }

            // 2. استخراج الهيكل المعماري (إصلاح استخدام الأعمدة النصية)
            docContext += `## 🏗️ Auto-Generated Architecture (Top Connected Files)\n`;
            const topFiles = db.prepare(`
                SELECT n1.file_path, COUNT(e.source) as dep_count
                FROM nodes n1 
                LEFT JOIN edges e ON n1.file_path = e.source
                WHERE n1.kind = 'file'
                GROUP BY n1.id ORDER BY dep_count DESC LIMIT 5
            `).all();
            
            if (topFiles.length > 0) {
                topFiles.forEach(f => { docContext += `- \`${f.file_path}\` (${f.dep_count} dependencies)\n`; });
            } else {
                docContext += `- *Dependency graph is still building.*\n`;
            }
            docContext += `\n`;

            // 3. استخراج المهام المعلقة (TODOs + FIXMEs)
            docContext += `## 📝 Action Items & TODOs (Extracted from code)\n`;
            const todos = db.prepare(`
                SELECT file_path, substr(content, instr(LOWER(content), 'todo'), 100) as snippet
                FROM nodes WHERE kind = 'file' AND LOWER(content) LIKE '%todo%'
                UNION ALL
                SELECT file_path, substr(content, instr(LOWER(content), 'fixme'), 100) as snippet
                FROM nodes WHERE kind = 'file' AND LOWER(content) LIKE '%fixme%'
                LIMIT 15
            `).all();
            
            if (todos.length > 0) {
                todos.forEach(t => {
                    const cleanSnippet = t.snippet.split('\n')[0].replace(/["']/g, '').replace(/todo/i, 'TODO').replace(/fixme/i, 'FIXME').trim();
                    docContext += `- [ ] \`${t.file_path}\`: ${cleanSnippet}\n`;
                });
            } else {
                docContext += `- *No TODOs or FIXMEs found in the codebase.*\n`;
            }
            docContext += `\n---\n\n`;

            // 4. إضافة الكود الفعلي (السياق)
            docContext += `## 💻 Core Codebase Context\n`;
            const symbols = db.prepare("SELECT kind, name, file_path, signature, content FROM nodes WHERE kind IN ('function', 'class', 'method') LIMIT 50").all();
            symbols.forEach(s => {
                const ext = path.extname(s.file_path).toLowerCase();
                const lang = ['.py'].includes(ext) ? 'python' : (['.rs'].includes(ext) ? 'rust' : 'javascript');
                docContext += `### ${s.kind.toUpperCase()}: ${s.name} (in ${s.file_path})\n`;
                docContext += `\`\`\`${lang}\n${(s.content || '').substring(0, 800)}\n\`\`\`\n\n`;
            });

            res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename=${projectName}-handoff.md`);
            return res.send(docContext);
        }

        const nodes = db.prepare("SELECT id, kind, name, file_path, signature FROM nodes LIMIT 500").all();
        res.setHeader('Content-Disposition', `attachment; filename=${projectName}-context.json`);
        res.setHeader('Content-Type', 'application/json');
        res.json(nodes);
    } catch(e) { res.status(500).send(e.message); }
});

server.listen(3000, () => console.log("🚀 Universal Cortex Engine running on http://localhost:3000"));