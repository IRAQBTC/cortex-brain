import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { extractLocalCalls } = require('../call-graph.js');

describe('call-graph large-source regression', () => {
  it('parses JavaScript larger than the default 32 KiB input buffer', () => {
    const padding = '// Cortex parser buffer regression padding\n'.repeat(1200);

    const source = [
      padding,
      'function target() { return 7; }',
      'function caller() { return target(); }',
      ''
    ].join('\n');

    expect(Buffer.byteLength(source, 'utf8')).toBeGreaterThan(32768);

    const result = extractLocalCalls(source, 'javascript');

    expect(result.hasSyntaxErrors).toBe(false);
    expect(result.declarations.map(item => item.name)).toEqual(
      expect.arrayContaining(['target', 'caller'])
    );
    expect(result.calls.length).toBeGreaterThan(0);
  });
});