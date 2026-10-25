'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { TextDecoder } = require('util');

const IGNORED_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', '.cortex',
  'coverage', '.next', '.venv', 'venv', '__pycache__', 'backups'
]);

const SOURCE_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py'
]);

const TASK_EXTENSIONS = new Set([
  ...SOURCE_EXTENSIONS,
  '.html', '.css', '.scss', '.json', '.md', '.txt',
  '.ps1', '.cmd', '.bat', '.sh', '.yml', '.yaml', '.toml'
]);

const MAX_SOURCE_BYTES = 1024 * 1024;

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\/+/, '');
}

function markdownInline(value) {
  return String(value ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/`/g, '\\`')
    .replace(/\|/g, '\\|')
    .trim();
}

function englishValue(value, fallback) {
  const text = String(value || '').trim();
  if (!text) return fallback;
  if (/[^\x09\x0A\x0D\x20-\x7E]/.test(text)) {
    return fallback;
  }
  return text;
}

function hashBytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function collectFiles(root, extensions, scannerRules) {
  const result = [];

  function walk(directory) {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;

      const fullPath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) walk(fullPath);
        continue;
      }

      if (!entry.isFile()) continue;

      if (scannerRules && (
        /(?:\.backup-|\.failed-)/i.test(entry.name) ||
        /^\.cortex-candidate-/i.test(entry.name)
      )) {
        continue;
      }

      if (!extensions.has(path.extname(entry.name).toLowerCase())) {
        continue;
      }

      const stat = fs.statSync(fullPath);
      if (stat.size > MAX_SOURCE_BYTES) continue;

      result.push({
        fullPath,
        relativePath: normalizePath(path.relative(root, fullPath))
      });
    }
  }

  walk(root);
  return result.sort((a, b) =>
    a.relativePath.localeCompare(b.relativePath)
  );
}

function extractTaskMarkers(filePath, source) {
  const tasks = [];
  const warnings = [];
  const lines = String(source).split(/\r?\n/);

  // Only explicit task markers in comment-leading lines are actionable.
  // This deliberately excludes headings such as "TODOs + FIXMEs".
  const markerPattern =
    /^\s*(?:\/\/+|\/\*+|\*+|#+|<!--|--)\s*(TODO|FIXME|XXX|HACK)\b\s*[:\-]\s*(.*?)\s*(?:\*\/|-->)?\s*$/i;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const lineNumber = index + 1;
    const match = line.match(markerPattern);

    if (!match) continue;

    const marker = match[1].toUpperCase();
    const description = String(match[2] || '').trim();
    const questionCount = (description.match(/\?/g) || []).length;
    const questionRatio = questionCount / Math.max(1, description.length);
    const residual = description
      .replace(/\?+/g, '')
      .replace(/[\s\W_]/g, '');

    const corrupted =
      description.length === 0 ||
      (/\?{3,}/.test(description) &&
        (questionRatio >= 0.15 || residual.length < 8));

    if (corrupted) {
      warnings.push({
        file: filePath,
        line: lineNumber,
        marker,
        reason: 'Task marker has empty or unreadable placeholder text; it was excluded from actionable tasks.'
      });
      continue;
    }

    if (/[^\x09\x0A\x0D\x20-\x7E]/.test(description)) {
      warnings.push({
        file: filePath,
        line: lineNumber,
        marker,
        reason: 'Non-ASCII task text was omitted to keep this handoff in English; review the source line.'
      });
      continue;
    }

    tasks.push({
      file: filePath,
      line: lineNumber,
      marker,
      description
    });
  }

  return { tasks, warnings };
}

function inspectTextQuality(filePath, source) {
  const warnings = [];
  const lines = String(source).split(/\r?\n/);

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const lineNumber = index + 1;

    if (line.includes('\uFFFD')) {
      warnings.push({
        file: filePath,
        line: lineNumber,
        reason: 'Unicode replacement character detected; inspect the original bytes.'
      });
    }

    // Detect visible question-mark placeholders without copying the
    // potentially corrupted text into the report.
    if (/\?{3,}/.test(line)) {
      warnings.push({
        file: filePath,
        line: lineNumber,
        reason: 'Repeated question-mark placeholder detected; original wording is not recoverable from this line alone.'
      });
    }
  }

  return warnings;
}

