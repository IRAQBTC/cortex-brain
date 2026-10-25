'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function tableExists(db, name) {
  return Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?"
  ).get(name));
}

function getTableColumns(db, table) {
  if (!['nodes', 'edges', 'index_metadata'].includes(table)) return [];
  if (!tableExists(db, table)) return [];
  return db.prepare(`PRAGMA table_info("${table}")`).all().map(row => row.name);
}

function safeRows(db, sql) {
  try {
    return db.prepare(sql).all();
  } catch (error) {
    return {
      available: false,
      reason: error.message
    };
  }
}

function detectRoutes(projectRoot) {
  const serverPath = path.join(projectRoot, 'server.js');

  if (!fs.existsSync(serverPath)) {
    return { status: 'unavailable', routes: [] };
  }

  const source = fs.readFileSync(serverPath, 'utf8');
  const routes = [];
  const pattern =
    /\bapp\.(get|post|put|patch|delete|use)\s*\(\s*(['"`])([^'"`]+)\2/g;

  let match;

  while ((match = pattern.exec(source)) !== null) {
    routes.push({
      method: match[1].toUpperCase(),
      path: match[3],
      evidence: 'static source pattern',
      line: source.slice(0, match.index).split(/\r?\n/).length
    });
  }

  return {
    status: 'static_source_detection_only',
    routes
  };
}

function buildContextPackage({ projectRoot, db, projectName }) {
  const root = path.resolve(projectRoot);
  const packagePath = path.join(root, 'package.json');

  let pkg = {};
  if (fs.existsSync(packagePath)) {
    try {
      pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    } catch {
      pkg = {};
    }
  }

  const nodeColumns = getTableColumns(db, 'nodes');
  const edgeColumns = getTableColumns(db, 'edges');
  const metadataAvailable = tableExists(db, 'index_metadata');

  const metadata = metadataAvailable
    ? safeRows(db, 'SELECT * FROM index_metadata LIMIT 20')
    : { available: false, reason: 'index_metadata table not found' };

  const counts = {
    files: db.prepare(
      "SELECT COUNT(*) AS count FROM nodes WHERE kind = 'file'"
    ).get().count,
    functions: db.prepare(
      "SELECT COUNT(*) AS count FROM nodes WHERE kind = 'function'"
    ).get().count,
    methods: db.prepare(
      "SELECT COUNT(*) AS count FROM nodes WHERE kind = 'method'"
    ).get().count,
    classes: db.prepare(
      "SELECT COUNT(*) AS count FROM nodes WHERE kind = 'class'"
    ).get().count,
    edges: db.prepare('SELECT COUNT(*) AS count FROM edges').get().count
  };

  const nodes = safeRows(db, `
    SELECT id, kind, name, file_path, signature, line
    FROM nodes
    ORDER BY file_path, line, name
  `);

  const edges = safeRows(db, `
    SELECT source, target, kind
    FROM edges
    ORDER BY kind, source, target
  `);

  const files = safeRows(db, `
    SELECT name, file_path
    FROM nodes
    WHERE kind = 'file'
    ORDER BY file_path
  `);

  const testsDirectory = path.join(root, 'tests');

  const testInventory = {
    directoryExists: fs.existsSync(testsDirectory),
    files: []
  };

  if (testInventory.directoryExists) {
    try {
      testInventory.files = fs.readdirSync(testsDirectory, {
        withFileTypes: true
      })
        .filter(entry =>
          entry.isFile() &&
          /\.(test|spec)\.[cm]?[jt]sx?$/i.test(entry.name)
        )
        .map(entry => entry.name)
        .sort();
    } catch {
      testInventory.readError = true;
    }
  }

  return {
    schemaVersion: '1.0.0',
    packageType: 'cortex-engineering-context',
    generatedAt: new Date().toISOString(),

    project: {
      name: projectName,
      packageName: pkg.name || null,
      version: pkg.version || null,
      description: pkg.description || null,
      root,
      platform: os.platform(),
      runtime: process.version,
      packageManagerEvidence: {
        pnpmLockExists: fs.existsSync(path.join(root, 'pnpm-lock.yaml')),
        npmLockExists: fs.existsSync(path.join(root, 'package-lock.json'))
      }
    },

    commands: pkg.scripts || {},

    index: {
      status: 'NOT_INDEPENDENTLY_CLASSIFIED',
      metadataAvailable,
      metadata,
      counts,
      schema: {
        nodes: nodeColumns,
        edges: edgeColumns
      },
      note: 'Counts describe the current SQLite database. Freshness against every disk file has not been independently established by this package.'
    },

    architecture: {
      sourceFiles: files,
      apiRoutes: detectRoutes(root),
      routeDetectionLimit:
        'Static pattern matching only; routes created dynamically or through routers may be missed.',
      testInventory,
      testStatus: 'NOT_RUN_BY_EXPORT',
      uiInventoryStatus: 'NOT_AUDITED',
      buttonBehaviorStatus: 'NOT_AUDITED'
    },

    codeIndex: {
      nodes,
      edges,
      note: 'Indexed declarations and relationships only. Presence in the index does not prove runtime behavior or correctness.'
    },

    assurance: {
      securityAssessment: 'NOT_PERFORMED_BY_THIS_EXPORT',
      vulnerabilityAbsenceClaimed: false,
      productionReadiness: 'UNVERIFIED',
      implementationStatuses: {
        implemented: 'Requires evidence per feature.',
        tested: 'Requires recorded test execution and result.',
        failed: 'Requires recorded failure evidence.',
        unverified: 'Default until evidence is supplied.'
      }
    },

    limitations: [
      'This export does not execute tests.',
      'Static route detection does not prove that a route works at runtime.',
      'Database records may be stale relative to files on disk.',
      'Call graph edges must not automatically be treated as confirmed runtime calls.',
      'UI button behavior has not been tested by this export.',
      'No security guarantee or production-readiness claim is made.'
    ],

    nextActions: [
      {
        priority: 'P0',
        action: 'Audit source-to-index consistency and explicitly record the result.'
      },
      {
        priority: 'P1',
        action: 'Map every UI page and interactive control to its implemented behavior and API.'
      },
      {
        priority: 'P1',
        action: 'Record test evidence with command, timestamp, and exact pass/fail result.'
      },
      {
        priority: 'P1',
        action: 'Verify MCP entry point and package-manager lockfile strategy.'
      }
    ]
  };
}

module.exports = { buildContextPackage };