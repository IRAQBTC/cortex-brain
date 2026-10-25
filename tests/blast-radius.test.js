import Database from "better-sqlite3";
import { describe, it, expect, afterEach } from "vitest";
import { findBlastRadius } from "../blast-radius.js";

describe("findBlastRadius", () => {
  let db;

  function setup(files, symbols) {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE nodes (
        id INTEGER PRIMARY KEY,
        file_path TEXT,
        name TEXT,
        kind TEXT,
        content TEXT,
        line INTEGER
      );
    `);

    const insert = db.prepare(`
      INSERT INTO nodes (id, file_path, name, kind, content, line)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    for (const row of [...files, ...symbols]) {
      insert.run(row.id, row.file_path, row.name, row.kind, row.content ?? null, row.line ?? null);
    }
  }

  afterEach(() => {
    if (db) {
      db.close();
      db = null;
    }
  });

  it("finds a same-file caller with the call-site line", () => {
    const source = [
      "function hashContent(content) {",
      "  return content;",
      "}",
      "",
      "function prepareFile() {",
      "  return hashContent('x');",
      "}"
    ].join("\n");

    setup(
      [{ id: 1, file_path: "scanner.js", name: "scanner.js", kind: "file", content: source }],
      [{ id: 2, file_path: "scanner.js", name: "hashContent", kind: "function", line: 1 }]
    );

    const result = findBlastRadius(db, { name: "hashContent" });

    expect(result.status).toBe("analyzed");
    expect(result.callers).toHaveLength(1);
    expect(result.callers[0].caller).toBe("prepareFile");
    expect(result.callers[0].callerLine).toBe(5);
    expect(result.callers[0].callLine).toBe(6);
    expect(result.coverage.crossFileCallsAnalyzed).toBe(false);
  });

  it("requires file_path when a symbol name is ambiguous", () => {
    setup(
      [
        { id: 1, file_path: "a.js", name: "a.js", kind: "file", content: "function work() {}" },
        { id: 2, file_path: "b.js", name: "b.js", kind: "file", content: "function work() {}" }
      ],
      [
        { id: 3, file_path: "a.js", name: "work", kind: "function", line: 1 },
        { id: 4, file_path: "b.js", name: "work", kind: "function", line: 1 }
      ]
    );

    const result = findBlastRadius(db, { name: "work" });

    expect(result.status).toBe("ambiguous");
    expect(result.candidates).toHaveLength(2);
  });

  it("does not claim safety when no caller is found", () => {
    const source = "function isolated() { return 1; }";

    setup(
      [{ id: 1, file_path: "solo.js", name: "solo.js", kind: "file", content: source }],
      [{ id: 2, file_path: "solo.js", name: "isolated", kind: "function", line: 1 }]
    );

    const result = findBlastRadius(db, { name: "isolated" });

    expect(result.status).toBe("analyzed");
    expect(result.callers).toHaveLength(0);
    expect(result.message).toMatch(/does not establish.*safe/i);
  });

  it("finds a cross-file caller through a named import alias", () => {
    db = new Database(":memory:");

    db.exec(`
      CREATE TABLE nodes (
        id INTEGER PRIMARY KEY,
        file_path TEXT,
        name TEXT,
        kind TEXT,
        content TEXT,
        line INTEGER
      );
      CREATE TABLE edges (
        source TEXT,
        target TEXT,
        kind TEXT
      );
    `);

    const targetSource = [
      "export function targetFn(value) {",
      "  return value;",
      "}"
    ].join("\n");

    const importerSource = [
      'import { targetFn as localTarget } from "./target.js";',
      "function run() {",
      "  return localTarget(1);",
      "}"
    ].join("\n");

    const insertNode = db.prepare(`
      INSERT INTO nodes (id, file_path, name, kind, content, line)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    insertNode.run(1, "src/target.js", "target.js", "file", targetSource, null);
    insertNode.run(2, "src/consumer.js", "consumer.js", "file", importerSource, null);
    insertNode.run(3, "src/target.js", "targetFn", "function", null, 1);

    db.prepare(`
      INSERT INTO edges (source, target, kind)
      VALUES (?, ?, ?)
    `).run("src/consumer.js", "./target.js", "imports");

    const result = findBlastRadius(db, {
      name: "targetFn",
      file_path: "src/target.js"
    });

    expect(result.status).toBe("analyzed");
    expect(result.crossFileCandidates).toHaveLength(1);
    expect(result.crossFileCandidates[0]).toMatchObject({
      caller: "run",
      file_path: "src/consumer.js",
      callLine: 3,
      resolution: "cross_file_named_import_candidate",
      importedName: "targetFn",
      localName: "localTarget"
    });
    expect(result.coverage.crossFileImportEdgesExamined).toBe(1);
    expect(result.coverage.importAliasCandidatesDetected).toBe(true);
    expect(result.coverage.importAliasesResolved).toBe(false);
  });
  it("returns not_found for an unknown symbol", () => {
    setup([], []);
    expect(findBlastRadius(db, { name: "missing" }).status).toBe("not_found");
  });
});