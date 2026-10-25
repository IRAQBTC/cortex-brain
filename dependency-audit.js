'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { builtinModules } = require('node:module');
const db = require('./db');
const { buildDependencyGraph } = require('./dependency-graph');

const extensions = ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py'];
const builtins = new Set(
  builtinModules.flatMap(name => [
    name,
    name.replace(/^node:/, ''),
    `node:${name.replace(/^node:/, '')}`
  ])
);

function normalize(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function packageName(specifier) {
  if (specifier.startsWith('@')) {
    const parts = specifier.split('/');
    return parts.length >= 2
      ? `${parts[0]}/${parts[1]}`
      : specifier;
  }
  return specifier.split('/')[0];
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function packageSet(manifest) {
  return new Set([
    ...Object.keys(manifest?.dependencies || {}),
    ...Object.keys(manifest?.devDependencies || {}),
    ...Object.keys(manifest?.optionalDependencies || {}),
    ...Object.keys(manifest?.peerDependencies || {})
  ]);
}

function indexedLocalMatch(source, specifier, indexedFiles, root) {
  const sourceDir = path.posix.dirname(normalize(source));
  const isRelative = specifier.startsWith('.');
  const isPython = source.endsWith('.py');

  if (!isRelative && !isPython) return false;

  const modulePath = isPython
    ? specifier.replace(/\./g, '/')
    : specifier;

  const bases = isRelative
    ? [path.posix.normalize(path.posix.join(sourceDir, modulePath))]
    : [
        path.posix.normalize(path.posix.join(sourceDir, modulePath)),
        path.posix.normalize(modulePath)
      ];

  for (const base of bases) {
    const candidates = [
      base,
      ...extensions.map(ext => base + ext),
      ...extensions.map(ext => path.posix.join(base, 'index' + ext))
    ];

    if (candidates.some(candidate => indexedFiles.has(normalize(candidate)))) {
      return true;
    }
  }

  if (isRelative) {
    const absoluteBase = path.resolve(root, sourceDir, modulePath);
    const diskCandidates = [
      absoluteBase,
      ...extensions.map(ext => absoluteBase + ext),
      ...extensions.map(ext => path.join(absoluteBase, 'index' + ext))
    ];

    return diskCandidates.some(candidate => {
      try {
        return fs.statSync(candidate).isFile();
      } catch {
        return false;
      }
    });
  }

  return false;
}

function main() {
  const graph = buildDependencyGraph();

  const metadata = db.prepare(`
    SELECT root_path, indexed_at
    FROM index_metadata
    LIMIT 1
  `).get();

  if (!metadata) {
    throw new Error('Index metadata is missing.');
  }

  const root = path.resolve(metadata.root_path);
  const indexedFiles = new Set(
    db.prepare("SELECT file_path FROM nodes WHERE kind = 'file'")
      .all()
      .map(row => normalize(row.file_path))
  );

  const rootManifestPath = path.join(root, 'package.json');
  const rootManifest = readJson(rootManifestPath);

  if (!rootManifest) {
    throw new Error('Root package.json is missing or invalid.');
  }

  const rootPackages = packageSet(rootManifest);
  const extensionDir = path.join(root, 'vscode-extension');
  const extensionManifestPath = path.join(extensionDir, 'package.json');
  const extensionManifest = readJson(extensionManifestPath);
  const extensionPackages = packageSet(extensionManifest);

  const extensionMain = extensionManifest?.main
    ? normalize(path.posix.join(
        'vscode-extension',
        extensionManifest.main
      ))
    : null;

  const extensionEngineDeclared =
    typeof extensionManifest?.engines?.vscode === 'string' &&
    extensionManifest.engines.vscode.length > 0;

  const counts = {};
  const uniqueSpecifiers = {};
  const uniquePackages = {};
  const examples = {};

  function record(category, item) {
    counts[category] = (counts[category] || 0) + 1;

    if (!uniqueSpecifiers[category]) {
      uniqueSpecifiers[category] = new Set();
      uniquePackages[category] = new Set();
      examples[category] = [];
    }

    uniqueSpecifiers[category].add(item.specifier);
    uniquePackages[category].add(packageName(item.specifier));

    if (examples[category].length < 12) {
      examples[category].push(
        `${item.source} -> ${item.specifier}`
      );
    }
  }

  for (const item of graph.unresolved) {
    const specifier = String(item.specifier || '');
    const source = normalize(item.source);
    let category;

    const isExtensionSource =
      source === 'vscode-extension' ||
      source.startsWith('vscode-extension/');

    const isExtensionEntry =
      extensionEngineDeclared &&
      extensionMain &&
      source === extensionMain &&
      isExtensionSource;

    if (
      specifier === 'vscode' &&
      isExtensionEntry
    ) {
      category = 'host_provided_dependency';
    } else if (
      specifier.startsWith('.') &&
      indexedLocalMatch(source, specifier, indexedFiles, root)
    ) {
      category = 'local_file_found_but_graph_did_not_resolve';
    } else if (specifier.startsWith('.')) {
      category = 'relative_import_not_found';
    } else if (builtins.has(specifier)) {
      category = 'node_builtin';
    } else if (specifier.startsWith('@/')) {
      category = 'project_alias_requires_configuration';
    } else if (
      source.endsWith('.py') &&
      indexedLocalMatch(source, specifier, indexedFiles, root)
    ) {
      category = 'python_local_module_not_resolved';
    } else {
      const name = packageName(specifier);
      const sourcePackages = isExtensionSource
        ? extensionPackages
        : rootPackages;

      if (sourcePackages.has(name)) {
        category = 'declared_package_dependency';
      } else {
        category = 'unknown_bare_import';
      }
    }

    record(category, { source, specifier });
  }

  const summary = {};
  for (const category of Object.keys(counts).sort()) {
    summary[category] = {
      importOccurrences: counts[category],
      uniqueSpecifiers: uniqueSpecifiers[category].size,
      uniquePackageNames: uniquePackages[category].size
    };
  }

  console.log('\n=== READ-ONLY DEPENDENCY AUDIT ===');
  console.log(JSON.stringify({
    root,
    indexedFiles: graph.indexedFileCount,
    resolvedLocalImports: graph.edges.length,
    unresolvedEntriesReviewed: graph.unresolved.length,
    indexTimestamp: graph.indexedAt,
    auditFileIndexed: indexedFiles.has('dependency-audit.js'),
    extensionManifestFound: Boolean(extensionManifest),
    extensionEngineDeclared,
    extensionEntry: extensionMain,
    databaseWritesPerformed: false
  }, null, 2));

  console.log('\n=== CLASSIFICATION SUMMARY ===');
  console.log(JSON.stringify(summary, null, 2));

  console.log('\n=== EXAMPLES BY CLASSIFICATION ===');
  for (const [category, items] of Object.entries(examples)) {
    console.log(`\n[${category}]`);
    for (const item of items) console.log(`  ${item}`);
  }

  console.log('\n=== INTEGRITY CHECK ===');
  const integrity = db.pragma('integrity_check');
  console.log(JSON.stringify(integrity));

  if (
    integrity.length !== 1 ||
    integrity[0].integrity_check !== 'ok'
  ) {
    throw new Error('SQLite integrity check failed.');
  }
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
} finally {
  db.close();
}