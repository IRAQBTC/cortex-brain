'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { builtinModules } = require('node:module');
const { buildDependencyGraph } = require('./dependency-graph');
const db = require('./db');

function readJson(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function getPackageName(specifier) {
  if (
    !specifier ||
    specifier.startsWith('.') ||
    specifier.startsWith('/') ||
    specifier.startsWith('#') ||
    specifier.startsWith('@/') ||
    specifier.startsWith('node:')
  ) {
    if (specifier && specifier.startsWith('node:')) {
      return specifier.slice(5).split('/')[0] || null;
    }
    return null;
  }

  if (specifier.startsWith('@')) {
    const parts = specifier.split('/');
    return parts.length >= 2 && parts[1]
      ? `${parts[0]}/${parts[1]}`
      : null;
  }

  return specifier.split('/')[0] || null;
}

function getDeclaredPackages(manifest) {
  return new Set([
    ...Object.keys(manifest.dependencies || {}),
    ...Object.keys(manifest.devDependencies || {}),
    ...Object.keys(manifest.optionalDependencies || {}),
    ...Object.keys(manifest.peerDependencies || {})
  ]);
}

const builtins = new Set([
  ...builtinModules,
  ...builtinModules.map(name => `node:${name}`)
]);

function classifyImport(specifier, source, context) {
  const normalizedSource = String(source || '').replace(/\\/g, '/');
  const value = String(specifier || '');
  const isExtensionSource =
    normalizedSource === 'vscode-extension' ||
    normalizedSource.startsWith('vscode-extension/');

  const packageName = getPackageName(value);
  const declaredPackages = isExtensionSource
    ? context.extensionPackages
    : context.rootPackages;

  if (
    value === 'vscode' &&
    isExtensionSource &&
    context.extensionEntryExists &&
    context.extensionEngineDeclared
  ) {
    return 'host_provided_dependency';
  }

  if (builtins.has(value)) {
    return 'node_builtin';
  }

  if (value.startsWith('@/')) {
    return 'project_alias_requires_configuration';
  }

  if (value.startsWith('.') || value.startsWith('/')) {
    return 'relative_import_not_resolved';
  }

  if (packageName && declaredPackages.has(packageName)) {
    return 'declared_package_dependency';
  }

  // Not declared in the applicable manifest does not prove the package
  // is missing from disk or unavailable at runtime.
  return 'unknown_bare_import';
}

function buildDependencyAuditReport() {
  const graph = buildDependencyGraph();
  const root = graph.root;
  const manifest = readJson(path.join(root, 'package.json'));

  const extensionDir = path.join(root, 'vscode-extension');
  const extensionManifestPath = path.join(extensionDir, 'package.json');
  const extensionManifest = readJson(extensionManifestPath);

  const extensionEntry = String(extensionManifest.main || './extension.js')
    .replace(/^\.\//, '')
    .replace(/\\/g, '/');

  const extensionEntryExists = fs.existsSync(
    path.join(extensionDir, extensionEntry)
  );

  const extensionManifestFound = fs.existsSync(extensionManifestPath);
  const extensionEngineDeclared = Boolean(extensionManifest.engines?.vscode);

  const context = {
    rootPackages: getDeclaredPackages(manifest),
    extensionPackages: getDeclaredPackages(extensionManifest),
    extensionEntryExists,
    extensionEngineDeclared
  };

  const categories = Object.create(null);
  const examples = Object.create(null);
  const unresolved = Array.isArray(graph.unresolved) ? graph.unresolved : [];

  for (const item of unresolved) {
    const specifier = String(
      item.specifier || item.target || item.import || ''
    );
    const source = String(item.source || item.from || '')
      .replace(/\\/g, '/');

    const category = classifyImport(specifier, source, context);
    const packageName = getPackageName(specifier);

    if (!categories[category]) {
      categories[category] = {
        importOccurrences: 0,
        specifiers: new Set(),
        packages: new Set()
      };
      examples[category] = [];
    }

    const bucket = categories[category];
    bucket.importOccurrences++;

    if (specifier) bucket.specifiers.add(specifier);
    if (packageName) bucket.packages.add(packageName);

    if (examples[category].length < 12) {
      examples[category].push({
        source,
        specifier,
        kind: String(item.kind || 'import')
      });
    }
  }

  const classificationSummary = {};

  for (const [category, value] of Object.entries(categories)) {
    classificationSummary[category] = {
      importOccurrences: value.importOccurrences,
      uniqueSpecifiers: value.specifiers.size,
      uniquePackages: value.packages.size
    };
  }

  let integrityResult = 'unavailable';

  try {
    const integrityRow = db.prepare('PRAGMA integrity_check').get();
    integrityResult = integrityRow
      ? String(Object.values(integrityRow)[0])
      : 'unavailable';
  } catch {
    integrityResult = 'check_failed';
  }

  return {
    root,
    indexedFiles: Number.isFinite(graph.indexedFileCount)
      ? graph.indexedFileCount
      : (Array.isArray(graph.files) ? graph.files.length : null),
    resolvedLocalImports: Array.isArray(graph.edges)
      ? graph.edges.length
      : null,
    unresolvedEntriesReviewed: unresolved.length,
    indexTimestamp: graph.indexedAt || null,
    extensionManifestFound,
    extensionEngineDeclared,
    extensionEntry,
    extensionEntryExists,
    databaseWritesPerformed: null,
    databaseWriteStatus:
      'NOT_MEASURED: db.js is imported by the dependency graph; this report does not instrument or prove absence of initialization writes.',
    methodology:
      'Static classification of unresolved indexed imports using Node built-ins, the applicable root or VS Code extension package manifest, and extension host metadata. Unknown bare imports are not proof of missing packages. Installed-package resolution, runtime behavior, vulnerabilities, and complete dependency correctness are not verified.',
    classificationSummary,
    examples,
    integrity: {
      result: integrityResult,
      passed: integrityResult.toLowerCase() === 'ok'
    }
  };
}

module.exports = {
  buildDependencyAuditReport,
  getPackageName,
  classifyImport,
  getDeclaredPackages
};
