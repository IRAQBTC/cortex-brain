'use strict';

const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const Module = require('node:module');
const path = require('node:path');
const http = require('node:http');

const extensionPath = path.resolve('vscode-extension/extension.js');
const originalLoad = Module._load;
const originalGet = http.get;

const s = {
  command: null, editor: null, apiPayload: null, apiError: null,
  warnings: [], errors: [], info: [], openedPath: null, openedLine: null
};

class Position {
  constructor(line, character) { this.line = line; this.character = character; }
}
class Selection {
  constructor(anchor, active) { this.anchor = anchor; this.active = active; }
}
class Range {
  constructor(start, end) { this.start = start; this.end = end; }
}

const vscode = {
  Position, Selection, Range,
  Uri: { file: fsPath => ({ fsPath }) },
  TextEditorRevealType: { InCenter: 1 },
  ProgressLocation: { Notification: 1 },
  commands: {
    registerCommand(name, callback) {
      s.command = { name, callback };
      return { dispose() {} };
    }
  },
  window: {
    get activeTextEditor() { return s.editor; },
    showWarningMessage: async m => { s.warnings.push(String(m)); },
    showErrorMessage: async m => { s.errors.push(String(m)); },
    showInformationMessage: async (...args) => {
      s.info.push(args);
      return 'Open Location';
    },
    showQuickPick: async items => items[0],
    showInputBox: async () => 'activate',
    withProgress: async (_options, task) => task(),
    showTextDocument: async () => ({
      selection: null,
      revealRange: range => { s.openedLine = range.start.line; }
    })
  },
  workspace: {
    openTextDocument: async uri => {
      s.openedPath = uri.fsPath;
      return { lineCount: 100 };
    }
  }
};

Module._load = function(request, parent, isMain) {
  if (request === 'vscode') return vscode;
  return originalLoad.call(this, request, parent, isMain);
};

let extension;
try {
  extension = require(extensionPath);
} finally {
  Module._load = originalLoad;
}
extension.activate({ subscriptions: [] });

http.get = (_url, callback) => {
  const req = new EventEmitter();
  req.setTimeout = () => req;
  req.destroy = error => {
    if (error) process.nextTick(() => req.emit('error', error));
    return req;
  };

  process.nextTick(() => {
    if (s.apiError) {
      req.emit('error', s.apiError);
      return;
    }
    const response = new EventEmitter();
    response.statusCode = 200;
    response.setEncoding = () => {};
    callback(response);
    process.nextTick(() => {
      response.emit('data', JSON.stringify(s.apiPayload));
      response.emit('end');
    });
  });
  return req;
};

function reset() {
  // Keep the command registered during activate().
  s.editor = null;
  s.apiPayload = null;
  s.apiError = null;
  s.warnings = [];
  s.errors = [];
  s.info = [];
  s.openedPath = null;
  s.openedLine = null;
}

function editorFor(name) {
  return {
    document: {
      getText: range => name,
      getWordRangeAtPosition: () => null
    },
    selection: { active: new Position(0, 0) }
  };
}

function payload(filePath = 'vscode-extension/extension.js') {
  const match = {
    name: 'activate', kind: 'function', filePath, line: 4,
    signature: 'function activate(context)'
  };
  return {
    status: 'VERIFIED',
    matchCount: 1,
    data: match,
    matches: [match],
    index: {
      rootPath: path.resolve('.'),
      indexedAt: '2026-10-22T05:13:55.750Z'
    }
  };
}

let passed = 0;
let failed = 0;

async function test(name, fn) {
  reset();
  try {
    await fn();
    passed++;
    console.log('PASS: ' + name);
  } catch (error) {
    failed++;
    console.log('FAIL: ' + name + ' — ' + error.message);
  }
}

(async () => {
  try {
    await test('command registered', async () => {
      assert.equal(s.command.name, 'cortex.verifyFunction');
    });

    await test('no editor warns safely', async () => {
      await s.command.callback();
      assert.ok(s.warnings.some(m => m.includes('Open a file')));
    });

    await test('VERIFIED opens evidence location and correct line', async () => {
      s.editor = editorFor('activate');
      s.apiPayload = payload();
      await s.command.callback();
      assert.equal(s.info.length, 1);
      assert.equal(s.openedPath, path.resolve('vscode-extension/extension.js'));
      assert.equal(s.openedLine, 3);
    });

    await test('REFUTED warns that absence is not proven', async () => {
      s.editor = editorFor('notPresent');
      s.apiPayload = { status: 'REFUTED', index: { indexedAt: 'test' } };
      await s.command.callback();
      assert.ok(s.warnings.some(m => m.includes('does not prove absence')));
      assert.equal(s.openedPath, null);
    });

    await test('INCONCLUSIVE warns', async () => {
      s.editor = editorFor('activate');
      s.apiPayload = { status: 'INCONCLUSIVE', message: 'Insufficient evidence' };
      await s.command.callback();
      assert.ok(s.warnings.some(m => m.includes('Verification inconclusive')));
    });

    await test('outside-root path is refused', async () => {
      s.editor = editorFor('activate');
      s.apiPayload = payload('../outside.txt');
      await s.command.callback();
      assert.equal(s.openedPath, null);
      assert.ok(s.errors.some(m => m.includes('outside the indexed project root')));
    });

    await test('HTTP connection failure is surfaced', async () => {
      s.editor = editorFor('activate');
      s.apiError = new Error('simulated connection failure');
      await s.command.callback();
      assert.ok(s.errors.some(m => m.includes('simulated connection failure')));
    });

    await test('unsupported API status is rejected', async () => {
      s.editor = editorFor('activate');
      s.apiPayload = { status: 'UNKNOWN' };
      await s.command.callback();
      assert.ok(s.errors.some(m => m.includes('unsupported verification status')));
    });
  } finally {
    http.get = originalGet;
  }

  console.log('\n=== CORTEX EXTENSION MOCK TESTS ===');
  console.log(`PASS: ${passed}`);
  console.log(`FAIL: ${failed}`);
  console.log('Scope: mocked VS Code API and HTTP responses; not a real extension-host test.');
  if (failed) process.exitCode = 1;
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
