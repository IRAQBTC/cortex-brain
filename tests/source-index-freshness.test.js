import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { inspectSourceIndex } from '../handoff-generator.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const fixtures = [];

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-freshness-'));
  const sourcePath = path.join(root, 'sample.js');
  const sourceContent = 'function sample() { return 1; }\n';

  fs.writeFileSync(sourcePath, sourceContent, 'utf8');

  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE nodes (
      id INTEGER PRIMARY KEY,
      file_path TEXT NOT NULL,
      kind TEXT NOT NULL,
      content TEXT
    );

    CREATE TABLE edges (
      source INTEGER,
      target INTEGER,
      kind TEXT
    );

    CREATE TABLE index_metadata (
      id INTEGER PRIMARY KEY,
      root_path TEXT NOT NULL,
      files INTEGER NOT NULL,
      symbols INTEGER NOT NULL,
      imports INTEGER NOT NULL
    );
  `);

  db.prepare(`
    INSERT INTO nodes (id, file_path, kind, content)
    VALUES (1, 'sample.js', 'file', ?)
  `).run(sourceContent);

  db.prepare(`
    INSERT INTO index_metadata (id, root_path, files, symbols, imports)
    VALUES (1, ?, 1, 0, 0)
  `).run(root);

  const fixture = { root, sourcePath, db };
  fixtures.push(fixture);
  return fixture;
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    try { fixture.db.close(); } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

describe('inspectSourceIndex freshness checks', () => {
  it('reports FRESH when indexed source and metadata match disk', () => {
    const { root, db } = makeFixture();

    const result = inspectSourceIndex(root, db);

    expect(result.status).toBe('FRESH');
    expect(result.metadataMatches).toBe(true);
    expect(result.missingFromIndex).toEqual([]);
    expect(result.missingOnDisk).toEqual([]);
    expect(result.contentDrift).toEqual([]);
    expect(result.duplicateIndexedPaths).toEqual([]);
  });

  it('reports STALE when source content changes after indexing', () => {
    const { root, sourcePath, db } = makeFixture();

    fs.writeFileSync(
      sourcePath,
      'function sample() { return 2; }\n',
      'utf8'
    );

    const result = inspectSourceIndex(root, db);

    expect(result.status).toBe('STALE');
    expect(result.contentDrift.map(item => item.file)).toContain('sample.js');
  });

  it('reports STALE when a source file is absent from the index', () => {
    const { root, db } = makeFixture();

    fs.writeFileSync(
      path.join(root, 'new-file.js'),
      'const added = true;\n',
      'utf8'
    );

    const result = inspectSourceIndex(root, db);

    expect(result.status).toBe('STALE');
    expect(result.missingFromIndex).toContain('new-file.js');
  });

  it('reports STALE when an indexed source file no longer exists on disk', () => {
    const { root, sourcePath, db } = makeFixture();

    fs.unlinkSync(sourcePath);

    const result = inspectSourceIndex(root, db);

    expect(result.status).toBe('STALE');
    expect(result.missingOnDisk).toContain('sample.js');
  });

  it('reports STALE when the index contains duplicate file paths', () => {
    const { root, db } = makeFixture();

    db.prepare(`
      INSERT INTO nodes (id, file_path, kind, content)
      VALUES (2, 'sample.js', 'file', ?)
    `).run('function sample() { return 1; }\n');

    db.prepare(`
      UPDATE index_metadata SET files = 2 WHERE id = 1
    `).run();

    const result = inspectSourceIndex(root, db);

    expect(result.status).toBe('STALE');
    expect(result.duplicateIndexedPaths).toContain('sample.js');
  });
});
