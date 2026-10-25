import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const {
  ensureCallEdgesSchema,
  replaceCallEdgesForFile,
  getCallEdgesForFile
} = require('../call-edges-store.js');

describe('call-edges-store', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    ensureCallEdgesSchema(db);
  });

  afterEach(() => {
    if (db) {
      db.close();
      db = null;
    }
  });

  it('creates the call_edges table', () => {
    const result = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'call_edges'"
    ).get();

    expect(result.name).toBe('call_edges');
  });

  it('stores and retrieves call sites', () => {
    const count = replaceCallEdgesForFile(db, 'src/a.js', [{
      caller: 'start',
      callerLine: 4,
      callee: 'calculate',
      line: 9,
      resolution: 'unique_name_candidate',
      targetLine: 20
    }]);

    expect(count).toBe(1);
    expect(getCallEdgesForFile(db, 'src/a.js')).toEqual([{
      filePath: 'src/a.js',
      caller: 'start',
      callerLine: 4,
      callee: 'calculate',
      callLine: 9,
      resolution: 'unique_name_candidate',
      targetLine: 20
    }]);
  });

  it('replaces prior call sites for the same file', () => {
    replaceCallEdgesForFile(db, 'src/a.js', [
      { caller: 'a', callee: 'b', line: 2 },
      { caller: 'a', callee: 'c', line: 3 }
    ]);

    expect(replaceCallEdgesForFile(db, 'src/a.js', [
      { caller: 'a', callee: 'd', line: 5 }
    ])).toBe(1);

    expect(getCallEdgesForFile(db, 'src/a.js').map(row => row.callee))
      .toEqual(['d']);
  });

  it('preserves existing rows when replacement input is invalid', () => {
    replaceCallEdgesForFile(db, 'src/a.js', [
      { caller: 'a', callee: 'b', line: 2 }
    ]);

    expect(() => replaceCallEdgesForFile(db, 'src/a.js', [
      { caller: 'a', callee: 'valid', line: 3 },
      { caller: '', callee: 'invalid', line: 4 }
    ])).toThrow();

    expect(getCallEdgesForFile(db, 'src/a.js').map(row => row.callee))
      .toEqual(['b']);
  });

  it('keeps records from different files separate', () => {
    replaceCallEdgesForFile(db, 'src/a.js', [
      { caller: 'a', callee: 'shared', line: 2 }
    ]);
    replaceCallEdgesForFile(db, 'src/b.js', [
      { caller: 'b', callee: 'shared', line: 7 }
    ]);

    expect(getCallEdgesForFile(db, 'src/a.js')).toHaveLength(1);
    expect(getCallEdgesForFile(db, 'src/b.js')).toHaveLength(1);
  });

  it('rejects invalid arguments', () => {
    expect(() => replaceCallEdgesForFile(db, '', [])).toThrow();
    expect(() => replaceCallEdgesForFile(db, 'src/a.js', 'not-an-array'))
      .toThrow();
    expect(getCallEdgesForFile(db, 'src/a.js')).toEqual([]);
  });
});
