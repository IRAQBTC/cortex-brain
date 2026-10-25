'use strict';

const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  buildDependencyGraph,
  analyzeFileImpact
} = require('./dependency-graph');

const EXCLUDED_SEGMENTS = new Set([
  'node_modules', '.git', '.cortex', 'coverage',
  'dist', 'build', 'backups', '__pycache__',
  '.next', '.venv', 'venv'
]);

const EXCLUDED_NAMES = [
  /\.bak$/i,
  /\.backup(?:[-.].*)?$/i,
  /\.before(?:[-.].*)?$/i,
  /\.suspect(?:[-.].*)?$/i,
  /\.rollback(?:[-.].*)?$/i,
  /\.failed-/i,
  /\.pre-[^.]+.*\.bak$/i,
  /\.tmp$/i,
  /^cortex-brain\.db(?:-(?:shm|wal))?$/i,
  /^cortex-brain\.db\.backup-/i,
  /^(?:-|--shm|--wal)$/i,
];

function runGit(root, args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024
  });
}

function normalizeGitPath(value) {
  return value.replace(/\\/g, '/').replace(/^\.\/+/, '');
}

function isExcluded(relativePath) {
  const normalized = normalizeGitPath(relativePath);
  const parts = normalized.split('/');

  if (parts.some(part => EXCLUDED_SEGMENTS.has(part))) {
    return true;
  }

  const name = parts[parts.length - 1] || '';
  return EXCLUDED_NAMES.some(pattern => pattern.test(name));
}

function parseNameStatus(output) {
  const fields = output.split('\0');
  const records = [];
  let i = 0;

  while (i < fields.length && fields[i] !== '') {
    const status = fields[i++];
    const firstPath = fields[i++];

    if (firstPath === undefined) {
      throw new Error('Unexpected truncated output from git diff.');
    }

    if (/^[RC]/.test(status)) {
      const secondPath = fields[i++];
      if (secondPath === undefined) {
        throw new Error('Unexpected truncated rename/copy record from git diff.');
      }

      records.push({
        path: normalizeGitPath(firstPath),
        status: 'D',
        originalStatus: status,
        renameRole: 'old_path'
      });
      records.push({
        path: normalizeGitPath(secondPath),
        status: 'A',
        originalStatus: status,
        renameRole: 'new_path'
      });
    } else {
      records.push({
        path: normalizeGitPath(firstPath),
        status: status[0] || 'U',
        originalStatus: status
      });
    }
  }

  return records;
}

function collectChanges(root) {
  const trackedOutput = runGit(root, [
    'diff', '--name-status', '-z', 'HEAD', '--'
  ]);
  const tracked = parseNameStatus(trackedOutput);

  const untrackedOutput = runGit(root, [
    'ls-files', '--others', '--exclude-standard', '-z'
  ]);

  const untracked = untrackedOutput
    .split('\0')
    .filter(Boolean)
    .map(file => ({
      path: normalizeGitPath(file),
      status: 'U',
      originalStatus: 'UNTRACKED'
    }));

  const byPath = new Map();

  for (const item of [...tracked, ...untracked]) {
    if (!item.path || isExcluded(item.path)) continue;

    // Prefer tracked diff status if the same path appears in both sources.
    if (!byPath.has(item.path) || item.status !== 'U') {
      byPath.set(item.path, item);
    }
  }

  return [...byPath.values()].sort((a, b) =>
    a.path.localeCompare(b.path)
  );
}

