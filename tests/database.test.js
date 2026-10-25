import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const DB_PATH = path.resolve(process.env.CORTEX_DB_PATH || process.env.DB_PATH || path.join(process.cwd(), "cortex-brain.db"));

describe("Cortex database regression checks", () => {
  let db;

  beforeAll(() => {
    if (!fs.existsSync(DB_PATH)) {
      throw new Error(`Database not found: ${DB_PATH}`);
    }

    db = new Database(DB_PATH, { readonly: true });
  });

  afterAll(() => {
    if (db && db.open) db.close();
  });

  it("passes SQLite integrity_check", () => {
    const rows = db.pragma("integrity_check");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(row => row.integrity_check === "ok")).toBe(true);
  });

  it("contains the required nodes, edges, and FTS tables", () => {
    const tables = new Set(
      db.prepare(`
        SELECT name
        FROM sqlite_master
        WHERE type IN ('table', 'view')
      `).all().map(row => row.name)
    );

    expect(tables.has("nodes")).toBe(true);
    expect(tables.has("edges")).toBe(true);
    expect(tables.has("nodes_fts")).toBe(true);
  });

  it("has nodes with recognized kinds and non-empty IDs", () => {
    const columns = db.prepare("PRAGMA table_info(nodes)").all();
    const columnNames = new Set(columns.map(column => column.name));

    expect(columnNames.has("id")).toBe(true);
    expect(columnNames.has("kind")).toBe(true);

    const invalid = db.prepare(`
      SELECT COUNT(*) AS count
      FROM nodes
      WHERE id IS NULL
         OR kind IS NULL
         OR TRIM(CAST(id AS TEXT)) = ''
         OR TRIM(kind) = ''
    `).get();

    expect(invalid.count).toBe(0);

    const nodeCount = db.prepare(
      "SELECT COUNT(*) AS count FROM nodes"
    ).get().count;

    expect(nodeCount).toBeGreaterThan(0);
  });

  it("has a full-text index count consistent with the node count", () => {
    const nodes = db.prepare(
      "SELECT COUNT(*) AS count FROM nodes"
    ).get().count;

    const indexed = db.prepare(
      "SELECT COUNT(*) AS count FROM nodes_fts"
    ).get().count;

    expect(indexed).toBe(nodes);
  });

  it("maps import sources to indexed files and requires non-empty targets", () => {
    const edgeColumns = new Set(
      db.prepare("PRAGMA table_info(edges)").all()
        .map(column => column.name)
    );

    expect(edgeColumns.has("source")).toBe(true);
    expect(edgeColumns.has("target")).toBe(true);
    expect(edgeColumns.has("kind")).toBe(true);

    const invalidSources = db.prepare(`
      SELECT COUNT(*) AS count
      FROM edges e
      LEFT JOIN nodes n
        ON n.kind = 'file'
       AND n.file_path = e.source
      WHERE e.kind = 'imports'
        AND n.id IS NULL
    `).get();

    const emptyTargets = db.prepare(`
      SELECT COUNT(*) AS count
      FROM edges
      WHERE kind = 'imports'
        AND (target IS NULL OR TRIM(target) = '')
    `).get();

    expect(invalidSources.count).toBe(0);
    expect(emptyTargets.count).toBe(0);
  });
  it("contains at least one import relationship", () => {
    const result = db.prepare(`
      SELECT COUNT(*) AS count
      FROM edges
      WHERE kind = 'imports'
    `).get();

    expect(result.count).toBeGreaterThan(0);
  });

  it("can execute a basic FTS query without SQL errors", () => {
    const result = db.prepare(`
      SELECT COUNT(*) AS count
      FROM nodes_fts
      WHERE nodes_fts MATCH ?
    `).get('"scanner"');

    expect(result.count).toBeGreaterThanOrEqual(0);
  });
});
