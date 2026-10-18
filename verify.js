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

  // 1. التحقق من وجود ملف
  verifyFile(filePath) {
    const stmt = this.db.prepare("SELECT name FROM nodes WHERE kind='file' AND file_path = ?");
    const result = stmt.get(filePath);
    if (result) {
      return { status: 'VERIFIED', message: `File exists: ${filePath}` };
    }
    return { status: 'REFUTED', message: `File NOT found: ${filePath}` };
  }

  // 2. التحقق من وجود دالة
  verifyFunction(funcName, filePath = null) {
    let query = "SELECT name, file_path FROM nodes WHERE kind='function' AND name = ?";
    let params = [funcName];
    
    if (filePath) {
      query += " AND file_path = ?";
      params.push(filePath);
    }

    const stmt = this.db.prepare(query);
    const result = stmt.get(...params);
    
    if (result) {
      return { status: 'VERIFIED', message: `Function '${funcName}' found in ${result.file_path}` };
    }
    return { status: 'REFUTED', message: `Function '${funcName}' NOT found anywhere.` };
  }

  // 3. التحقق من وجود استيراد (Import)
  verifyImport(moduleName) {
    try {
      // محاولة قراءة package.json للتحقق من الحزم الخارجية
      const pkgPath = path.join(process.cwd(), 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (deps[moduleName]) {
          return { status: 'VERIFIED', message: `Package '${moduleName}' is in package.json` };
        }
      }
      
      // التحقق من الملفات المحلية
      const stmt = this.db.prepare("SELECT name FROM nodes WHERE kind='file' AND name LIKE ?");
      const result = stmt.get(`%${moduleName}%`);
      if (result) {
        return { status: 'VERIFIED', message: `Local module '${moduleName}' found` };
      }

      return { status: 'REFUTED', message: `Import '${moduleName}' NOT found` };
    } catch (e) {
      return { status: 'UNKNOWN', message: `Error verifying import: ${e.message}` };
    }
  }

  destroy() {
    if (this.db) this.db.close();
  }
}

// ==========================================
// 4. واجهة سطر الأوامر
// ==========================================
async function main() {
  const args = process.argv.slice(2);
  
  if (args.length < 2) {
    console.log(`
🧠 Cortex Verify - Anti-Hallucination Gate

Usage:
  node verify.js file <file_path>
  node verify.js function <function_name> [file_path]
  node verify.js import <module_name>
    `);
    process.exit(0);
  }

  const verifier = new CortexVerifier();
  if (!verifier.initialize()) process.exit(1);

  const command = args[0];
  let result;

  if (command === 'file') {
    result = verifier.verifyFile(args[1]);
  } else if (command === 'function') {
    result = verifier.verifyFunction(args[1], args[2]);
  } else if (command === 'import') {
    result = verifier.verifyImport(args[1]);
  } else {
    console.log('❌ Unknown command. Use: file, function, or import.');
    process.exit(1);
  }

  verifier.destroy();

  // طباعة النتيجة
  const icon = result.status === 'VERIFIED' ? '✅' : (result.status === 'REFUTED' ? '❌' : '⚠️');
  console.log(`\n${icon} Status: ${result.status}`);
  console.log(`   ${result.message}\n`);
  
  if (result.status === 'REFUTED') process.exit(1); // كود خطأ للـ CI/CD
}

main().catch(err => {
  console.error('💥 Fatal Error:', err.message);
  process.exit(1);
});