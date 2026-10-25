import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { extractLocalCalls } = require('../call-graph.js');

describe('Cortex callback declaration naming regression', () => {
  it('does not name nested callbacks after an enclosing array variable', () => {
    const source = `
const out = [
  session.decisions.map(d => d.text),
  session.errors.map(e => e.text),
  session.lessons.map(l => l.text),
  session.nextSteps.filter(n => !n.done).map(n => n.text),
  items.map(function (item) { return item.text; })
];
function actualFunction() {
  return out;
}
`;

    const result = extractLocalCalls(source, 'javascript');

    expect(result.hasSyntaxErrors).toBe(false);
    expect(result.declarations.some(item => item.name === 'out')).toBe(false);
    expect(result.declarations.some(item => item.name === 'actualFunction')).toBe(true);
  });

  it('preserves names of directly assigned arrow functions', () => {
    const source = `
const direct = value => value;
const wrapped = ((value) => value);
`;

    const result = extractLocalCalls(source, 'javascript');
    const names = result.declarations.map(item => item.name);

    expect(result.hasSyntaxErrors).toBe(false);
    expect(names).toContain('direct');
    expect(names).toContain('wrapped');
  });
});