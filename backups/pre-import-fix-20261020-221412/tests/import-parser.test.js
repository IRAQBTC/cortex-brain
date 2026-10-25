import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';

const scannerSource = fs.readFileSync(
  path.join(process.cwd(), 'scanner.js'),
  'utf8'
);

const start = scannerSource.indexOf('function extractImports(');
const end = scannerSource.indexOf('function prepareFile(', start);

if (start < 0 || end <= start) {
  throw new Error('Could not isolate extractImports from scanner.js');
}

const parserSource = scannerSource.slice(start, end).trim();
const extractImports = vm.runInNewContext(
  '(' + parserSource.replace(/;?\s*$/, '') + ')'
);

describe('extractImports parser regression tests', () => {
  it('detects JavaScript imports, exports, require and dynamic imports', () => {
    const source = [
      "import fs from 'node:fs';",
      "import { join } from './utils.js';",
      "export { run } from './runner';",
      "const db = require('./db');",
      "const lazy = import('./lazy.js');"
    ].join('\n');

    expect(extractImports(source, 'javascript')).toEqual([
      'node:fs',
      './utils.js',
      './runner',
      './db',
      './lazy.js'
    ]);
  });

  it('detects Python imports, aliases and from-import statements', () => {
    const source = [
      'import os',
      'import pathlib, sys',
      'import package.module as mod',
      'from .helpers import run',
      'from ..core.engine import Engine'
    ].join('\n');

    expect(extractImports(source, 'python')).toEqual([
      'os',
      'pathlib',
      'sys',
      'package.module',
      '.helpers',
      '..core.engine'
    ]);
  });

  it('does not duplicate identical import specifiers', () => {
    const source = [
      "const a = require('./db');",
      "const b = require('./db');"
    ].join('\n');

    expect(extractImports(source, 'javascript')).toEqual(['./db']);
  });
});