function buildChangeIntelligence() {
  const root = runGit(process.cwd(), [
    'rev-parse', '--show-toplevel'
  ]).trim();

  const head = runGit(root, [
    'rev-parse', 'HEAD'
  ]).trim();

  const graph = buildDependencyGraph();
  const changes = collectChanges(root);

  const changedFiles = [];
  const impacted = new Map();
  let analyzedCount = 0;
  let notIndexedCount = 0;
  let failedCount = 0;
  let deletedCount = 0;

  for (const change of changes) {
    const indexed = graph.files.has(change.path);
    const record = {
      path: change.path,
      gitStatus: change.status,
      originalStatus: change.originalStatus,
      indexed: Boolean(indexed),
      analysisStatus: 'not_analyzed',
      impactAvailable: false,
      impactReason: null,
      directDependentCount: 0,
      affectedFileCount: 0,
      directDependents: [],
      affectedFiles: [],
      error: null
    };

    // A deleted file cannot be analyzed as if its current contents
    // still existed in the indexed graph. Zero would imply a completed
    // analysis, so use null to represent an unavailable impact count.
    if (change.status === 'D') {
      deletedCount++;
      record.analysisStatus = 'deleted_not_analyzed';
      record.impactAvailable = false;
      record.impactReason =
        'The file is deleted from the working tree. Impact was not calculated; zero must not be interpreted as no impact.';
      record.directDependentCount = null;
      record.affectedFileCount = null;
      changedFiles.push(record);
      continue;
    }

    if (!indexed) {
      record.analysisStatus = 'not_indexed';
      record.impactAvailable = false;
      record.impactReason =
        'The file is not present in the current index; impact is unavailable.';
      notIndexedCount++;
      changedFiles.push(record);
      continue;
    }

    try {
      const impact = analyzeFileImpact(change.path, graph);

      record.analysisStatus = 'analyzed_index_snapshot';
      record.impactAvailable = true;
      record.impactReason = null;
      record.directDependentCount = impact.directDependents.length;
      record.affectedFileCount = impact.affectedFileCount;
      record.directDependents = impact.directDependents;
      record.affectedFiles = impact.affectedFiles;
      analyzedCount++;

      for (const affected of impact.affectedFiles) {
        if (!impacted.has(affected.file)) {
          impacted.set(affected.file, {
            file: affected.file,
            affectedBy: []
          });
        }

        impacted.get(affected.file).affectedBy.push({
          changedFile: change.path,
          relationship: affected.relationship,
          dependsOn: affected.dependsOn
        });
      }
    } catch (error) {
      record.analysisStatus = 'analysis_failed';
      record.error = error.message;
      failedCount++;
    }

    changedFiles.push(record);
  }

  const impactedFiles = [...impacted.values()]
    .sort((a, b) => a.file.localeCompare(b.file));

  return {
    success: true,
    product: 'Cortex Change Intelligence',
    base: 'HEAD',
    generatedAt: new Date().toISOString(),
    comparison: {
      base: 'HEAD',
      head,
      workingTreeIncluded: true,
      stagedChangesIncluded: true,
      untrackedFilesIncluded: true,
      deletedFilesIncluded: true
    },
    root,
    index: {
      indexedAt: graph.indexedAt,
      indexedFileCount: graph.indexedFileCount,
      resolvedLocalImportCount: graph.edges.length,
      unresolvedImportCount: graph.unresolved.length
    },
    summary: {
      changedFileCount: changedFiles.length,
      analyzedCount,
      notIndexedCount,
      failedCount,
      deletedCount,
      uniqueImpactedFileCount: impactedFiles.length
    },
    changedFiles,
    impactedFiles,
    methodology: [
      'Tracked changes are compared against HEAD, including staged changes.',
      'Untracked files are collected using git ls-files --others --exclude-standard.',
      'Impact analysis reuses the existing resolved local-import graph.',
      'Impact results describe the indexed snapshot, which may differ from current disk contents.',
      'Files absent from the index are reported without inferred impact.',
      'A file with no discovered dependents is not proven safe.'
    ],
    limitations: [
      'File-level import impact only; this is not symbol-level impact.',
      'Dynamic imports, aliases, package exports, reflection and runtime behavior may be missed.',
      'The Git working tree can change while the report is being generated.',
      'Ignored and excluded generated/backup artifacts are not included.',
      'This report does not run tests, execute changed code or certify a release.'
    ]
  };
}

module.exports = { buildChangeIntelligence };