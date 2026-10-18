#!/usr/bin/env node
'use strict';

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const pinoHttp = require('pino-http');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { z } = require('zod');

const CONFIG = {
  port: process.env.PORT || 3000,
  dbPath: process.env.CORTEX_DB_PATH || path.join(__dirname, 'cortex-brain.db'),
  publicDir: path.join(__dirname, 'public'),
};

let db;

function initializeCore() {
  if (!fs.existsSync(CONFIG.dbPath)) {
    console.error(`❌ Fatal: Database not found at ${CONFIG.dbPath}`);
    process.exit(1);
  }
  db = new Database(CONFIG.dbPath, { readonly: true, fileMustExist: true });
  db.pragma('journal_mode = WAL');
  console.log('✅ Core engines initialized successfully.');
}

const app = express();

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, max: 100 }));
app.use(pinoHttp({ level: 'info' }));
app.use(express.json({ limit: '10kb' }));
app.use(express.static(CONFIG.publicDir));

// 1. الإحصائيات (Stats)
app.get('/api/stats', (req, res) => {
  try {
    const stats = {
      files: db.prepare("SELECT COUNT(*) as c FROM nodes WHERE kind = 'file'").get().c,
      functions: db.prepare("SELECT COUNT(*) as c FROM nodes WHERE kind = 'function'").get().c,
      classes: db.prepare("SELECT COUNT(*) as c FROM nodes WHERE kind = 'class'").get().c,
      imports: db.prepare("SELECT COUNT(*) as c FROM nodes WHERE kind = 'import'").get().c
    };
    res.json({ success: true, data: stats });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// 2. البحث (Search)
app.get('/api/search', (req, res) => {
  try {
    const query = (req.query.q || '').toLowerCase();
    if (query.length < 2) return res.json({ success: true, data: [] });
    
    const stmt = db.prepare(`
      SELECT kind, name, file_path, signature, jsdoc, content 
      FROM nodes 
      WHERE LOWER(name) LIKE ?
      ORDER BY CASE WHEN LOWER(name) = ? THEN 0 ELSE 1 END, name ASC
      LIMIT 50
    `);
    const results = stmt.all(`%${query}%`, query);
    res.json({ success: true, data: results });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// 3. جلب الكود (File)
app.get('/api/file', (req, res) => {
  try {
    const { name, path: filePath } = req.query;
    const stmt = db.prepare("SELECT content, signature, jsdoc, kind FROM nodes WHERE name = ? AND file_path = ? LIMIT 1");
    const row = stmt.get(name, filePath);
    if (row) res.json({ success: true, data: row });
    else res.status(404).json({ success: false });
  } catch (error) { res.status(500).json({ success: false }); }
});

// 4. التحقق (Verify)
app.post('/api/verify', (req, res) => {
  try {
    const { symbolName, filePath } = req.body;
    const result = db.prepare("SELECT kind FROM nodes WHERE name = ? AND file_path = ?").get(symbolName, filePath);
    if (result) res.json({ success: true, status: 'VERIFIED' });
    else res.json({ success: true, status: 'REFUTED' });
  } catch (error) { res.status(500).json({ success: false }); }
});

// 5. نصف قطر الانفجار (Blast Radius)
app.get('/api/blast-radius', (req, res) => {
  try {
    const { name, path: filePath } = req.query;
    const stmt = db.prepare(`
      SELECT DISTINCT n_source.file_path AS affected_file
      FROM nodes n_target
      JOIN edges e_def ON n_target.id = e_def.target_id AND e_def.kind = 'defines'
      JOIN nodes n_file ON e_def.source_id = n_file.id
      JOIN edges e_imp ON n_file.id = e_imp.target_id AND e_imp.kind = 'imports_internal'
      JOIN nodes n_source ON e_imp.source_id = n_source.id
      WHERE n_target.name = ? AND n_target.file_path = ?
    `);
    const affected = stmt.all(name, filePath);
    res.json({ success: true, affectedFilesCount: affected.length, affectedFiles: affected.map(f => f.affected_file) });
  } catch (error) { res.status(500).json({ success: false }); }
});

app.get(/.*/, (req, res) => res.sendFile(path.join(CONFIG.publicDir, 'index.html')));

initializeCore();
app.listen(CONFIG.port, () => {
  console.log(`\n🚀 Server running at http://localhost:${CONFIG.port}`);
  console.log(`👉 Open browser and press Ctrl+Shift+R to clear cache`);
});