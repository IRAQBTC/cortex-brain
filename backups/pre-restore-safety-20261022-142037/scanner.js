
'use strict';

const { extractLocalCalls } = require("./call-graph");

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const parser = require('./parser');

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.cortex',
  'coverage',
  '.next',
  '.venv',
  'venv',
  '__pycache__',
  'backups'
]);

const SUPPORTED_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.jsx',
  '.ts', '.tsx', '.py'
]);

const MAX_FILE_SIZE = 1024 * 1024;

function hashContent(content) {
  return crypto
    .createHash('sha256')
    .update(content, 'utf8')
    .digest('hex');
}

function toDbPath(value) {
  return value.split(path.sep).join('/');
}

function shouldIgnoreDirectory(name) {
  return IGNORED_DIRS.has(name);
}

function collectFiles(root) {
  const files = [];

  function walk(directory) {
    const entries = fs.readdirSync(directory, {
      withFileTypes: true
    });

    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        continue;
      }

      const fullPath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        if (!shouldIgnoreDirectory(entry.name)) {
          walk(fullPath);
        }
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      // Exclude saved backup and failed-artifact files from source indexing.
      if (/(?:\.backup-|\.failed-)/i.test(entry.name) || /^\.cortex-candidate-/i.test(entry.name)) {
        continue;
      }

      if (!SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        continue;
      }

      const stat = fs.statSync(fullPath);

      if (stat.size > MAX_FILE_SIZE) {
        console.warn(`[SKIP] File exceeds 1 MB: ${fullPath}`);
        continue;
      }

      files.push(fullPath);
    }
  }

  walk(root);
  return files.sort();
}

function extractImports(source, language) {
  const imports = new Set();

  const supportedLanguages = new Set([
    'javascript',
    'typescript',
    'python'
  ]);

  if (!supportedLanguages.has(language)) {
    return [];
  }

  // Reuse parser instances between files.
  const cache = extractImports._parserCache ||
    (extractImports._parserCache = new Map());

  let parser = cache.get(language);

  if (!parser) {
    const TreeSitter = require('tree-sitter');
    const grammar = language === 'python'
      ? require('tree-sitter-python')
      : require('tree-sitter-javascript');

    parser = new TreeSitter();
    parser.setLanguage(grammar);
    cache.set(language, parser);
  }

  const sourceText = String(source);
  const sourceBytes = Buffer.byteLength(sourceText, 'utf8');
  let bufferSize = 32768;

  while (bufferSize <= sourceBytes) {
    bufferSize *= 2;
  }

  const tree = sourceBytes < 32768
    ? parser.parse(sourceText)
    : parser.parse(sourceText, null, { bufferSize });

  function stringValue(node) {
    if (!node) return null;

    if (node.type === 'string') {
      const fragment = node.namedChildren.find(
        child => child.type === 'string_fragment'
      );

      if (fragment) return fragment.text;

      // Empty string literal.
      return '';
    }

    if (node.type === 'template_string') {
      // Accept only static templates; reject interpolated templates.
      if (node.namedChildren.some(
        child => child.type === 'template_substitution'
      )) {
        return null;
      }

      const fragment = node.namedChildren.find(
        child => child.type === 'string_fragment'
      );

      return fragment ? fragment.text : '';
    }

    return null;
  }

  function addSpecifier(value) {
    if (typeof value === 'string' && value.length > 0) {
      imports.add(value);
    }
  }

  function visit(node) {
    if (language === 'python') {
      if (node.type === 'import_statement') {
        for (const child of node.namedChildren) {
          if (child.type === 'dotted_name') {
            addSpecifier(child.text);
          } else if (child.type === 'aliased_import') {
            const module = child.namedChildren.find(
              item => item.type === 'dotted_name'
            );

            if (module) addSpecifier(module.text);
          }
        }
      } else if (node.type === 'import_from_statement') {
        const module = node.childForFieldName('module_name');

        if (module) {
          // Preserve relative prefixes such as .helpers and ..core.engine.
          addSpecifier(module.text);
        }
      }
    } else {
      if (
        node.type === 'import_statement' ||
        node.type === 'export_statement'
      ) {
        addSpecifier(
          stringValue(node.childForFieldName('source'))
        );
      }

      if (node.type === 'call_expression') {
        const fn = node.childForFieldName('function');
        const isRequire = fn &&
          fn.type === 'identifier' &&
          fn.text === 'require';
        const isDynamicImport = fn && fn.type === 'import';

        if (isRequire || isDynamicImport) {
          const args = node.childForFieldName('arguments');

          if (args) {
            const argument = args.namedChildren[0];
            addSpecifier(stringValue(argument));
          }
        }
      }
    }

    for (let i = 0; i < node.childCount; i++) {
      visit(node.child(i));
    }
  }

  visit(tree.rootNode);
  return [...imports];
}

