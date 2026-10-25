
'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { DB_PATH } = require('./db-path');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

try {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  db.exec(`
    CREATE TABLE IF NOT EXISTS nodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path TEXT,
      name TEXT,
      kind TEXT,
      content TEXT,
      signature TEXT,
      line INTEGER,
      jsdoc TEXT
    );

    CREATE TABLE IF NOT EXISTS edges (
      source TEXT,
      target TEXT,
      kind TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_nodes_file_path
      ON nodes(file_path);

    CREATE INDEX IF NOT EXISTS idx_nodes_name
      ON nodes(name);

    CREATE INDEX IF NOT EXISTS idx_nodes_kind
      ON nodes(kind);

    CREATE INDEX IF NOT EXISTS idx_edges_source_kind
      ON edges(source, kind);
  `);

  // Migrate older nodes tables without dropping existing data.
  const columns = db.prepare(
    'PRAGMA table_info(nodes)'
  ).all();

  if (!columns.some(column => column.name === 'jsdoc')) {
    db.exec('ALTER TABLE nodes ADD COLUMN jsdoc TEXT');
  }

  // Create FTS5 only if supported by the installed SQLite build.
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
      name,
      content,
      file_path,
      tokenize = 'unicode61'
    );
  `);
} catch (error) {
  db.close();
  throw new Error(
    `Cortex database initialization failed at ${DB_PATH}: ${error.message}`
  );
}


db.exec(`
  CREATE TABLE IF NOT EXISTS index_metadata (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    root_path TEXT NOT NULL,
    indexed_at TEXT NOT NULL,
    files INTEGER NOT NULL CHECK (files >= 0),
    symbols INTEGER NOT NULL CHECK (symbols >= 0),
    imports INTEGER NOT NULL CHECK (imports >= 0)
  );
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS call_edges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path TEXT NOT NULL,
    caller_name TEXT,
    caller_line INTEGER,
    callee_name TEXT NOT NULL,
    call_line INTEGER NOT NULL,
    resolution TEXT NOT NULL CHECK (
      resolution IN (
        'unique_name_candidate',
        'ambiguous_name',
        'unresolved_name'
      )
    ),
    target_line INTEGER,
    analysis_scope TEXT NOT NULL DEFAULT 'same_file_direct_identifier'
  );

  CREATE INDEX IF NOT EXISTS idx_call_edges_file_lines
    ON call_edges(file_path, caller_line, call_line);

  CREATE INDEX IF NOT EXISTS idx_call_edges_callee_resolution
    ON call_edges(callee_name, resolution);
`);

module.exports = db;
module.exports.DB_PATH = DB_PATH;
