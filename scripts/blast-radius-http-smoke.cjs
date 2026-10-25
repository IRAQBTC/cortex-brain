"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");

const projectRoot = path.resolve(__dirname, "..");
const originalDbPath = path.join(projectRoot, "cortex-brain.db");

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

async function main() {
  const originalHashBefore = sha256(originalDbPath);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-http-smoke-"));
  const tempDbPath = path.join(tempRoot, "cortex-test.db");
  const previousDbPath = process.env.CORTEX_DB_PATH;
  const previousDbPathAlias = process.env.DB_PATH;

  let sourceDb;
  let appDb;
  let server;
  let originalHashAfter;
  let failures = 0;

  try {
    sourceDb = new Database(originalDbPath, {
      readonly: true,
      fileMustExist: true
    });

    await sourceDb.backup(tempDbPath);
    sourceDb.close();
    sourceDb = null;

    process.env.CORTEX_DB_PATH = tempDbPath;
    delete process.env.DB_PATH;

    // Import only after the isolated database path is configured.
    const exported = require(path.join(projectRoot, "server.js"));
    appDb = exported.db;
    server = exported.server;

    assert.ok(exported.app, "Express app export is missing.");
    assert.ok(server, "HTTP server export is missing.");
    assert.ok(appDb, "Database export is missing.");

    const address = await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve(server.address());
      });
    });

    const baseUrl = `http://127.0.0.1:${address.port}`;

    async function getJson(url) {
      const response = await fetch(url);
      let body;
      try {
        body = await response.json();
      } catch {
        throw new Error(`Expected JSON response from ${url}; HTTP ${response.status}`);
      }
      return { response, body };
    }

    console.log("\n=== HTTP TEST 1: SYMBOL LIST ===");
    const symbolsResult = await getJson(`${baseUrl}/api/blast-radius/symbols`);
    assert.equal(symbolsResult.response.status, 200);
    assert.equal(symbolsResult.body.success, true);
    assert.ok(Array.isArray(symbolsResult.body.data));
    assert.ok(symbolsResult.body.data.length > 0, "No indexed symbols returned.");
    console.log(`PASS: ${symbolsResult.body.data.length} symbols returned`);

    console.log("\n=== HTTP TEST 2: BLAST RADIUS ANALYSIS ===");
    const known = appDb.prepare(`
      SELECT name, file_path
      FROM nodes
      WHERE name = 'hashContent'
        AND kind IN ('function', 'method')
      ORDER BY file_path, line
      LIMIT 1
    `).get();

    const target = known || symbolsResult.body.data[0];
    const query = new URLSearchParams({
      name: target.name,
      file_path: target.file_path
    });

    const analysisResult = await getJson(
      `${baseUrl}/api/blast-radius?${query.toString()}`
    );

    assert.equal(analysisResult.response.status, 200);
    assert.equal(analysisResult.body.success, true);
    assert.ok(analysisResult.body.data && typeof analysisResult.body.data === "object");
    assert.ok(
      [
        "analyzed",
        "partial",
        "not_found",
        "ambiguous",
        "unavailable",
        "unsupported",
        "stale_or_unmatched"
      ].includes(analysisResult.body.data.status),
      `Unexpected analysis status: ${analysisResult.body.data.status}`
    );
    console.log(`PASS: HTTP 200; analysis status=${analysisResult.body.data.status}`);
    console.log(`Target: ${target.name} (${target.file_path})`);

    console.log("\n=== HTTP TEST 3: MISSING SYMBOL NAME ===");
    const invalidResult = await getJson(`${baseUrl}/api/blast-radius`);
    assert.equal(invalidResult.response.status, 400);
    assert.equal(invalidResult.body.success, false);
    console.log("PASS: invalid request returns HTTP 400");
  } finally {
    if (sourceDb && sourceDb.open) sourceDb.close();

    if (server && server.listening) {
      await new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
      });
    }

    if (appDb && appDb.open) appDb.close();

    if (previousDbPath === undefined) delete process.env.CORTEX_DB_PATH;
    else process.env.CORTEX_DB_PATH = previousDbPath;

    if (previousDbPathAlias === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = previousDbPathAlias;

    originalHashAfter = sha256(originalDbPath);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  console.log("\n=== ORIGINAL DATABASE INTEGRITY GUARD ===");
  assert.equal(
    originalHashAfter,
    originalHashBefore,
    "Original database SHA-256 changed during the test."
  );
  console.log(`PASS: original database unchanged (${originalHashAfter})`);
}

main().catch(error => {
  console.error("\nFAIL: Blast Radius HTTP smoke test");
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});