function prepareFile(root, absolutePath) {
  const source = fs.readFileSync(absolutePath, 'utf8');
  const language = parser.detectLanguage(absolutePath);

  if (!language) {
    return null;
  }

  const relativePath = toDbPath(
    path.relative(root, absolutePath)
  );

  // Detailed parsing is additive: keep symbols and imports indexed
  // even when Tree-sitter reports recoverable syntax errors.
  const parseResult = typeof parser.parseCodeDetailed === 'function'
    ? parser.parseCodeDetailed(source, language)
    : { symbols: parser.parseCode(source, language), hasErrors: false, diagnostics: [] };

  const symbols = parseResult.symbols;
  const imports = extractImports(source, language);
  const syntaxDiagnostics = Array.isArray(parseResult.diagnostics)
    ? parseResult.diagnostics
    : [];

  return {
    absolutePath,
    relativePath,
    source,
    language,
    hash: hashContent(source),
    symbols,
    imports,
    hasSyntaxErrors: Boolean(parseResult.hasErrors),
    syntaxDiagnostics
  };
}

function buildIndex(root, preparedFiles) {
  const insertNode = db.prepare(`
    INSERT INTO nodes (
      file_path, name, kind, content,
      signature, line, jsdoc
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const insertFts = db.prepare(`
    INSERT INTO nodes_fts (
      rowid, name, content, file_path
    )
    VALUES (?, ?, ?, ?)
  `);

  const insertCallEdge = db.prepare(`
  INSERT INTO call_edges (
    file_path, caller_name, caller_line,
    callee_name, call_line, resolution, target_line, analysis_scope
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertEdge = db.prepare(`
    INSERT INTO edges (source, target, kind)
    VALUES (?, ?, ?)
  `);

  const rebuild = db.transaction(() => {
    // All index changes are atomic. A failure rolls them back.
    db.exec(`
      DELETE FROM nodes_fts;
      DELETE FROM call_edges;
    DELETE FROM edges;
      DELETE FROM nodes;
    `);

    let fileCount = 0;
    let symbolCount = 0;
    let edgeCount = 0;

    for (const file of preparedFiles) {
      const fileNode = insertNode.run(
        file.relativePath,
        path.posix.basename(file.relativePath),
        'file',
        file.source,
        null,
        1,
        null
      );

      insertFts.run(
        fileNode.lastInsertRowid,
        path.posix.basename(file.relativePath),
        file.source,
        file.relativePath
      );

      fileCount++;

      for (const symbol of file.symbols) {
        const result = insertNode.run(
          file.relativePath,
          symbol.name,
          symbol.type,
          symbol.code,
          symbol.signature || null,
          symbol.startLine,
          symbol.jsdoc || null
        );

        insertFts.run(
          result.lastInsertRowid,
          symbol.name,
          symbol.code,
          file.relativePath
        );

        symbolCount++;
      }

      for (const target of file.imports) {
        insertEdge.run(
          file.relativePath,
          target,
          'imports'
        );

        edgeCount++;
      }
      
      const callAnalysis = extractLocalCalls(file.source, file.language);

      if (!callAnalysis.unsupportedLanguage) {
        for (const call of callAnalysis.calls) {
          insertCallEdge.run(
            file.relativePath,
            call.caller,
            call.callerLine,
            call.callee,
            call.line,
            call.resolution,
            call.targetLine,
            'same_file_direct_identifier'
          );
        }
      }
    }

    db.prepare(`
      INSERT INTO index_metadata
        (id, root_path, indexed_at, files, symbols, imports)
      VALUES
        (1, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        root_path = excluded.root_path,
        indexed_at = excluded.indexed_at,
        files = excluded.files,
        symbols = excluded.symbols,
        imports = excluded.imports
    `).run(root, new Date().toISOString(), fileCount, symbolCount, edgeCount);

    return {
      files: fileCount,
      symbols: symbolCount,
      imports: edgeCount,
      callSites: db.prepare("SELECT COUNT(*) AS count FROM call_edges").get().count
    };
  });

  return rebuild();
}

function scanDirectory(targetPath) {
  const root = path.resolve(targetPath);

  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`Scan target is not a directory: ${root}`);
  }

  console.log(`[CORTEX] Scan root: ${root}`);
  console.log('[CORTEX] Collecting source files...');

  const filePaths = collectFiles(root);
  const preparedFiles = [];

  // Read and parse before starting the transaction.
  // Read errors abort before the current index is changed.
  for (const filePath of filePaths) {
    const prepared = prepareFile(root, filePath);

    if (prepared) {
      preparedFiles.push(prepared);
    }
  }

  console.log(`[CORTEX] Prepared ${preparedFiles.length} files.`);

  // Report syntax problems before the database transaction starts.
  // Diagnostics do not reject files or alter the indexing policy.
  const filesWithSyntaxErrors = preparedFiles.filter(file => file.hasSyntaxErrors);
  const syntaxDiagnosticCount = preparedFiles.reduce(
    (total, file) => total + file.syntaxDiagnostics.length,
    0
  );

  if (filesWithSyntaxErrors.length > 0) {
    console.warn(`[CORTEX] Syntax warnings: ${filesWithSyntaxErrors.length} file(s), ${syntaxDiagnosticCount} diagnostic(s).`);

    for (const file of filesWithSyntaxErrors) {
      console.warn(`[CORTEX][SYNTAX] ${file.relativePath}`);

      for (const diagnostic of file.syntaxDiagnostics) {
        const location = `line ${diagnostic.startLine}, column ${diagnostic.startColumn}`;
        const excerpt = diagnostic.excerpt ? ` | ${diagnostic.excerpt}` : '';
        console.warn(`  - ${diagnostic.type} at ${location}${excerpt}`);
      }
    }
  } else {
    console.log('[CORTEX] No syntax errors reported by the configured parser.');
  }

  console.log('[CORTEX] Updating index transactionally...');

  const result = buildIndex(root, preparedFiles);

  const integrity = db.pragma('integrity_check');

  if (
    integrity.length !== 1 ||
    integrity[0].integrity_check !== 'ok'
  ) {
    throw new Error(
      `SQLite integrity check failed: ${JSON.stringify(integrity)}`
    );
  }

  console.log('\n========== CORTEX SCAN RESULTS ==========');
  console.log(`Files indexed:   ${result.files}`);
  console.log(`Symbols indexed: ${result.symbols}`);
  console.log(`Import edges:    ${result.imports}`);
  console.log('SQLite integrity: OK');
  console.log('=========================================');

  return result;
}

if (require.main === module) {
  try {
    const target = process.argv[2] || __dirname;
    scanDirectory(target);
  } catch (error) {
    console.error(`[CORTEX SCAN FAILED] ${error.stack || error.message}`);
    process.exitCode = 1;
  } finally {
    db.close();
  }
}

module.exports = {
  scanDirectory,
  collectFiles,
  extractImports
};
