'use strict';
const express = require('express');
const http = require('http');
const path = require('path');
const Database = require('better-sqlite3');
const fs = require('fs');

const app = express();
app.disable('x-powered-by');

app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    next();
});
const server = http.createServer(app);
const DB_PATH = process.env.CORTEX_DB_PATH || path.join(process.cwd(), "cortex-brain.db");

if (!fs.existsSync(DB_PATH)) {
  console.error("❌ Database not found. Run the scanner first.");
  process.exit(1);
}

// 🔥 فتح آمن للقراءة فقط (يمنع تعارضات القفل)
const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/stats', (req, res) => {
    try {
        const count = sql => db.prepare(sql).get().c;
        res.json({
            success: true,
            data: {
                files: count("SELECT COUNT(*) AS c FROM nodes WHERE kind = 'file'"),
                functions: count("SELECT COUNT(*) AS c FROM nodes WHERE kind = 'function'"),
                methods: count("SELECT COUNT(*) AS c FROM nodes WHERE kind = 'method'"),
                classes: count("SELECT COUNT(*) AS c FROM nodes WHERE kind = 'class'"),
                imports: count("SELECT COUNT(*) AS c FROM edges WHERE kind = 'imports'")
            }
        });
    } catch (e) {
        console.error('Stats endpoint failed:', e);
        res.status(500).json({ success: false, error: 'Unable to retrieve statistics.' });
    }
});

app.get('/api/analytics', (req, res) => {
    try {
        const count = sql => db.prepare(sql).get().c;
        const files = count("SELECT COUNT(*) AS c FROM nodes WHERE kind = 'file'");
        const functions = count("SELECT COUNT(*) AS c FROM nodes WHERE kind = 'function'");
        const methods = count("SELECT COUNT(*) AS c FROM nodes WHERE kind = 'method'");
        const classes = count("SELECT COUNT(*) AS c FROM nodes WHERE kind = 'class'");
        const imports = count("SELECT COUNT(*) AS c FROM edges WHERE kind = 'imports'");

        res.json({
            success: true,
            data: {
                quality: {
                    healthScore: null,
                    healthStatus: 'not_measured',
                    deadCodeEstimate: null,
                    deadCodeStatus: 'heuristic_only'
                },
                distribution: { functions, methods, classes },
                totals: { files, imports },
                methodology: 'Counts are database-derived. Health and dead-code totals are not measured.'
            }
        });
    } catch (e) {
        console.error('Analytics endpoint failed:', e);
        res.status(500).json({ success: false, error: 'Unable to retrieve analytics.' });
    }
});

