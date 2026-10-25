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
const { DB_PATH } = require('./db-path');

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

app.get('/api/index-status', (req, res) => {
    try {
        const table = db.prepare(`
            SELECT name
            FROM sqlite_master
            WHERE type = 'table' AND name = 'index_metadata'
            LIMIT 1
        `).get();

        if (!table) {
            return res.json({
                success: true,
                status: 'not_available',
                data: null,
                message: 'Index metadata is unavailable. Run a successful scan to create it.'
            });
        }

        const record = db.prepare(`
            SELECT root_path, indexed_at, files, symbols, imports
            FROM index_metadata
            WHERE id = 1
            LIMIT 1
        `).get();

        if (!record) {
            return res.json({
                success: true,
                status: 'not_available',
                data: null,
                message: 'No successful indexing record is available yet.'
            });
        }

        const timestamp = Date.parse(record.indexed_at);
        const validCounts = ['files', 'symbols', 'imports'].every(
            key => Number.isSafeInteger(record[key]) && record[key] >= 0
        );

        if (
            typeof record.root_path !== 'string' ||
            record.root_path.length === 0 ||
            !Number.isFinite(timestamp) ||
            !validCounts
        ) {
            return res.status(500).json({
                success: false,
                status: 'error',
                error: 'Index metadata is invalid.'
            });
        }

        return res.json({
            success: true,
            status: 'available',
            data: {
                rootPath: record.root_path,
                indexedAt: record.indexed_at,
                files: record.files,
                symbols: record.symbols,
                imports: record.imports
            }
        });
    } catch (e) {
        console.error('Index status endpoint failed:', e);
        return res.status(500).json({
            success: false,
            status: 'error',
            error: 'Unable to retrieve index status.'
        });
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

app.get('/api/verify', (req, res) => {
    try {
        const type = typeof req.query.type === 'string'
            ? req.query.type.trim().toLowerCase()
            : '';
        const name = typeof req.query.name === 'string'
            ? req.query.name.trim()
            : '';
        const filePath = typeof req.query.filePath === 'string'
            ? req.query.filePath.trim()
            : '';

        const allowedTypes = new Set(['function', 'class', 'method', 'file']);

        if (!allowedTypes.has(type)) {
            return res.status(400).json({
                success: false,
                status: 'INCONCLUSIVE',
                message: 'Unsupported verification type. Use function, class, method, or file.'
            });
        }

        if (!name || name.length > 200 || filePath.length > 1000) {
            return res.status(400).json({
                success: false,
                status: 'INCONCLUSIVE',
                message: 'A name is required (maximum 200 characters); filePath must not exceed 1000 characters.'
            });
        }

        const indexedFiles = db.prepare(
            "SELECT COUNT(*) AS count FROM nodes WHERE kind = 'file'"
        ).get().count;

        if (indexedFiles === 0) {
            return res.status(503).json({
                success: false,
                status: 'INCONCLUSIVE',
                message: 'The index contains no file entries. Run a successful scan before verifying symbols.'
            });
        }

        // A symbol result is only trustworthy when the indexed source snapshot is fresh.
        let sourceAudit;
        try {
            const { inspectSourceIndex } = require('./handoff-generator');
            sourceAudit = inspectSourceIndex(__dirname, db);
        } catch (auditError) {
            console.error('Source/index freshness audit failed:', auditError);
            return res.status(503).json({
                success: false,
                status: 'INCONCLUSIVE',
                message: 'Source/index freshness could not be established. No verification conclusion was issued.'
            });
        }

        if (sourceAudit.status !== 'FRESH') {
            return res.status(503).json({
                success: false,
                status: 'INCONCLUSIVE',
                message: 'The index does not match the current source snapshot. Run a successful scan before verifying symbols.',
                freshness: {
                    status: sourceAudit.status,
                    missingFromIndex: sourceAudit.missingFromIndex.length,
                    missingOnDisk: sourceAudit.missingOnDisk.length,
                    contentDrift: sourceAudit.contentDrift.length,
                    duplicateIndexedPaths: sourceAudit.duplicateIndexedPaths.length,
                    metadataMatches: sourceAudit.metadataMatches
                }
            });
        }
        const metadataTable = db.prepare(`
            SELECT name FROM sqlite_master
            WHERE type = 'table' AND name = 'index_metadata'
            LIMIT 1
        `).get();

        let indexMetadata = null;

        if (metadataTable) {
            indexMetadata = db.prepare(`
                SELECT root_path, indexed_at, files, symbols, imports
                FROM index_metadata
                WHERE id = 1
                LIMIT 1
            `).get() || null;
        }

        let sql = `
            SELECT id, name, kind, file_path, line, signature
            FROM nodes
            WHERE kind = ? AND name = ?
        `;
        const params = [type, name];

        if (filePath) {
            sql += ' AND file_path = ?';
            params.push(filePath);
        }

        sql += ' ORDER BY file_path ASC, line ASC, id ASC LIMIT 26';

        const rows = db.prepare(sql).all(...params);
        const limit = 25;
        const truncated = rows.length > limit;
        const matches = rows.slice(0, limit).map(row => ({
            id: row.id,
            name: row.name,
            kind: row.kind,
            filePath: row.file_path,
            line: Number.isInteger(row.line) ? row.line : null,
            signature: row.signature || null
        }));

        const index = indexMetadata ? {
            rootPath: indexMetadata.root_path,
            indexedAt: indexMetadata.indexed_at,
            files: indexMetadata.files,
            symbols: indexMetadata.symbols,
            imports: indexMetadata.imports
        } : null;

        if (matches.length > 0) {
            return res.json({
                success: true,
                status: 'VERIFIED',
                message: type + " '" + name + "' found in " +
                    matches.length + (truncated ? ' or more indexed location(s).' : ' indexed location(s).'),
                data: matches[0],
                matches,
                matchCount: matches.length,
                truncated,
                index
            });
        }

        return res.json({
            success: true,
            status: 'REFUTED',
            message: type + " '" + name + "' was not found in the current index" +
                (filePath ? ' for file ' + filePath : '') + '. This does not prove the symbol is absent from unindexed or changed files.',
            data: null,
            matches: [],
            matchCount: 0,
            truncated: false,
            index
        });
    } catch (error) {
        console.error('Verification endpoint failed:', error);
        return res.status(500).json({
            success: false,
            status: 'INCONCLUSIVE',
            message: 'Verification failed because the index could not be queried.'
        });
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
        const githubTokenPattern = /\b(?:gh[pousr]_[A-Za-z0-9_]{30,}|github_pat_[A-Za-z0-9_]{20,})\b/;
        const googleApiKeyPattern = /\bAIza[0-9A-Za-z_-]{35}\b/;
        const slackTokenPattern = /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/;
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
            if (githubTokenPattern.test(line)) return 'possible_github_token';
            if (googleApiKeyPattern.test(line)) return 'possible_google_api_key';
            if (slackTokenPattern.test(line)) return 'possible_slack_token';
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
                    possible_github_token: {
                        severity: 'high',
                        confidence: 'medium',
                        recommendation: 'Verify securely with GitHub. Revoke and rotate the token if valid or exposed.'
                    },
                    possible_google_api_key: {
                        severity: 'medium',
                        confidence: 'medium',
                        recommendation: 'Verify securely in Google Cloud. Restrict or rotate the key if valid or exposed.'
                    },
                    possible_slack_token: {
                        severity: 'high',
                        confidence: 'medium',
                        recommendation: 'Verify securely with Slack. Revoke and rotate the token if valid or exposed.'
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
                        : indicator === 'possible_github_token'
                            ? '[Possible GitHub token pattern detected; source line omitted]'
                            : indicator === 'possible_google_api_key'
                                ? '[Possible Google API key pattern detected; source line omitted]'
                                : indicator === 'possible_slack_token'
                                    ? '[Possible Slack token pattern detected; source line omitted]'
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

function normalizeDependencyTarget(value, graph) {
    if (typeof value !== 'string' || !value.trim()) {
        return { error: 'Query parameter "file" is required.' };
    }

    let target = value.trim().replace(/\\/g, '/');
    target = target.replace(/^\.\/+/, '');

    if (
        target.includes('\0') ||
        target.startsWith('/') ||
        /^[A-Za-z]:/.test(target) ||
        target.split('/').some(part => part === '..') ||
        target.split('/').some(part => part === '')
    ) {
        return { error: 'Invalid relative file path.' };
    }

    if (!graph.files.has(target)) {
        return { error: 'File is not present in the current index.' };
    }

    return { target };
}

app.get('/api/dependency-audit', (req, res) => {
  try {
    const { buildDependencyAuditReport } = require('./dependency-audit-report');
    const data = buildDependencyAuditReport();
    return res.json({ success: true, data });
  } catch (error) {
    console.error('[Cortex] Dependency audit failed:', error);
    return res.status(500).json({
      success: false,
      error: 'Dependency audit failed',
      message: error.message
    });
  }
});

app.get('/api/dependency-graph', (req, res) => {
    try {
        const { buildDependencyGraph } = require('./dependency-graph');
        const graph = buildDependencyGraph();
        const unresolvedCounts = {};

        for (const item of graph.unresolved) {
            const category = item.classification || 'unclassified';
            unresolvedCounts[category] = (unresolvedCounts[category] || 0) + 1;
        }

        return res.json({
            success: true,
            data: {
                root: graph.root,
                indexedAt: graph.indexedAt,
                indexedFileCount: graph.indexedFileCount,
                nodeCount: graph.files.size,
                edgeCount: graph.edges.length,
                nodes: [...graph.files.keys()].sort().map(file => ({
                    id: file,
                    label: path.posix.basename(file)
                })),
                edges: graph.edges,
                unresolvedCount: graph.unresolved.length,
                unresolvedCounts,
                unresolved: graph.unresolved.slice(0, 200),
                unresolvedTruncated: graph.unresolved.length > 200,
                methodology: 'Resolved local file imports only; not a complete runtime dependency model.'
            }
        });
    } catch (error) {
        console.error('Dependency graph endpoint failed:', error.message);
        return res.status(500).json({
            success: false,
            error: 'Unable to build the dependency graph.'
        });
    }
});

app.get('/api/dependency-impact', (req, res) => {
    try {
        const { buildDependencyGraph, analyzeFileImpact } =
            require('./dependency-graph');

        const graph = buildDependencyGraph();
        const validation = normalizeDependencyTarget(req.query.file, graph);

        if (validation.error) {
            return res.status(400).json({
                success: false,
                error: validation.error
            });
        }

        const report = analyzeFileImpact(validation.target, graph);

        return res.json({
            success: true,
            data: report
        });
    } catch (error) {
        console.error('Dependency impact endpoint failed:', error.message);
        return res.status(500).json({
            success: false,
            error: 'Unable to calculate dependency impact.'
        });
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

        let relativeImportRecords = 0;
        let nonRelativeImportRecords = 0;
        let invalidImportRecords = 0;
        let resolvedLocalImportRecords = 0;
        let unresolvedRelativeImportRecords = 0;
        let duplicateLocalImportRecords = 0;
        let selfImportRecords = 0;
        let pythonRelativeImportRecordsNotResolved = 0;

        for (const item of imports) {
            const rawSource = String(item.source || '').trim();
            const specifier = String(item.target || '').trim();

            if (!rawSource || !specifier) {
                invalidImportRecords++;
                continue;
            }

            const sourcePath = normalize(rawSource);
            const isPython = path.posix.extname(sourcePath) === '.py';

            // Python dotted-relative imports need Python package-aware
            // resolution; do not incorrectly resolve them as JS paths.
            const isPythonDottedRelative =
                isPython && /^\.+(?:$|[A-Za-z_])/.test(specifier);

            if (isPythonDottedRelative) {
                relativeImportRecords++;
                unresolvedRelativeImportRecords++;
                pythonRelativeImportRecordsNotResolved++;
                continue;
            }

            // Only explicit path-relative imports are resolved here.
            // Bare specifiers are counted but are not assumed to be external.
            const isPathRelative =
                specifier.startsWith('./') ||
                specifier.startsWith('../');

            if (!isPathRelative) {
                nonRelativeImportRecords++;
                continue;
            }

            relativeImportRecords++;

            const sourceFile = fileByPath.get(sourcePath);

            if (!sourceFile) {
                unresolvedRelativeImportRecords++;
                continue;
            }

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

            if (!targetFile) {
                unresolvedRelativeImportRecords++;
                continue;
            }

            resolvedLocalImportRecords++;

            if (sourceFile.id === targetFile.id) {
                selfImportRecords++;
                continue;
            }

            const key = `${sourceFile.id}->${targetFile.id}`;

            if (seen.has(key)) {
                duplicateLocalImportRecords++;
                continue;
            }

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
                relativeImportRecords,
                nonRelativeImportRecords,
                invalidImportRecords,
                resolvedLocalImportRecords,
                unresolvedRelativeImportRecords,
                duplicateLocalImportRecords,
                selfImportRecords,
                pythonRelativeImportRecordsNotResolved,
                resolvedLocalEdges: edges.length,
                resolutionPolicy:
                    'Unique edges represent resolved path-relative imports between indexed files. Non-relative imports are counted but not classified as external.'
            }
        });
    } catch (e) {
        console.error('Graph endpoint failed:', e);
        res.status(500).json({ error: 'Failed to build dependency graph.' });
    }
});

app.get('/api/call-graph', (req, res) => {
    try {
        const { extractLocalCalls } = require('./call-graph');

        const files = db.prepare(`
            SELECT id, file_path, name, content
            FROM nodes
            WHERE kind = 'file' AND content IS NOT NULL
            ORDER BY file_path
        `).all();

        const indexedSymbols = db.prepare(`
            SELECT id, file_path, name, kind, line
            FROM nodes
            WHERE kind IN ('function', 'method')
            ORDER BY file_path, line, id
        `).all();

        const normalize = value => String(value || '')
            .replace(/\\/g, '/')
            .replace(/\/+/g, '/')
            .replace(/^\.\/+/, '')
            .toLowerCase();

        const identityKey = (filePath, name, line) =>
            `${normalize(filePath)}\u0000${String(name)}\u0000${Number(line)}`;

        const nameKey = (filePath, name) =>
            `${normalize(filePath)}\u0000${String(name)}`;

        const symbolIndex = new Map();

        for (const symbol of indexedSymbols) {
            const key = identityKey(
                symbol.file_path,
                symbol.name,
                symbol.line
            );

            if (!symbolIndex.has(key)) symbolIndex.set(key, []);
            symbolIndex.get(key).push(symbol);
        }

        const fileNodeByPath = new Map(
            files.map(file => [normalize(file.file_path), file])
        );

        const nodes = [];
        const byLocation = new Map();
        const byName = new Map();
        const parsedFiles = [];
        let unsupportedFiles = 0;
        let syntaxErrorFiles = 0;
        let declarationCount = 0;
        let indexedSymbolMatches = 0;

        function addToMap(map, key, value) {
            if (!map.has(key)) map.set(key, []);
            map.get(key).push(value);
        }

        function languageFor(filePath) {
            const ext = path.posix.extname(filePath).toLowerCase();

            if (ext === '.py') return 'python';
            if (ext === '.ts' || ext === '.tsx') return 'typescript';

            if (['.js', '.mjs', '.cjs', '.jsx'].includes(ext)) {
                return 'javascript';
            }

            return null;
        }

        for (const file of files) {
            const language = languageFor(file.file_path);

            if (!language) {
                unsupportedFiles++;
                continue;
            }

            const result = extractLocalCalls(
                String(file.content),
                language
            );

            if (result.unsupportedLanguage) {
                unsupportedFiles++;
                continue;
            }

            if (result.hasSyntaxErrors) syntaxErrorFiles++;

            const parsed = { file, result, declarations: [] };
            parsedFiles.push(parsed);

            for (const declaration of result.declarations) {
                const indexMatches = symbolIndex.get(
                    identityKey(
                        file.file_path,
                        declaration.name,
                        declaration.line
                    )
                ) || [];

                const indexedNodeId = indexMatches.length === 1
                    ? Number(indexMatches[0].id)
                    : null;

                if (indexedNodeId !== null) indexedSymbolMatches++;

                const nodeLabel = declaration.isAnonymous
                    ? `anonymous callback (${declaration.line}:${declaration.column})`
                    : `${declaration.name} (${declaration.line})`;

                const nodeTitle =
                    `${file.file_path}:${declaration.line}-${declaration.endLine} | ` +
                    `${declaration.kind}` +
                    (declaration.isAnonymous ? ' | anonymous callback' : '') +
                    ' | static candidate analysis';

                const node = {
                    id: `fn:${encodeURIComponent(file.file_path)}:${declaration.line}:${encodeURIComponent(declaration.name)}`,
                    label: nodeLabel,
                    title: nodeTitle,
                    group: declaration.kind,
                    functionName: declaration.name,
                    displayName: declaration.isAnonymous ? 'anonymous callback' : declaration.name,
                    isAnonymous: Boolean(declaration.isAnonymous),
                    declarationKind: declaration.kind,
                    filePath: file.file_path,
                    line: declaration.line,
                    endLine: declaration.endLine,
                    column: declaration.column,
                    indexedNodeId,
                    fileNodeId: Number(file.id)
                };

                nodes.push(node);
                parsed.declarations.push({ declaration, node });

                addToMap(
                    byLocation,
                    identityKey(
                        file.file_path,
                        declaration.name,
                        declaration.line
                    ),
                    { declaration, node, file }
                );

                if (!declaration.isAnonymous) {
                    addToMap(
                        byName,
                        nameKey(file.file_path, declaration.name),
                        { declaration, node, file }
                    );
                }
            }

            declarationCount += result.declarations.length;
        }

        const edgeByPair = new Map();
        const unresolvedCalls = [];

        let directIdentifierCallRecords = 0;
        let candidateCallRecords = 0;
        let ambiguousNameCalls = 0;
        let unresolvedNameCalls = 0;
        let callsWithoutNamedCaller = 0;
        let callsFromAnonymousFunctions = 0;

        for (const parsed of parsedFiles) {
            const { file, result } = parsed;

            for (const call of result.calls) {
                directIdentifierCallRecords++;

                const callerRecords = (
                    call.caller && Number.isInteger(call.callerLine)
                )
                    ? (byLocation.get(identityKey(
                        file.file_path,
                        call.caller,
                        call.callerLine
                    )) || [])
                    : [];

                const calleeRecords = Number.isInteger(call.targetLine)
                    ? (byLocation.get(identityKey(
                        file.file_path,
                        call.callee,
                        call.targetLine
                    )) || [])
                    : (byName.get(
                        nameKey(file.file_path, call.callee)
                    ) || []);

                if (
                    callerRecords.length === 1 &&
                    callerRecords[0].node.isAnonymous
                ) {
                    callsFromAnonymousFunctions++;
                }

                if (!call.caller || !Number.isInteger(call.callerLine)) {
                    callsWithoutNamedCaller++;
                }

                if (call.resolution === 'ambiguous_name') {
                    ambiguousNameCalls++;
                }

                if (call.resolution === 'unresolved_name') {
                    unresolvedNameCalls++;
                }

                let reason = null;
                let callerRecord = null;
                let calleeRecord = null;

                if (!call.caller || !Number.isInteger(call.callerLine)) {
                    reason = 'no_named_caller';
                } else if (callerRecords.length !== 1) {
                    reason = 'caller_declaration_not_unique';
                } else if (call.resolution === 'ambiguous_name') {
                    reason = 'ambiguous_callee_name';
                } else if (
                    call.resolution !== 'unique_name_candidate' ||
                    calleeRecords.length !== 1
                ) {
                    reason = 'unresolved_or_out_of_scope_target';
                } else {
                    callerRecord = callerRecords[0];
                    calleeRecord = calleeRecords[0];
                }

                if (reason) {
                    if (unresolvedCalls.length < 100) {
                        unresolvedCalls.push({
                            filePath: file.file_path,
                            fileNodeId: Number(file.id),
                            caller: call.caller,
                            callerLine: call.callerLine,
                            callerIsAnonymous: callerRecords.length === 1
                                ? Boolean(callerRecords[0].node.isAnonymous)
                                : false,
                            callerLabel: callerRecords.length === 1
                                ? callerRecords[0].node.label
                                : call.caller,
                            callerIndexedNodeId: callerRecords.length === 1
                                ? callerRecords[0].node.indexedNodeId
                                : null,
                            callee: call.callee,
                            callLine: call.line,
                            resolution: call.resolution,
                            reason
                        });
                    }

                    continue;
                }

                // These are same-file unique-name candidates, not proof
                // of runtime identity, type-aware resolution, or binding.
                const key = `${callerRecord.node.id}->${calleeRecord.node.id}`;

                if (!edgeByPair.has(key)) {
                    edgeByPair.set(key, {
                        from: callerRecord.node.id,
                        to: calleeRecord.node.id,
                        arrows: 'to',
                        color: '#f59e0b',
                        dashes: true,
                        callCount: 0,
                        callSites: []
                    });
                }

                const edge = edgeByPair.get(key);
                edge.callCount++;
                edge.callSites.push(call.line);
                candidateCallRecords++;
            }
        }

        const edges = [...edgeByPair.values()].map(edge => ({
            ...edge,
            label: `candidate ×${edge.callCount}`,
            value: Math.max(1, edge.callCount),
            title:
                'Static same-file unique-name candidate; not confirmed by runtime or type-aware analysis. ' +
                `Call-site lines: ${edge.callSites.slice(0, 40).join(', ')}` +
                (edge.callSites.length > 40 ? ', …' : '')
        }));

        const meta = {
            indexedFiles: files.length,
            parsedFiles: parsedFiles.length,
            unsupportedFiles,
            syntaxErrorFiles,
            declarationCount,
            anonymousFunctionCount: nodes.filter(node => node.isAnonymous).length,
            indexedSymbolMatches,
            directIdentifierCallRecords,
            candidateCallRecords,
            candidateEdges: edges.length,
            ambiguousNameCalls,
            unresolvedNameCalls,
            callsWithoutNamedCaller,
            callsFromAnonymousFunctions,
            unresolvedCallRecords:
                directIdentifierCallRecords - candidateCallRecords,
            unresolvedSamplesReturned: unresolvedCalls.length,
            unresolvedSamplesTruncated:
                directIdentifierCallRecords - candidateCallRecords >
                unresolvedCalls.length,
            resolutionScope:
                'Same-file direct identifier calls; JavaScript/TypeScript use the nearest visible lexical binding scope, while Python retains same-file name matching.',
            limitations:
                'No cross-file binding/import resolution, member-call resolution, dynamic dispatch, alias resolution, or runtime/type verification. TypeScript currently uses the configured JavaScript grammar.'
        };

        res.json({
            success: true,
            nodes,
            edges,
            unresolvedCalls,
            meta
        });
    } catch (error) {
        console.error('Call graph endpoint failed:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to build the function call graph.'
        });
    }
});
app.get('/api/export', (req, res) => {
    try {
        const format = String(req.query.format || 'json').toLowerCase();
        if (!['json', 'md', 'handoff'].includes(format)) {
            return res.status(400).json({
                success: false,
                error: 'Unsupported export format. Use json, md, or handoff.'
            });
        }
        const projectRoot = __dirname;
        const projectName = path.basename(projectRoot).replace(/[^a-zA-Z0-9._-]/g, '_');
        
        if (format === 'json') {
            const { buildContextPackage } = require('./handoff-package');
            const contextPackage = buildContextPackage({
                projectRoot,
                db,
                projectName
            });

            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.setHeader(
                'Content-Disposition',
                `attachment; filename=${projectName}-context-package.json`
            );

            return res.json(contextPackage);
        }
        if (format === 'handoff' || format === 'md') {
            const { generateHandoff } = require('./handoff-generator');
            const docContext = generateHandoff({
                projectRoot: __dirname,
                db,
                projectName
            });

            res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
            res.setHeader(
                'Content-Disposition',
                `attachment; filename=${projectName}-handoff.md`
            );

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
