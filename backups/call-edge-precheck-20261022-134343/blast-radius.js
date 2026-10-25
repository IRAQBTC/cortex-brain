"use strict";

const path = require("node:path");
const { extractLocalCalls } = require("./call-graph");

function normalizePath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\.\/+/, "").toLowerCase();
}

function languageFor(filePath) {
  const ext = path.posix.extname(String(filePath).replace(/\\/g, "/")).toLowerCase();
  if (ext === ".py") return "python";
  if ([".js", ".mjs", ".cjs", ".jsx"].includes(ext)) return "javascript";
  if ([".ts", ".tsx"].includes(ext)) return "typescript";
  return null;
}

function findBlastRadius(db, options) {
  const name = typeof options?.name === "string" ? options.name.trim() : "";
  const requestedPath = typeof options?.file_path === "string" ? options.file_path.trim() : "";

  if (!name) throw new Error("Missing or invalid 'name' argument.");
  if (options?.file_path != null && typeof options.file_path !== "string") {
    throw new Error("'file_path' must be a string when supplied.");
  }

  let candidates = db.prepare(`
    SELECT id, file_path, name, kind, line
    FROM nodes
    WHERE name = ? AND kind IN ('function', 'method')
    ORDER BY file_path, line, id
  `).all(name);

  if (requestedPath) {
    const wanted = normalizePath(requestedPath);
    candidates = candidates.filter(row => normalizePath(row.file_path) === wanted);
  }

  if (candidates.length === 0) {
    return {
      status: "not_found",
      targetName: name,
      requestedFilePath: requestedPath || null,
      message: "No matching indexed function or method was found. Class declarations are not supported by this call-graph resolver."
    };
  }

  if (candidates.length > 1) {
    return {
      status: "ambiguous",
      targetName: name,
      candidates: candidates.map(row => ({
        file_path: row.file_path,
        line: row.line,
        kind: row.kind
      })),
      message: "Multiple definitions match this name. Supply file_path to select the intended definition."
    };
  }

  const target = candidates[0];
  const fileNodes = db.prepare(`
    SELECT id, file_path, content
    FROM nodes
    WHERE kind = 'file' AND content IS NOT NULL
  `).all();

  const fileNode = fileNodes.find(
    row => normalizePath(row.file_path) === normalizePath(target.file_path)
  );

  if (!fileNode) {
    return {
      status: "unavailable",
      target: { name: target.name, file_path: target.file_path, line: target.line },
      message: "The indexed source-file content is unavailable."
    };
  }

  const language = languageFor(target.file_path);
  if (!language) {
    return {
      status: "unsupported",
      target: { name: target.name, file_path: target.file_path, line: target.line },
      message: "This file extension is not supported by the local call-graph resolver."
    };
  }

  const analysis = extractLocalCalls(String(fileNode.content), language);
  if (analysis.unsupportedLanguage) {
    return {
      status: "unsupported",
      target: { name: target.name, file_path: target.file_path, line: target.line },
      message: "The call-graph resolver does not support this language."
    };
  }

  const targetDeclaration = analysis.declarations.find(
    declaration => declaration.name === target.name &&
      declaration.line === Number(target.line) &&
      !declaration.isAnonymous
  );

  if (!targetDeclaration) {
    return {
      status: "stale_or_unmatched",
      target: { name: target.name, file_path: target.file_path, line: target.line },
      syntaxErrors: analysis.hasSyntaxErrors,
      message: "The indexed symbol could not be matched to a declaration in the indexed file content. Re-indexing may be required."
    };
  }

  const callers = [];
  const unresolved = [];

  for (const call of analysis.calls) {
    if (call.callee !== target.name) continue;

    const isCandidate =
      call.resolution === "unique_name_candidate" &&
      Number(call.targetLine) === Number(target.line);

    if (!isCandidate) {
      unresolved.push({
        caller: call.caller,
        callerLine: call.callerLine,
        callLine: call.line,
        resolution: call.resolution
      });
      continue;
    }

    const callerDeclaration = analysis.declarations.find(
      declaration => declaration.name === call.caller &&
        declaration.line === Number(call.callerLine)
    );

    callers.push({
      caller: callerDeclaration?.isAnonymous
        ? "anonymous callback"
        : (call.caller || "unknown caller"),
      callerLine: call.callerLine,
      callLine: call.line,
      callerKind: callerDeclaration?.kind || null,
      callerIsAnonymous: Boolean(callerDeclaration?.isAnonymous),
      resolution: "same_file_unique_name_candidate"
    });
  }

  return {
    status: analysis.hasSyntaxErrors || unresolved.length ? "partial" : "analyzed",
    target: {
      name: target.name,
      kind: target.kind,
      file_path: target.file_path,
      line: target.line
    },
    scope: "Same-file direct identifier calls only.",
    confidence: "Static candidate analysis; not runtime- or type-verified.",
    callers,
    unresolvedMatchingCalls: unresolved,
    coverage: {
      filesAnalyzed: 1,
      syntaxErrors: analysis.hasSyntaxErrors,
      unresolvedMatchingCallCount: unresolved.length,
      crossFileCallsAnalyzed: false,
      memberCallsAnalyzed: false,
      dynamicDispatchAnalyzed: false
    },
    message: callers.length
      ? "Potential same-file callers were found."
      : "No same-file callers were resolved by this analysis. This does not establish that changing the symbol is safe."
  };
}

module.exports = { findBlastRadius };