#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const CONFIG = {
  dbPath: process.env.CORTEX_DB_PATH || path.join(process.cwd(), 'cortex-brain.db'),
};

class CortexVerifier {
  constructor() {
    this.db = null;
  }

  initialize() {
    try {
      if (!fs.existsSync(CONFIG.dbPath)) throw new Error('Database not found.');
      this.db = new Database(CONFIG.dbPath, { readonly: true, fileMustExist: true });
      return true;
    } catch (error) {
      console.error(`❌ Error: ${error.message}`);
      return false;
    }
  }

  _verifyEntity(kind, name, filePath = null) {
    let query = "SELECT name, file_path FROM nodes WHERE kind = ? AND name = ?";
    let params = [kind, name];
    
    if (filePath) {
      query += " AND file_path = ?";
      params.push(filePath);
    }

    const result = this.db.prepare(query).get(...params);
    
    if (result) {
      return { status: 'VERIFIED', message: `${kind} '${name}' found in ${result.file_path}` };
    }
    return { status: 'REFUTED', message: `${kind} '${name}' NOT found anywhere.` };
  }

  verifyFile(filePath) { return this._verifyEntity('file', path.basename(filePath), filePath); }
  verifyFunction(funcName, filePath) { return this._verifyEntity('function', funcName, filePath); }
  verifyClass(className, filePath) { return this._verifyEntity('class', className, filePath); }
  verifyMethod(methodName, filePath) { return this._verifyEntity('method', methodName, filePath); }

  verifyImport(moduleName) {
    try {
      const pkgPath = path.join(process.cwd(), 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (deps[moduleName]) {
          return { status: 'VERIFIED', message: `Package '${moduleName}' is in package.json` };
        }
      }
      
      const result = this.db.prepare("SELECT name FROM nodes WHERE kind='file' AND name LIKE ?").get(`%${moduleName}%`);
      if (result) return { status: 'VERIFIED', message: `Local module '${moduleName}' found` };

      return { status: 'REFUTED', message: `Import '${moduleName}' NOT found` };
    } catch (e) {
      return { status: 'UNKNOWN', message: `Error verifying import: ${e.message}` };
    }
  }

  destroy() {
    if (this.db) this.db.close();
  }
}

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length < 2) {
    console.log(`
🧠 Cortex Verify - Anti-Hallucination Gate

Usage:
  node verify.js file <file_path>
  node verify.js function <function_name> [file_path]
  node verify.js class <class_name> [file_path]
  node verify.js method <method_name> [file_path]
  node verify.js import <module_name>
    `);
    process.exit(0);
  }

  const verifier = new CortexVerifier();
  if (!verifier.initialize()) process.exit(1);

  const command = args[0];
  let result;

  if (command === 'file') result = verifier.verifyFile(args[1]);
  else if (command === 'function') result = verifier.verifyFunction(args[1], args[2]);
  else if (command === 'class') result = verifier.verifyClass(args[1], args[2]);
  else if (command === 'method') result = verifier.verifyMethod(args[1], args[2]);
  else if (command === 'import') result = verifier.verifyImport(args[1]);
  else {
    console.log('❌ Unknown command. Use: file, function, class, method, or import.');
    process.exit(1);
  }

  verifier.destroy();

  const icon = result.status === 'VERIFIED' ? '✅' : (result.status === 'REFUTED' ? '❌' : '⚠️');
  console.log(`\n${icon} Status: ${result.status}`);
  console.log(`   ${result.message}\n`);
  
  if (result.status === 'REFUTED') process.exit(1);
}

main();