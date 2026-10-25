"use strict";

const path = require("node:path");
const { extractLocalCalls } = require("./call-graph");
const { getNamedExportNames, getNamedImports } = require("./cross-file-symbols");

function normalizePath(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\.\/+/, "")
    .toLowerCase();
}

function languageFor(filePath) {
  const ext = path.posix.extname(
    String(filePath).replace(/\\/g, "/")
  ).toLowerCase();

  if (ext === ".py") return "python";
  if ([".js", ".mjs", ".cjs", ".jsx"].includes(ext)) return "javascript";
  if ([".ts", ".tsx"].includes(ext)) return "typescript";
  return null;
}

function tableExists(db, tableName) {
  return Boolean(db.prepare(`
    SELECT 1
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
  `).get(tableName));
}

function resolveIndexedImport(sourceFile, specifier, indexedPaths) {
  const raw = String(specifier || "").replace(/\\/g, "/");

  // Resolve only explicit relative JavaScript/TypeScript imports.
  // Package names, aliases and Python module names are not guessed.
  if (!raw.startsWith("./") && !raw.startsWith("../")) return null;

  const base = path.posix.normalize(
    path.posix.join(path.posix.dirname(sourceFile.replace(/\\/g, "/")), raw)
  );

  const ext = path.posix.extname(base);
  const candidates = ext
    ? [base]
    : [
        base,
        `${base}.js`,
        `${base}.mjs`,
        `${base}.cjs`,
        `${base}.jsx`,
        `${base}.ts`,
        `${base}.tsx`,
        `${base}/index.js`,
        `${base}/index.ts`,
        `${base}/index.tsx`
      ];

  for (const candidate of candidates) {
    const wanted = normalizePath(candidate);
    const found = indexedPaths.get(wanted);
    if (found) return found;
  }

  return null;
}

function getImportingFiles(db, targetFilePath, fileNodes) {
  const result = {
    available: false,
    importers: new Set(),
    examinedEdges: 0
  };

  if (!tableExists(db, "edges")) return result;

  const columns = db.prepare("PRAGMA table_info('edges')").all();
  const names = new Set(columns.map(column => column.name));
  if (!names.has("source") || !names.has("target") || !names.has("kind")) {
    return result;
  }

  result.available = true;

  const indexedPaths = new Map();
  for (const file of fileNodes) {
    indexedPaths.set(normalizePath(file.file_path), file.file_path);
  }

  const targetNormalized = normalizePath(targetFilePath);
  const edges = db.prepare(`
    SELECT source, target
    FROM edges
    WHERE kind = 'imports'
  `).all();

  for (const edge of edges) {
    result.examinedEdges++;

    const source = String(edge.source || "").replace(/\\/g, "/");
    const specifier = String(edge.target || "").replace(/\\/g, "/");

    const resolved = resolveIndexedImport(source, specifier, indexedPaths);
    if (!resolved) continue;

    if (normalizePath(resolved) === targetNormalized) {
      result.importers.add(normalizePath(source));
    }
  }

  return result;
}

