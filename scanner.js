#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const acorn = require('acorn');
const walk = require('acorn-walk');

const CONFIG = {
  targetDir: process.env.SCAN_DIR || process.cwd(),
  dbPath: process.env.CORTEX_DB_PATH || path.join(process.cwd(), 'cortex-brain.db'),
  ignoreDirs: ['node_modules', '.git', 'dist', 'coverage', '.turbo', 'build', '.next'],
  extensions: ['.js', '.jsx', '.ts', '.tsx'],
};

class EnterpriseScanner {
  constructor() {
    this.db = null;
    this.stats = { files: 0, functions: 0, classes: 0, imports: 0, edges: 0 };
  }

  initializeDB() {
    console.log(`🗄️ Initializing Native Graph Database...`);
    this.db = new Database(CONFIG.dbPath);
    this.db.pragma('journal_mode = WAL');

    this.db.exec(`
      DROP TABLE IF EXISTS nodes;
      DROP TABLE IF EXISTS edges;
      
      CREATE TABLE nodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        content TEXT,
        signature TEXT,
        jsdoc TEXT
      );
      
      CREATE TABLE edges (
        source_id INTEGER NOT NULL,
        target_id INTEGER NOT NULL,
        kind TEXT NOT NULL,
        FOREIGN KEY(source_id) REFERENCES nodes(id) ON DELETE CASCADE,
        FOREIGN KEY(target_id) REFERENCES nodes(id) ON DELETE CASCADE
      );
      
      CREATE INDEX idx_node_name ON nodes (name);
      CREATE INDEX idx_node_file ON nodes (file_path);
      CREATE INDEX idx_edge_source ON edges (source_id);
      CREATE INDEX idx_edge_target ON edges (target_id);
    `);

    this.insertNode = this.db.prepare(`
      INSERT INTO nodes (kind, name, file_path, content, signature, jsdoc) 
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    
    this.insertEdge = this.db.prepare(`
      INSERT INTO edges (source_id, target_id, kind) 
      VALUES (?, ?, ?)
    `);
  }

  scanDirectory(dir) {
    console.log(`🔍 Scanning: ${dir}`);
    this._walk(dir);
  }

  _walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!CONFIG.ignoreDirs.includes(entry.name)) this._walk(fullPath);
      } else if (entry.isFile() && CONFIG.extensions.some(ext => entry.name.endsWith(ext))) {
        this._processFile(fullPath);
      }
    }
  }

  _processFile(fullPath) {
    try {
      const relativePath = path.relative(CONFIG.targetDir, fullPath);
      const code = fs.readFileSync(fullPath, 'utf8');
      this.stats.files++;

      const processFileTx = this.db.transaction(() => {
        const fileResult = this.insertNode.run('file', path.basename(fullPath), relativePath, code, null, null);
        const fileId = fileResult.lastInsertRowid;

        // استخدام acorn لتحليل الكود
        const ast = acorn.parse(code, {
          ecmaVersion: 'latest',
          sourceType: 'module',
          locations: true,
        });

        // استخراج الاستيرادات
        this._processImports(ast, fileId, relativePath, code);

        // استخراج الرموز (دوال، كلاسات)
        this._processSymbols(ast, fileId, relativePath, code);
      });

      processFileTx();

    } catch (error) {
      console.warn(`⚠️ Skipping (Parse Error in ${path.relative(CONFIG.targetDir, fullPath)}): ${error.message}`);
    }
  }

  _processImports(ast, fileId, relativePath, fullCode) {
    walk.simple(ast, {
      ImportDeclaration: (node) => {
        const moduleName = node.source.value;
        this.stats.imports++;

        let resolvedPath = moduleName;
        let edgeKind = 'imports_external';

        if (moduleName.startsWith('.') || moduleName.startsWith('/')) {
          edgeKind = 'imports_internal';
          const dirOfCurrentFile = path.dirname(path.join(CONFIG.targetDir, relativePath));
          const possiblePaths = [
            path.join(dirOfCurrentFile, moduleName),
            path.join(dirOfCurrentFile, `${moduleName}.js`),
            path.join(dirOfCurrentFile, `${moduleName}.ts`),
            path.join(dirOfCurrentFile, moduleName, 'index.js'),
            path.join(dirOfCurrentFile, moduleName, 'index.ts')
          ];

          for (const p of possiblePaths) {
            if (fs.existsSync(p)) {
              resolvedPath = path.relative(CONFIG.targetDir, p);
              break;
            }
          }
        }

        const importResult = this.insertNode.run('import', moduleName, relativePath, null, `import '${moduleName}'`, '');
        const importId = importResult.lastInsertRowid;
        this.insertEdge.run(fileId, importId, edgeKind);
        this.stats.edges++;
      },
      CallExpression: (node) => {
        // دعم require
        if (node.callee.name === 'require' && node.arguments[0] && node.arguments[0].type === 'Literal') {
          const moduleName = node.arguments[0].value;
          this.stats.imports++;
          const importResult = this.insertNode.run('import', moduleName, relativePath, null, `require('${moduleName}')`, '');
          const importId = importResult.lastInsertRowid;
          this.insertEdge.run(fileId, importId, 'imports_external');
          this.stats.edges++;
        }
      }
    });
  }

  _processSymbols(ast, fileId, relativePath, fullCode) {
    walk.simple(ast, {
      FunctionDeclaration: (node) => this._insertSymbol(node, 'function', fileId, relativePath, fullCode),
      FunctionExpression: (node) => {
        if (node.id) this._insertSymbol(node, 'function', fileId, relativePath, fullCode, node.id.name);
      },
      ArrowFunctionExpression: (node) => {
        // التقاط الدوال السهمية المخزنة في متغيرات
        const parent = node.parent;
        if (parent && parent.type === 'VariableDeclarator' && parent.id.type === 'Identifier') {
          this._insertSymbol(node, 'function', fileId, relativePath, fullCode, parent.id.name);
        }
      },
      ClassDeclaration: (node) => this._insertSymbol(node, 'class', fileId, relativePath, fullCode),
      MethodDefinition: (node) => {
        if (node.key.type === 'Identifier' && node.value.type.includes('Function')) {
          this._insertSymbol(node.value, 'method', fileId, relativePath, fullCode, node.key.name);
        }
      }
    });
  }

  _insertSymbol(node, kind, fileId, relativePath, fullCode, overrideName = null) {
    const name = overrideName || (node.id && node.id.name) || null;
    if (!name) return;

    if (kind === 'function' || kind === 'method') this.stats.functions++;
    if (kind === 'class') this.stats.classes++;

    const content = fullCode.substring(node.start, node.end);
    const signature = `${kind === 'class' ? 'class' : 'function'} ${name}`;

    const symbolResult = this.insertNode.run(kind, name, relativePath, content, signature, '');
    const symbolId = symbolResult.lastInsertRowid;
    this.insertEdge.run(fileId, symbolId, 'defines');
    this.stats.edges++;
  }

  finalize() {
    this.db.close();
    console.log('\n✅ Enterprise Graph Scan Complete!');
    console.log(`   📂 Files: ${this.stats.files}`);
    console.log(`   ⚙️ Symbols (Func/Class): ${this.stats.functions + this.stats.classes}`);
    console.log(`   🔗 Imports: ${this.stats.imports}`);
    console.log(`   🔗 Total Edges: ${this.stats.edges}`);
    console.log(`💾 Graph saved at: ${CONFIG.dbPath}`);
  }
}

async function main() {
  const scanner = new EnterpriseScanner();
  try {
    scanner.initializeDB();
    scanner.scanDirectory(CONFIG.targetDir);
    scanner.finalize();
  } catch (error) {
    console.error('💥 Fatal Error:', error.message);
    process.exit(1);
  }
}

main();