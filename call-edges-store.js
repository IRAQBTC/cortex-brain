'use strict';

function ensureCallEdgesSchema(db) {
  if (!db || typeof db.exec !== 'function' || typeof db.prepare !== 'function') {
    throw new TypeError('A compatible SQLite database instance is required.');
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS call_edges (
      id INTEGER PRIMARY KEY,
      file_path TEXT NOT NULL,
      caller TEXT NOT NULL,
      caller_line INTEGER,
      callee TEXT NOT NULL,
      call_line INTEGER,
      resolution TEXT NOT NULL,
      target_line INTEGER,
      CHECK (caller_line IS NULL OR caller_line > 0),
      CHECK (call_line IS NULL OR call_line > 0),
      CHECK (target_line IS NULL OR target_line > 0)
    );

    CREATE INDEX IF NOT EXISTS idx_call_edges_file_path
      ON call_edges(file_path);

    CREATE INDEX IF NOT EXISTS idx_call_edges_callee
      ON call_edges(callee);

    CREATE INDEX IF NOT EXISTS idx_call_edges_caller
      ON call_edges(caller);
  `);
}

function replaceCallEdgesForFile(db, filePath, calls) {
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    throw new TypeError('filePath must be a non-empty string.');
  }
  if (!Array.isArray(calls)) {
    throw new TypeError('calls must be an array.');
  }

  ensureCallEdgesSchema(db);

  const normalized = calls.map((call, index) => {
    if (!call || typeof call !== 'object') {
      throw new TypeError(`Invalid call at index ${index}.`);
    }
    if (typeof call.caller !== 'string' || !call.caller.trim()) {
      throw new TypeError(`Missing caller at index ${index}.`);
    }
    if (typeof call.callee !== 'string' || !call.callee.trim()) {
      throw new TypeError(`Missing callee at index ${index}.`);
    }

    const validLine = value =>
      value == null || (Number.isInteger(value) && value > 0);

    for (const key of ['callerLine', 'line', 'targetLine']) {
      if (!validLine(call[key])) {
        throw new TypeError(`Invalid ${key} at index ${index}.`);
      }
    }

    const resolution = call.resolution || 'unresolved_name';
    if (typeof resolution !== 'string' || !resolution.trim()) {
      throw new TypeError(`Invalid resolution at index ${index}.`);
    }

    return {
      caller: call.caller,
      callerLine: call.callerLine ?? null,
      callee: call.callee,
      callLine: call.line ?? null,
      resolution,
      targetLine: call.targetLine ?? null
    };
  });

  const transaction = db.transaction(() => {
    db.prepare('DELETE FROM call_edges WHERE file_path = ?').run(filePath);

    const insert = db.prepare(`
      INSERT INTO call_edges
        (file_path, caller, caller_line, callee, call_line, resolution, target_line)
      VALUES
        (@filePath, @caller, @callerLine, @callee, @callLine, @resolution, @targetLine)
    `);

    for (const call of normalized) {
      insert.run({ filePath, ...call });
    }

    return normalized.length;
  });

  return transaction();
}

function getCallEdgesForFile(db, filePath) {
  ensureCallEdgesSchema(db);

  return db.prepare(`
    SELECT file_path AS filePath,
           caller,
           caller_line AS callerLine,
           callee,
           call_line AS callLine,
           resolution,
           target_line AS targetLine
    FROM call_edges
    WHERE file_path = ?
    ORDER BY call_line, id
  `).all(filePath);
}

module.exports = {
  ensureCallEdgesSchema,
  replaceCallEdgesForFile,
  getCallEdgesForFile
};
