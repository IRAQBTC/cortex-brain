import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import scanner from '../scanner.js';

const { collectFiles } = scanner;
let tempRoot;

afterEach(() => {
  if (tempRoot && fs.existsSync(tempRoot)) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
  tempRoot = undefined;
});

test('collectFiles includes source and test files but excludes backup and failed artifacts', () => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-collect-files-'));
  fs.mkdirSync(path.join(tempRoot, 'tests'));

  const fixtures = [
    'app.js',
    'app.js.backup-20261020',
    'broken.py.failed-20261020',
    'tests/database.test.js',
    'notes.txt'
  ];

  for (const file of fixtures) {
    fs.writeFileSync(path.join(tempRoot, file), '// fixture\n', 'utf8');
  }

  const actual = collectFiles(tempRoot)
    .map(file => path.relative(tempRoot, file).replace(/\\/g, '/'))
    .sort();

  expect(actual).toEqual([
    'app.js',
    'tests/database.test.js'
  ]);
});