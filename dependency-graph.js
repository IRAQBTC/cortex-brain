'use strict';

const path = require('node:path');
const fs = require('node:fs');
const db = require('./db');
const parser = require('./parser');
const { extractImports } = require('./scanner');

const EXTENSIONS = [
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py'
];

function normalize(value) {
  return value.split(path.sep).join('/');
}

function getIndexedProject() {
  const metadata = db.prepare(`
    SELECT root_path, indexed_at, files
    FROM index_metadata
    WHERE id = 1
  `).get();

  if (!metadata) {
    throw new Error('Index metadata is missing. Run the scanner first.');
  }

  const root = path.resolve(metadata.root_path);

  const rows = db.prepare(`
    SELECT file_path, content
    FROM nodes
    WHERE kind = 'file'
    ORDER BY file_path
  `).all();

  const files = new Map();

  for (const row of rows) {
    const relativePath = normalize(row.file_path);
    files.set(relativePath, {
      path: relativePath,
      content: row.content
    });
  }

  return {
    root,
    indexedAt: metadata.indexed_at,
    indexedFileCount: metadata.files,
    files
  };
}

function isInsideRoot(root, candidate) {
  const relative = path.relative(root, candidate);

  return relative === '' ||
    (!relative.startsWith('..' + path.sep) &&
     relative !== '..' &&
     !path.isAbsolute(relative));
}

function existingIndexedPath(candidate, root, indexedFiles) {
  const absolute = path.resolve(candidate);

  if (!isInsideRoot(root, absolute)) {
    return null;
  }

  const relative = normalize(path.relative(root, absolute));

  if (indexedFiles.has(relative)) {
    return relative;
  }

  for (const extension of EXTENSIONS) {
    const withExtension = relative + extension;

    if (indexedFiles.has(withExtension)) {
      return withExtension;
    }
  }

  for (const extension of EXTENSIONS) {
    const indexFile = normalize(
      path.join(relative, 'index' + extension)
    );

    if (indexedFiles.has(indexFile)) {
      return indexFile;
    }
  }

  return null;
}

function resolveJavaScriptImport(importer, specifier, root, indexedFiles) {
  if (!specifier.startsWith('.')) {
    // Package imports and aliases are not assumed to be local files.
    return null;
  }

  const importerAbsolute = path.resolve(root, importer);
  const candidate = path.resolve(
    path.dirname(importerAbsolute),
    specifier
  );

  return existingIndexedPath(candidate, root, indexedFiles);
}

function resolvePythonImport(importer, specifier, root, indexedFiles) {
  const importerAbsolute = path.resolve(root, importer);
  const importerDirectory = path.dirname(importerAbsolute);

  let dots = 0;

  while (specifier[dots] === '.') {
    dots++;
  }

  const moduleName = specifier.slice(dots);
  let baseDirectory;

  if (dots > 0) {
    // Python relative imports: one dot means current package.
    baseDirectory = importerDirectory;

    for (let i = 1; i < dots; i++) {
      baseDirectory = path.dirname(baseDirectory);
    }
  } else {
    // Resolve only when a project file matches; never assume an
    // unqualified Python module is part of this project.
    baseDirectory = root;
  }

  const modulePath = moduleName
    ? moduleName.split('.').join(path.sep)
    : '';

  const candidate = path.resolve(baseDirectory, modulePath);

  return existingIndexedPath(candidate, root, indexedFiles);
}

function buildDependencyGraph() {
  const project = getIndexedProject();
  const edges = [];
  const unresolved = [];

  for (const file of project.files.values()) {
    const absolutePath = path.resolve(project.root, file.path);

    if (!isInsideRoot(project.root, absolutePath)) {
      continue;
    }

    const language = parser.detectLanguage(absolutePath);

    if (!language) {
      continue;
    }

    const specifiers = extractImports(file.content, language);

    for (const specifier of specifiers) {
      const target = language === 'python'
        ? resolvePythonImport(
            file.path, specifier, project.root, project.files
          )
        : resolveJavaScriptImport(
            file.path, specifier, project.root, project.files
          );

      if (target) {
        edges.push({
          source: file.path,
          target,
          specifier,
          kind: 'local_import',
          evidence: 'resolved_to_indexed_file'
        });
      } else {
        unresolved.push({
          source: file.path,
          specifier,
          classification: specifier.startsWith('.')
            ? 'unresolved_relative_import'
            : 'external_or_unresolved_import'
        });
      }
    }
  }

  return {
    root: project.root,
    indexedAt: project.indexedAt,
    indexedFileCount: project.files.size,
    files: project.files,
    edges,
    unresolved
  };
}

function analyzeFileImpact(targetPath, graph) {
  const normalizedTarget = normalize(targetPath).replace(/^\.\/+/, '');
  const knownFiles = new Set();

  for (const edge of graph.edges) {
    knownFiles.add(edge.source);
    knownFiles.add(edge.target);
  }

  // Include isolated indexed files by validating against the DB index.
  const project = getIndexedProject();

  if (!project.files.has(normalizedTarget)) {
    throw new Error(
      `Target file is not present in the index: ${normalizedTarget}`
    );
  }

  const reverse = new Map();

  for (const edge of graph.edges) {
    if (!reverse.has(edge.target)) {
      reverse.set(edge.target, new Set());
    }

    reverse.get(edge.target).add(edge.source);
  }

  const visited = new Set([normalizedTarget]);
  const queue = [normalizedTarget];
  const impact = [];

  while (queue.length > 0) {
    const current = queue.shift();
    const dependents = [...(reverse.get(current) || [])].sort();

    for (const dependent of dependents) {
      if (visited.has(dependent)) {
        continue;
      }

      visited.add(dependent);
      queue.push(dependent);
      impact.push({
        file: dependent,
        dependsOn: current,
        relationship: current === normalizedTarget ? 'direct_local_import' : 'transitive_local_import'
      });
    }
  }

  return {
    target: normalizedTarget,
    directDependents: [...(reverse.get(normalizedTarget) || [])].sort(),
    affectedFiles: impact,
    affectedFileCount: impact.length,
    method: 'resolved_local_import_graph',
    limitations: [
      'File-level impact only; this is not symbol-level impact.',
      'Only imports resolved to indexed project files are included.',
      'Dynamic imports, aliases, package exports and runtime behavior may be missed.',
      'Results describe the indexed snapshot, not necessarily current disk contents.',
      'No affected files does not prove a change is safe.'
    ]
  };
}

function main() {
  const graph = buildDependencyGraph();
  const target = process.argv[2];

  console.log('=== CORTEX LOCAL DEPENDENCY GRAPH ===');
  console.log(`Root: ${graph.root}`);
  console.log(`Indexed files: ${graph.indexedFileCount}`);
  console.log(`Resolved local imports: ${graph.edges.length}`);
  console.log(`Unresolved/external imports: ${graph.unresolved.length}`);
  console.log(`Index timestamp: ${graph.indexedAt}`);

  if (target) {
    const report = analyzeFileImpact(target, graph);

    console.log('\n=== CHANGE IMPACT REPORT ===');
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('\nUsage: node dependency-graph.js <indexed-relative-file>');
    console.log('Example: node dependency-graph.js server.js');
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[CORTEX DEPENDENCY GRAPH FAILED] ${error.message}`);
    process.exitCode = 1;
  } finally {
    db.close();
  }
}

module.exports = {
  buildDependencyGraph,
  analyzeFileImpact,
  resolveJavaScriptImport,
  resolvePythonImport
};