app.get('/api/search', (req, res) => {
    try {
        const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';

        if (!q || q.length < 2) {
            return res.json({ success: true, data: [] });
        }

        if (q.length > 200) {
            return res.status(400).json({
                success: false,
                error: 'Search query is too long (maximum 200 characters).'
            });
        }

        const tokens = [...new Set(
            Array.from(q.matchAll(/[\p{L}\p{N}_]+/gu), m => m[0])
                .filter(token => token.length > 0)
        )].slice(0, 12);

        if (!tokens.length) {
            return res.json({ success: true, data: [] });
        }

        const searchQuery = tokens
            .map(token => '"' + token.replace(/"/g, '""') + '"*')
            .join(' AND ');

        const results = db.prepare(`
            SELECT n.id, n.name, n.kind, n.file_path, n.signature,
                   substr(n.content, 1, 300) AS content
            FROM nodes_fts f
            JOIN nodes n ON f.rowid = n.id
            WHERE nodes_fts MATCH ?
            ORDER BY
                CASE
                    WHEN lower(n.name) = lower(?) THEN 0
                    WHEN lower(n.name) LIKE lower(?) || '%' THEN 1
                    WHEN instr(lower(n.name), lower(?)) > 0 THEN 2
                    ELSE 3
                END ASC,
                rank ASC
            LIMIT 50
        `).all(searchQuery, q, q, q);

        res.json({ success: true, data: results });
    } catch (e) {
        console.error('Search endpoint failed:', e);
        res.status(500).json({
            success: false,
            error: 'Search failed. Check the query and index.'
        });
    }
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
        const files = db.prepare(`
            SELECT file_path, name, content
            FROM nodes
            WHERE kind = 'file' AND content IS NOT NULL
            ORDER BY file_path
        `).all();

        const maxFindings = 100;
        const findings = [];
        let truncated = false;
        let filesScanned = 0;
        let linesScanned = 0;

        const privateKeyPattern =
            /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/i;
        const accessKeyPattern = /\bAKIA[0-9A-Z]{16}\b/;
        const credentialPattern =
            /(?:["']?\b(?:password|passwd|pwd|api[_-]?key|client[_-]?secret|access[_-]?token|auth[_-]?token|secret(?:[_-]?key)?)\b["']?)\s*[:=]\s*(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|`(?:\\.|[^`\\\r\n])*`|[^\s,;}\]]+)/i;

        function isCommentOnly(line) {
            const trimmed = line.trim();
            return /^(?:\/\/|\/\*|\*\/?|\*|#|<!--|--\s)/.test(trimmed);
        }

        function isDetectorRule(line) {
            return /\bregex\s*:|\.test\(line\)|\.replace\(\s*\//i.test(line);
        }

        function classify(line) {
            if (privateKeyPattern.test(line)) return 'private_key_marker';
            if (accessKeyPattern.test(line)) return 'possible_access_key';
            if (credentialPattern.test(line)) return 'credential_assignment';
            return null;
        }

        for (const file of files) {
            const lines = String(file.content).split(/\r?\n/);
            filesScanned++;

            for (let i = 0; i < lines.length; i++) {
                linesScanned++;
                const line = lines[i];

                if (!line.trim() || isCommentOnly(line) || isDetectorRule(line)) {
                    continue;
                }

                const indicator = classify(line);
                if (!indicator) continue;

                const metadata = {
                    private_key_marker: {
                        severity: 'high',
                        confidence: 'high',
                        recommendation: 'Verify exposure. If a real private key was committed, remove it from source control and rotate or revoke it as appropriate.'
                    },
                    possible_access_key: {
                        severity: 'high',
                        confidence: 'medium',
                        recommendation: 'Verify the key securely with its provider. Revoke and rotate it if valid or exposed.'
                    },
                    credential_assignment: {
                        severity: 'medium',
                        confidence: 'low',
                        recommendation: 'Review the assignment. If it contains a real credential, move it to an approved secret manager or secure configuration.'
                    }
                }[indicator];

                if (findings.length >= maxFindings) {
                    truncated = true;
                    break;
                }

                const safeSnippet = indicator === 'private_key_marker'
                    ? '[Private-key marker detected; source line omitted]'
                    : indicator === 'possible_access_key'
                        ? '[Possible access-key pattern detected; source line omitted]'
                        : '[Possible credential assignment; source line omitted]';

                findings.push({
                    file_path: file.file_path,
                    name: file.name,
                    line: i + 1,
                    indicator,
                    snippet: safeSnippet,
                    status: 'unverified_indicator',
                    severity: metadata.severity,
                    confidence: metadata.confidence,
                    recommendation: metadata.recommendation
                });
            }

            if (truncated) break;
        }

        res.json({
            success: true,
            count: findings.length,
            data: findings,
            truncated,
            coverage: 'Indexed file contents only',
            coverageMetrics: {
                indexedFilesAvailable: files.length,
                filesScanned,
                linesScanned,
                truncated
            },
            methodology: 'Pattern-based heuristic. Comments and detector-rule lines are filtered; false positives and false negatives remain possible.',
            limitation: 'Findings are indicators, not confirmed vulnerabilities. Source snippets are omitted.'
        });
    } catch (e) {
        console.error('Security endpoint failed:', e);
        res.status(500).json({
            success: false,
            error: 'Failed to scan indexed file contents.'
        });
    }
});
app.get('/api/dead-code', (req, res) => {
    try {
        const results = db.prepare(`
            SELECT n1.id, n1.name, n1.file_path, n1.kind
            FROM nodes n1
            WHERE n1.kind IN ('function', 'method')
              AND n1.name IS NOT NULL
              AND TRIM(n1.name) <> ''
              AND NOT EXISTS (
                  SELECT 1
                  FROM nodes n2
                  WHERE n2.kind = 'file'
                    AND n2.file_path <> n1.file_path
                    AND INSTR(COALESCE(n2.content, ''), n1.name) > 0
              )
            LIMIT 100
        `).all();

        res.json({
            success: true,
            count: results.length,
            data: results,
            status: 'heuristic_candidates',
            note: 'Candidates only. Reflection, dynamic calls, entry points, exports, and references not present in indexed file text may cause false positives.'
        });
    } catch (e) {
        console.error('Dead-code endpoint failed:', e);
        res.status(500).json({ error: 'Failed to calculate dead-code candidates.' });
    }
});

app.get('/api/graph', (req, res) => {
    try {
        const files = db.prepare(
            "SELECT id, name, file_path FROM nodes WHERE kind = 'file'"
        ).all();

        const imports = db.prepare(
            "SELECT source, target FROM edges WHERE kind = 'imports'"
        ).all();

        const normalize = value => String(value || '')
            .replace(/\\/g, '/')
            .replace(/\/+/g, '/')
            .replace(/^\.\/+/, '')
            .replace(/\/$/, '')
            .toLowerCase();

        const nodes = files.map(file => ({
            id: String(file.id),
            label: file.name,
            title: file.file_path,
            group: 'file'
        }));

        const fileByPath = new Map();

        for (const file of files) {
            fileByPath.set(normalize(file.file_path), file);
        }

        const extensions = [
            '', '.js', '.mjs', '.cjs', '.ts', '.tsx',
            '.jsx', '.py', '/index.js', '/index.mjs',
            '/index.cjs', '/index.ts', '/index.tsx',
            '/index.jsx', '/index.py'
        ];

        const edges = [];
        const seen = new Set();

        for (const item of imports) {
            if (!item.source || !item.target) continue;

            const specifier = String(item.target).trim();

            // Resolve local relative imports only.
            if (!specifier.startsWith('.')) continue;

            const sourcePath = normalize(item.source);
            const sourceFile = fileByPath.get(sourcePath);

            if (!sourceFile) continue;

            const baseDirectory = path.posix.dirname(sourcePath);
            const resolvedBase = normalize(
                path.posix.normalize(
                    path.posix.join(baseDirectory, specifier)
                )
            );

            const hasExtension =
                Boolean(path.posix.extname(resolvedBase));

            const candidates = hasExtension
                ? [resolvedBase]
                : extensions.map(suffix => resolvedBase + suffix);

            let targetFile = null;

            for (const candidate of candidates) {
                targetFile = fileByPath.get(normalize(candidate));
                if (targetFile) break;
            }

            if (!targetFile || sourceFile.id === targetFile.id) continue;

            const key = `${sourceFile.id}->${targetFile.id}`;

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
        const projectRoot = __dirname;
        const projectName = path.basename(projectRoot).replace(/[^a-zA-Z0-9._-]/g, '_');
        
        if (format === 'handoff') {
            let docContext = `# 🤝 Project Handoff: ${projectName}\n`;
            docContext += `**Generated by Cortex AI Engine:** ${new Date().toISOString()}\n\n`;
            docContext += `> **Instructions for AI Agent:** You are taking over this project. Read the Auto-Generated Architecture and Action Items below, then review the Core Codebase Context to understand the implementation.\n\n`;

            // 1. استخراج معلومات المشروع
            docContext += `## 📦 Project Overview\n`;
            try {
                const pkgPath = path.join(projectRoot, 'package.json');
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

app.use((err, req, res, next) => {
    if (res.headersSent) {
        return next(err);
    }

    const status = Number.isInteger(err.status) &&
        err.status >= 400 && err.status < 500
        ? err.status
        : 500;

    if (status >= 500) {
        console.error('Unhandled request error:', {
            method: req.method,
            path: req.path,
            status
        });
    }

    const message = status === 413
        ? 'Request body too large.'
        : status === 400
            ? 'Invalid request body.'
            : 'Request failed.';

    return res.status(status).json({
        success: false,
        error: message
    });
});
const PORT = Number.parseInt(process.env.PORT || "3000", 10);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
    throw new Error("Invalid PORT: expected an integer from 1 to 65535.");
}
const HOST = process.env.HOST || "127.0.0.1";
server.listen(PORT, HOST, () => console.log(`Universal Cortex Engine running on http://${HOST}:${PORT}`));