function inspectSourceIndex(projectRoot, db) {
  const expected = collectFiles(projectRoot, SOURCE_EXTENSIONS, true);
  const indexed = db.prepare(`
    SELECT id, file_path
    FROM nodes
    WHERE kind = 'file'
    ORDER BY file_path, id
  `).all();

  const expectedByPath = new Map(
    expected.map(file => [normalizePath(file.relativePath).toLowerCase(), file])
  );

  const indexedByPath = new Map();

  for (const row of indexed) {
    const key = normalizePath(row.file_path).toLowerCase();
    if (!indexedByPath.has(key)) indexedByPath.set(key, []);
    indexedByPath.get(key).push(row);
  }

  const missingFromIndex = [];
  const missingOnDisk = [];
  const contentDrift = [];
  const duplicateIndexedPaths = [];

  for (const file of expected) {
    const key = normalizePath(file.relativePath).toLowerCase();
    const rows = indexedByPath.get(key) || [];

    if (rows.length === 0) {
      missingFromIndex.push(file.relativePath);
      continue;
    }

    if (rows.length > 1) {
      duplicateIndexedPaths.push(file.relativePath);
    }

    const indexedContent = db.prepare(`
      SELECT content
      FROM nodes
      WHERE id = ?
    `).get(rows[0].id);

    const diskBytes = fs.readFileSync(file.fullPath);
    const indexedBytes = Buffer.from(
      String(indexedContent?.content ?? ''), 'utf8'
    );

    if (!diskBytes.equals(indexedBytes)) {
      contentDrift.push({
        file: file.relativePath,
        diskBytes: diskBytes.length,
        indexedBytes: indexedBytes.length,
        diskSha256: hashBytes(diskBytes),
        indexedSha256: hashBytes(indexedBytes)
      });
    }
  }

  for (const [key, rows] of indexedByPath) {
    if (!expectedByPath.has(key)) {
      for (const row of rows) missingOnDisk.push(row.file_path);
    }
  }

  let metadata = null;

  try {
    metadata = db.prepare(
      'SELECT * FROM index_metadata WHERE id = 1'
    ).get() ?? null;
  } catch {
    metadata = null;
  }

  const counts = {
    indexedFileRows: indexed.length,
    indexedFiles: indexedByPath.size,
    indexedSymbols: db.prepare(
      "SELECT COUNT(*) AS n FROM nodes WHERE kind <> 'file'"
    ).get().n,
    indexedEdges: db.prepare(
      'SELECT COUNT(*) AS n FROM edges'
    ).get().n,
    expectedDiskFiles: expected.length
  };

  let metadataMatches = false;

  if (metadata) {
    metadataMatches =
      path.resolve(metadata.root_path) === path.resolve(projectRoot) &&
      metadata.files === counts.indexedFileRows &&
      metadata.symbols === counts.indexedSymbols &&
      metadata.imports === counts.indexedEdges;
  }

  const fresh =
    missingFromIndex.length === 0 &&
    missingOnDisk.length === 0 &&
    contentDrift.length === 0 &&
    duplicateIndexedPaths.length === 0 &&
    metadataMatches;

  return {
    status: fresh ? 'FRESH' : 'STALE',
    metadata,
    counts,
    missingFromIndex,
    missingOnDisk,
    contentDrift,
    duplicateIndexedPaths,
    metadataMatches
  };
}