function findBlastRadius(db, options) {
  const name = typeof options?.name === "string" ? options.name.trim() : "";
  const requestedPath = typeof options?.file_path === "string"
    ? options.file_path.trim()
    : "";

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
    candidates = candidates.filter(
      row => normalizePath(row.file_path) === wanted
    );
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

  const targetInfo = {
    name: target.name,
    kind: target.kind,
    file_path: target.file_path,
    line: target.line
  };

  if (!fileNode) {
    return {
      status: "unavailable",
      target: targetInfo,
      message: "The indexed source-file content is unavailable."
    };
  }

  const targetLanguage = languageFor(target.file_path);
  if (!targetLanguage) {
    return {
      status: "unsupported",
      target: targetInfo,
      message: "This file extension is not supported by the local call-graph resolver."
    };
  }

  const targetAnalysis = extractLocalCalls(String(fileNode.content), targetLanguage);

  if (targetAnalysis.unsupportedLanguage) {
    return {
      status: "unsupported",
      target: targetInfo,
      message: "The call-graph resolver does not support this language."
    };
  }

  const targetDeclaration = targetAnalysis.declarations.find(
    declaration =>
      declaration.name === target.name &&
      Number(declaration.line) === Number(target.line) &&
      !declaration.isAnonymous
  );

  if (!targetDeclaration) {
    return {
      status: "stale_or_unmatched",
      target: targetInfo,
      syntaxErrors: targetAnalysis.hasSyntaxErrors,
      message: "The indexed symbol could not be matched to a declaration in the indexed file content. Re-indexing may be required."
    };
  }

  const callers = [];
  const crossFileCandidates = [];
  const unresolved = [];
  let syntaxErrors = Boolean(targetAnalysis.hasSyntaxErrors);

  function callerDetails(call, analysis, filePath) {
    const declaration = analysis.declarations.find(
      item =>
        item.name === call.caller &&
        Number(item.line) === Number(call.callerLine)
    );

    return {
      caller: declaration?.isAnonymous
        ? "anonymous callback"
        : (call.caller || "unknown caller"),
      callerLine: call.callerLine,
      callLine: call.line,
      callerKind: declaration?.kind || null,
      callerIsAnonymous: Boolean(declaration?.isAnonymous),
      file_path: filePath
    };
  }

  // Preserve the existing same-file resolution behavior.
  for (const call of targetAnalysis.calls) {
    if (call.callee !== target.name) continue;

    const isCandidate =
      call.resolution === "unique_name_candidate" &&
      Number(call.targetLine) === Number(target.line);

    if (!isCandidate) {
      unresolved.push({
        ...callerDetails(call, targetAnalysis, target.file_path),
        resolution: call.resolution
      });
      continue;
    }

    callers.push({
      ...callerDetails(call, targetAnalysis, target.file_path),
      resolution: "same_file_unique_name_candidate"
    });
  }

  // Cross-file candidates require a matching named export and named import.
  // Import aliases are mapped to their local identifier before checking calls.
  const importInfo = getImportingFiles(db, target.file_path, fileNodes);
  let crossFileFilesAnalyzed = 0;
  let crossFileSyntaxErrorCount = 0;

  if (importInfo.available) {
    const targetFileKey = normalizePath(target.file_path);
    const targetSource = fileNodes.find(
      row => normalizePath(row.file_path) === targetFileKey
    );

    const exportedNames = targetSource
      ? getNamedExportNames(String(targetSource.content), target.name)
      : new Set();

    for (const importerKey of importInfo.importers) {
      if (importerKey === targetFileKey) continue;

      const importer = fileNodes.find(
        row => normalizePath(row.file_path) === importerKey
      );
      if (!importer) continue;

      const language = languageFor(importer.file_path);
      if (!language || !["javascript", "typescript"].includes(language)) continue;

      const analysis = extractLocalCalls(String(importer.content), language);
      if (analysis.unsupportedLanguage) continue;

      crossFileFilesAnalyzed++;

      if (analysis.hasSyntaxErrors) {
        syntaxErrors = true;
        crossFileSyntaxErrorCount++;
      }

      const bindings = getNamedImports(
        String(importer.content),
        importer.file_path,
        target.file_path,
        fileNodes,
        exportedNames
      );

      for (const binding of bindings) {
        for (const call of analysis.calls) {
          if (call.callee !== binding.localName) continue;

          // A locally resolved callable is not attributed to the import.
          if (call.resolution !== "unresolved_name") continue;

          crossFileCandidates.push({
            ...callerDetails(call, analysis, importer.file_path),
            resolution: "cross_file_named_import_candidate",
            evidence: "target_named_export_matches_imported_name",
            importedName: binding.importedName,
            localName: binding.localName,
            confidence: "import_export_match_scope_not_fully_verified"
          });
        }
      }
    }
  }
  const status =
    syntaxErrors || unresolved.length
      ? "partial"
      : "analyzed";

  const hasCrossFileSupport = importInfo.available;

  return {
    status,
    target: targetInfo,
    scope: hasCrossFileSupport
      ? "Same-file direct identifier calls plus direct-importer cross-file name candidates."
      : "Same-file direct identifier calls only; cross-file import edges are unavailable.",
    confidence: "Static candidate analysis; cross-file name matches are not verified symbol bindings and no runtime or type analysis is performed.",
    callers,
    crossFileCandidates,
    unresolvedMatchingCalls: unresolved,
    coverage: {
      filesAnalyzed: 1 + crossFileFilesAnalyzed,
      syntaxErrors,
      unresolvedMatchingCallCount: unresolved.length,
      crossFileCallsAnalyzed: hasCrossFileSupport,
      crossFileFilesAnalyzed,
      crossFileImportEdgesExamined: importInfo.examinedEdges,
      importAliasCandidatesDetected: crossFileCandidates.some(candidate => candidate.importedName !== candidate.localName),
      crossFileSyntaxErrorCount,
      memberCallsAnalyzed: false,
      dynamicDispatchAnalyzed: false,
      importAliasesResolved: false,
      reExportsResolved: false,
      typeBindingsVerified: false
    },
    message:
      callers.length || crossFileCandidates.length
        ? "Potential callers were found. Cross-file matches are candidates, not confirmed symbol references."
        : "No callers were resolved by this analysis. This does not establish that changing the symbol is safe."
  };
}

module.exports = { findBlastRadius };