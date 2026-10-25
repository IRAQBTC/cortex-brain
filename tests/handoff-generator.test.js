import { describe, it, expect } from 'vitest';
import { extractTaskMarkers, generateHandoff } from '../handoff-generator.js';

describe('English engineering handoff task extraction', () => {
  it('ignores prose that merely mentions TODOs and FIXMEs', () => {
    const result = extractTaskMarkers(
      'server.js',
      [
        '// TODOs + FIXMEs',
        'const heading = "TODO: this is not a source comment";',
        '/* This section discusses TODOs in general. */'
      ].join('\n')
    );

    expect(result.tasks).toEqual([]);
  });

  it('extracts explicit actionable comment markers with line numbers', () => {
    const result = extractTaskMarkers(
      'scanner.js',
      [
        "'use strict';",
        '// TODO: add rollback verification for interrupted scans',
        '# FIXME: validate stale metadata before exporting'
      ].join('\n')
    );

    expect(result.tasks).toHaveLength(2);
    expect(result.tasks[0]).toMatchObject({
      file: 'scanner.js',
      line: 2,
      marker: 'TODO',
      description: 'add rollback verification for interrupted scans'
    });
    expect(result.tasks[1].marker).toBe('FIXME');
  });

  it('excludes unreadable task placeholders and reports a warning', () => {
    const damaged = '?'.repeat(8) + ' scanner.js ' + '?'.repeat(8);
    const result = extractTaskMarkers(
      'tests/sanity.test.js',
      `// TODO: ${damaged}`
    );

    expect(result.tasks).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].line).toBe(1);
    expect(result.warnings[0].reason).toContain('unreadable');
  });

  it('does not treat TODO without a task separator as actionable', () => {
    const result = extractTaskMarkers(
      'server.js',
      '// TODO text is damaged; original requirement is unknown.'
    );

    expect(result.tasks).toEqual([]);
  });
});

describe('Handoff quarantine inventory', () => {
  it('lists every regular quarantined file, including names outside the legacy scanner pattern', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const DatabaseModule = await import('better-sqlite3');
    const Database = DatabaseModule.default || DatabaseModule;
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-handoff-test-'));
    let db;

    try {
      fs.mkdirSync(path.join(tempRoot, '.cortex', 'quarantine'), { recursive: true });
      fs.writeFileSync(path.join(tempRoot, 'package.json'), JSON.stringify({
        name: 'quarantine-test',
        version: '1.0.0',
        scripts: {}
      }));
      fs.writeFileSync(
        path.join(tempRoot, '.cortex', 'quarantine', 'scanner.py.quarantined-test.py'),
        '# inert test fixture\n'
      );
      fs.writeFileSync(
        path.join(tempRoot, '.cortex', 'quarantine', 'universal_scanner.py'),
        '# inert test fixture\n'
      );
      fs.mkdirSync(
        path.join(tempRoot, '.cortex', 'quarantine', 'nested-directory'),
        { recursive: true }
      );

      db = new Database(':memory:');
      db.exec(`
        CREATE TABLE nodes (
          id INTEGER PRIMARY KEY,
          file_path TEXT,
          kind TEXT,
          content TEXT
        );
        CREATE TABLE edges (
          source INTEGER,
          target INTEGER,
          kind TEXT
        );
        CREATE TABLE index_metadata (
          id INTEGER PRIMARY KEY,
          root_path TEXT,
          files INTEGER,
          symbols INTEGER,
          imports INTEGER
        );
      `);

      const report = generateHandoff({
        projectRoot: tempRoot,
        db,
        projectName: 'Quarantine Regression Fixture'
      });

      const heading = '## 9. Quarantined Legacy Tools';
      const start = report.indexOf(heading);
      expect(start).toBeGreaterThanOrEqual(0);

      const nextHeading = report.indexOf('\n## ', start + heading.length);
      const section = report.slice(start, nextHeading < 0 ? undefined : nextHeading);

      expect(section).toContain('.cortex/quarantine/scanner.py.quarantined-test.py');
      expect(section).toContain('.cortex/quarantine/universal_scanner.py');
      expect(section).not.toContain('No regular files were detected');
      expect(section).not.toContain('.cortex/quarantine/nested-directory');
    } finally {
      if (db) db.close();
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});