function generateHandoff({ projectRoot, db, projectName }) {
  const root = path.resolve(projectRoot);
  const generatedAt = new Date().toISOString();
  const pkgPath = path.join(root, 'package.json');

  let pkg = {};
  let packageWarning = null;

  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch {
    packageWarning = 'package.json is missing or invalid.';
  }

  const sourceFiles = collectFiles(root, SOURCE_EXTENSIONS, true);
  const taskFiles = collectFiles(root, TASK_EXTENSIONS, false);
  const indexAudit = inspectSourceIndex(root, db);

  const actionableTasks = [];
  const taskWarnings = [];
  const textQualityWarnings = [];
  const decodeWarnings = [];

  const decoder = new TextDecoder('utf-8', { fatal: true });

  for (const file of taskFiles) {
    const bytes = fs.readFileSync(file.fullPath);
    let source;

    try {
      source = decoder.decode(bytes);
    } catch {
      decodeWarnings.push({
        file: file.relativePath,
        line: 1,
        reason: 'File is not valid UTF-8; task extraction was skipped for this file.'
      });
      continue;
    }

    const taskResult = extractTaskMarkers(file.relativePath, source);
    actionableTasks.push(...taskResult.tasks);
    taskWarnings.push(...taskResult.warnings);
    textQualityWarnings.push(...inspectTextQuality(file.relativePath, source));
  }

  const uniqueWarnings = new Map();

  for (const warning of [...taskWarnings, ...textQualityWarnings, ...decodeWarnings]) {
    const key = `${warning.file}:${warning.line}:${warning.reason}`;
    uniqueWarnings.set(key, warning);
  }

  const warnings = [...uniqueWarnings.values()]
    .sort((a, b) =>
      a.file.localeCompare(b.file) || a.line - b.line
    );

  const serverPath = path.join(root, 'server.js');
  const serverSource = fs.existsSync(serverPath)
    ? fs.readFileSync(serverPath, 'utf8')
    : '';

  const routes = [];
  const routePattern = /\bapp\.(get|post|put|patch|delete)\s*\(\s*(['"])([^'"]+)\2/g;

  for (const match of serverSource.matchAll(routePattern)) {
    routes.push(`${match[1].toUpperCase()} ${match[3]}`);
  }

  const quarantineDir = path.join(root, '.cortex', 'quarantine');
  const quarantinedFiles = fs.existsSync(quarantineDir)
    ? fs.readdirSync(quarantineDir, { withFileTypes: true })
        .filter(entry => entry.isFile())
        .map(entry => entry.name)
        .sort()
    : [];

  const scripts = pkg.scripts || {};
  const lines = [];

  const add = value => lines.push(String(value));

  add(`# ${englishValue(projectName, 'Cortex Brain')} — Engineering Handoff`);
  add('');
  add(`Generated at (UTC): ${generatedAt}`);
  add(`Project root: \`${root}\``);
  add('Document language: English.');
  add('');
  add('> This handoff is generated from the current working tree and SQLite index. It is not a release sign-off, does not run tests, and does not claim runtime behavior merely because source code exists.');
  add('');
  add('## 1. Product Mission and Strategic Direction');
  add('');
  add('Cortex Brain is being developed as a code-intelligence and software-assurance platform. Its intended direction is to help engineers and AI agents inspect repositories, understand code structure and dependencies, assess risks, and verify changes with traceable evidence.');
  add('');
  add('This is the product direction, not a claim that every capability is implemented, comprehensive, or production-ready.');
  add('');
  add('## 2. Project Snapshot');
  add('');
  add(`- Package: \`${markdownInline(pkg.name || projectName)}\``);
  add(`- Version: \`${markdownInline(pkg.version || 'not declared')}\``);
  add(`- Description: ${englishValue(pkg.description, 'No English description available; inspect package.json.')}`);
  add(`- Module system: \`${markdownInline(pkg.type || 'Node.js default')}\``);
  add(`- Main entry: \`${markdownInline(pkg.main || 'not declared')}\``);
  add(`- Runtime used to generate this report: \`${process.version}\``);
  add(`- Source files eligible for indexing: ${sourceFiles.length}`);
  add('');

  if (packageWarning) {
    add(`- Configuration warning: ${packageWarning}`);
    add('');
  }

  add('## 3. Canonical Commands');
  add('');
  add('| Command | Configured action |');
  add('|---|---|');

  for (const [name, command] of Object.entries(scripts).sort(([a], [b]) => a.localeCompare(b))) {
    add(`| \`npm run ${markdownInline(name)}\` | \`${markdownInline(command)}\` |`);
  }

  if (scripts.test) {
    add('');
    add('Run the complete configured test suite before a release:');
    add('');
    add('```powershell');
    add('npm test');
    add('```');
  }

  if (scripts.scan === 'node scanner.js') {
    add('');
    add('Canonical index command: `npm run scan`, which invokes `node scanner.js`.');
    add('Do not execute quarantined legacy scanners.');
  }

  add('');
  add('## 4. Architecture and Key Files');
  add('');
  add('| File | Responsibility | Evidence status |');
  add('|---|---|---|');

  const components = [
    ['server.js', 'Express HTTP API, export endpoints, and graph endpoints.'],
    ['scanner.js', 'Canonical JavaScript-based project index builder.'],
    ['parser.js', 'Tree-sitter-backed source parsing and symbol extraction.'],
    ['db.js', 'SQLite connection, schema creation, and database configuration.'],
    ['call-graph.js', 'Static extraction of direct identifier call candidates.'],
    ['handoff-generator.js', 'English engineering handoff generation and source/index audit.'],
    ['public/index.html', 'Browser interface and graph/code-viewer interactions.'],
    ['mcp-server.mjs', 'Model Context Protocol server entry, if present.'],
    ['tests/', 'Automated tests and test fixtures.']
  ];

  for (const [relativePath, purpose] of components) {
    const fullPath = path.join(root, relativePath);
    const present = fs.existsSync(fullPath);
    if (!present) continue;

    add(`| \`${relativePath}\` | ${purpose} | Present on disk; runtime completeness is not implied. |`);
  }

  add('');
  add('### HTTP Routes Detected in Source');
  add('');
  add('The following routes were detected by inspecting `server.js`. Presence in source does not prove that the currently running server has loaded or passed them.');
  add('');

  if (routes.length === 0) {
    add('- No Express routes were detected by the current source inspection.');
  } else {
    for (const route of [...new Set(routes)].sort()) {
      add(`- \`${route}\``);
    }
  }

  add('');
  add('## 5. Source and Index Consistency');
  add('');
  add(`- Index status: **${indexAudit.status}**`);
  add(`- Index metadata timestamp: \`${indexAudit.metadata?.indexed_at || 'unavailable'}\``);
  add(`- Metadata root matches current project root: ${indexAudit.metadataMatches ? 'YES' : 'NO'}`);
  add(`- Expected disk source files: ${indexAudit.counts.expectedDiskFiles}`);
  add(`- Indexed file records: ${indexAudit.counts.indexedFileRows}`);
  add(`- Indexed symbols: ${indexAudit.counts.indexedSymbols}`);
  add(`- Indexed dependency records: ${indexAudit.counts.indexedEdges}`);
  add(`- Files missing from index: ${indexAudit.missingFromIndex.length}`);
  add(`- Indexed paths missing from disk: ${indexAudit.missingOnDisk.length}`);
  add(`- Files whose disk bytes differ from indexed content: ${indexAudit.contentDrift.length}`);
  add(`- Duplicate indexed paths: ${indexAudit.duplicateIndexedPaths.length}`);
  add('');

  if (indexAudit.status === 'STALE') {
    add('**Required action:** Do not treat indexed symbol bodies, search results, or graph data as a reliable snapshot of the current working tree. Preserve a verified SQLite backup, run `npm run scan`, and regenerate this handoff.');
    add('');
  } else {
    add('The indexed source file set and stored file contents matched the current disk snapshot during generation. This does not prove that every analyzer result is semantically correct.');
    add('');
  }

  for (const [label, values] of [
    ['Files missing from index', indexAudit.missingFromIndex],
    ['Indexed paths missing from disk', indexAudit.missingOnDisk],
    ['Duplicate indexed paths', indexAudit.duplicateIndexedPaths]
  ]) {
    if (values.length > 0) {
      add(`### ${label}`);
      add('');
      for (const value of values.slice(0, 50)) add(`- \`${markdownInline(value)}\``);
      if (values.length > 50) add(`- Additional entries omitted: ${values.length - 50}`);
      add('');
    }
  }

  if (indexAudit.contentDrift.length > 0) {
    add('### Source Content Drift');
    add('');
    for (const entry of indexAudit.contentDrift.slice(0, 50)) {
      add(`- \`${markdownInline(entry.file)}\`: disk SHA-256 \`${entry.diskSha256}\`; indexed SHA-256 \`${entry.indexedSha256}\`.`);
    }
    if (indexAudit.contentDrift.length > 50) {
      add(`- Additional drift entries omitted: ${indexAudit.contentDrift.length - 50}`);
    }
    add('');
  }

  add('## 6. Actionable Source Tasks');
  add('');
  add('Tasks are extracted from explicit comment-leading markers such as `TODO:`, `FIXME:`, `XXX:`, and `HACK:` in the current working tree. Generic prose mentioning TODOs is not treated as a task.');
  add('');

  actionableTasks.sort((a, b) =>
    a.file.localeCompare(b.file) || a.line - b.line
  );

  add(`Actionable task markers detected: ${actionableTasks.length}`);
  add(`Unreadable or non-English task markers excluded: ${taskWarnings.length}`);
  add('');

  if (actionableTasks.length === 0) {
    add('No actionable markers were detected by this rule. This does not prove that the project has no outstanding work.');
    add('');
  } else {
    for (const task of actionableTasks.slice(0, 100)) {
      add(`- [ ] \`${markdownInline(task.file)}:${task.line}\` — **${task.marker}:** ${markdownInline(task.description)}`);
    }

    if (actionableTasks.length > 100) {
      add(`- Additional actionable markers omitted: ${actionableTasks.length - 100}`);
    }
    add('');
  }

  add('## 7. Source Text and Encoding Warnings');
  add('');

  if (warnings.length === 0) {
    add('No suspicious repeated-question-mark placeholders, Unicode replacement characters, invalid UTF-8 files, or excluded unreadable task markers were detected by these checks.');
    add('');
  } else {
    add(`Warnings detected: ${warnings.length}.`);
    add('');

    for (const warning of warnings.slice(0, 100)) {
      add(`- \`${markdownInline(warning.file)}:${warning.line}\` — ${warning.reason}`);
    }

    if (warnings.length > 100) {
      add(`- Additional warnings omitted: ${warnings.length - 100}`);
    }

    add('');
    add('Unreadable original wording must not be reconstructed by guesswork. Recover it from trusted version history or explicitly replace it with a reviewed English requirement.');
    add('');
  }

  add('## 8. Verified Facts, Limits, and Non-Claims');
  add('');
  add('- The handoff generator checks source/index consistency but does not run the test suite.');
  add('- Static source presence is not proof that a live endpoint or browser interaction works.');
  add('- The file dependency graph resolves only supported relative imports under its current resolution policy. Non-relative imports are not automatically classified as external packages.');
  add('- The current call graph is based on static same-file direct-identifier candidates. It does not prove runtime call identity and does not resolve member calls, dynamic dispatch, aliases, or cross-file bindings.');
  add('- The security endpoint is heuristic/pattern-based. Zero findings must not be interpreted as proof that the codebase has no vulnerabilities.');
  add('- Dead-code results are candidates and must not be used for automatic deletion without deeper validation.');
  add('- Source TODOs are not a complete product roadmap; roadmap priorities below are explicit engineering priorities, not claims inferred from comments.');
  add('');

  add('## 9. Quarantined Legacy Tools');
  add('');
  add('Do not execute quarantined legacy scanners. Previously reviewed legacy scanner code contained a call capable of unlinking `cortex-brain.db` from its working directory. Do not execute quarantined legacy tools.');
  add('');

  if (quarantinedFiles.length === 0) {
    add('No regular files were detected in `.cortex/quarantine` during this generation.');
  } else {
    for (const filename of quarantinedFiles) {
      add(`- \`.cortex/quarantine/${markdownInline(filename)}\``);
    }
  }

  add('');
  add('## 10. Execution Roadmap');
  add('');
  add('### P0 — Establish a trustworthy working baseline');
  add('');

  if (indexAudit.status === 'STALE') {
    add('1. Create and verify a fresh SQLite backup.');
    add('2. Run `npm run scan` using the canonical `scanner.js` only.');
    add('3. Regenerate Handoff and require `Index status: FRESH` before trusting indexed source context.');
  } else {
    add('1. Preserve the current verified source/index baseline and keep this consistency audit in the handoff workflow.');
  }

  add('4. Run `npm test` and record the exact result; do not infer a pass from source presence.');
  add('5. Restart the server after backend source changes and smoke-test `/api/graph`, `/api/call-graph`, and all export formats against the live process.');
  add('');

  add('### P1 — Make static analysis reviewable');
  add('');
  add('1. Verify function-call graph API behavior and browser interactions against real indexed functions.');
  add('2. Keep candidate, ambiguous, unresolved, and confirmed relationships as distinct statuses.');
  add('3. Add fixtures for duplicate names, nested declarations, recursion, member calls, dynamic calls, and cross-file imports before expanding resolution claims.');
  add('4. Make security detector findings evidence-based, reproducible, and validated against positive and negative fixtures.');
  add('');

  add('### P2 — Prepare for a commercial product');
  add('');
  add('1. Establish a repeatable clean-install and upgrade path.');
  add('2. Document supported languages, resolution boundaries, privacy/data handling, and known false positives.');
  add('3. Add release checks, dependency/licence review, threat modeling, and rollback procedures.');
  add('4. Validate a costly customer problem with real users and measure detection accuracy, time saved, and retention before making market or valuation claims.');
  add('');

  add('## 11. Required Verification Before Handoff Acceptance');
  add('');
  add('- [ ] `npm test` completed successfully in the current working tree.');
  add('- [ ] A verified database backup exists before any reindex or migration.');
  add('- [ ] `Index status` is `FRESH`, or the stale state is explicitly accepted with a documented reason.');
  add('- [ ] The running server was restarted after the latest backend modifications.');
  add('- [ ] Live export tests passed for JSON, Markdown, and invalid formats.');
  add('- [ ] The function-call API and browser node-to-source interaction were tested in the current build.');
  add('- [ ] No unreadable TODO is presented as an actionable requirement.');
  add('');

  add('## 12. Instructions to the Next Developer or AI Agent');
  add('');
  add('1. Read this handoff and the current `package.json`, `db.js`, `scanner.js`, `parser.js`, `server.js`, `call-graph.js`, and relevant tests.');
  add('2. Treat every status as evidence-scoped. Source presence is not runtime verification; a heuristic candidate is not a confirmed finding.');
  add('3. Never execute quarantined tools. Use the canonical scan command only, and preserve a verified database backup first.');
  add('4. Resolve any stale source/index state before relying on indexed code content.');
  add('5. Run the existing tests, add regression coverage for the specific behavior changed, and record exact pass/fail output.');
  add('6. Continue with the highest-priority unchecked item above. Do not rewrite working modules without an evidenced reason.');
  add('');

  add('---');
  add(`Report fingerprint: SHA-256 of this report is computed by the receiving workflow, not embedded here. Generated at ${generatedAt}.`);

  return lines.join('\n') + '\n';
}

module.exports = {
  generateHandoff,
  extractTaskMarkers,
  inspectTextQuality,
  inspectSourceIndex
};