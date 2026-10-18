#!/usr/bin/env node
'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const COLORS = {
  reset: '\x1b[0m', bright: '\x1b[1m', cyan: '\x1b[36m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', dim: '\x1b[2m',
};

const dbPath = process.env.CORTEX_DB_PATH || path.join(process.cwd(), 'cortex-brain.db');
const question = process.argv.slice(2).join(' ');

if (!question) {
  console.log('Usage: cortex ask "<question>"');
  process.exit(1);
}

if (!fs.existsSync(dbPath)) {
  console.error(`${COLORS.red}❌ Database not found. Run "cortex scan" first.${COLORS.reset}`);
  process.exit(1);
}

const db = new Database(dbPath, { readonly: true, fileMustExist: true });

try {
  const keywords = question.match(/[\p{L}\p{N}_]+/gu) || [];
  const resultsMap = new Map();

  const stmt = db.prepare(`
    SELECT kind, name, file_path,
      CASE
        WHEN LOWER(name) = ? THEN 100
        WHEN LOWER(name) LIKE ? THEN 80
        ELSE 50
      END AS relevance_score
    FROM nodes
    WHERE LOWER(name) LIKE ?
    ORDER BY relevance_score DESC, name ASC
    LIMIT 50
  `);

  for (const word of keywords) {
    if (word.length < 3) continue;
    const kw = word.toLowerCase();
    const rows = stmt.all(kw, `${kw}%`, `%${kw}%`);
    for (const row of rows) {
      const key = `${row.kind}::${row.name}::${row.file_path}`;
      if (!resultsMap.has(key) || resultsMap.get(key).score < row.relevance_score) {
        resultsMap.set(key, { kind: row.kind, name: row.name, path: row.file_path, score: row.relevance_score });
      }
    }
  }

  const results = Array.from(resultsMap.values()).sort((a, b) => b.score - a.score);

  console.log(`\n${COLORS.cyan}🔍 Searching:${COLORS.reset} "${question}"\n`);

  if (results.length === 0) {
    console.log(`${COLORS.red}❌ No results found.${COLORS.reset}`);
    process.exit(0);
  }

  console.log(`${COLORS.green}✅ Found ${results.length} items:${COLORS.reset}\n`);
  results.forEach(r => {
    const icon = r.score === 100 ? '🎯' : (r.score === 80 ? '📌' : '🔹');
    console.log(`   ${icon} [${r.kind.toUpperCase()}] ${r.name}`);
    console.log(`      ${COLORS.dim}📂 ${r.path}${COLORS.reset}`);
  });

  console.log(`\n${COLORS.green}💰 Tokens Saved: ~${(results.length * 1500).toLocaleString()}${COLORS.reset}\n`);
} finally {
  db.close();
}