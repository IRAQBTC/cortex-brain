import { describe, it, expect } from 'vitest';
import { extractLocalCalls } from '../call-graph.js';

describe('Cortex local call extraction', () => {
  it('extracts direct JavaScript calls', () => {
    const result = extractLocalCalls(`
      function alpha() {
        beta();
        object.gamma();
      }

      function beta() {
        alpha();
      }
    `, 'javascript');

    expect(result.hasSyntaxErrors).toBe(false);
    expect(result.calls.some(
      call => call.caller === 'alpha' &&
              call.callee === 'beta' &&
              call.resolution === 'unique_name_candidate'
    )).toBe(true);

    expect(result.calls.some(
      call => call.callee === 'gamma'
    )).toBe(false);
  });

  it('marks duplicate declaration names as ambiguous', () => {
    const result = extractLocalCalls(`
      function run() {}
      function run() {}
      function start() {
        run();
      }
    `, 'javascript');

    const call = result.calls.find(item => item.callee === 'run');

    expect(call).toBeDefined();
    expect(call.resolution).toBe('ambiguous_name');
  });

  it('extracts direct Python calls', () => {
    const result = extractLocalCalls(`
def alpha():
    beta()
    obj.gamma()

def beta():
    alpha()
`, 'python');

    expect(result.hasSyntaxErrors).toBe(false);
    expect(result.calls.some(
      call => call.caller === 'alpha' &&
              call.callee === 'beta' &&
              call.resolution === 'unique_name_candidate'
    )).toBe(true);

    expect(result.calls.some(
      call => call.callee === 'gamma'
    )).toBe(false);
  });

  it('preserves caller location and declaration line ranges', () => {
    const result = extractLocalCalls(`
function outer() {
  inner();
}
function inner() {}
`, 'javascript');

    const caller = result.declarations.find(
      item => item.name === 'outer'
    );
    const call = result.calls.find(
      item => item.callee === 'inner'
    );

    expect(caller).toBeDefined();
    expect(call).toBeDefined();
    expect(call.caller).toBe('outer');
    expect(call.callerLine).toBe(caller.line);
    expect(caller.endLine).toBeGreaterThanOrEqual(caller.line);
  });
  it('reports unsupported languages without throwing', () => {
    const result = extractLocalCalls('hello()', 'ruby');

    expect(result.unsupportedLanguage).toBe(true);
    expect(result.calls).toEqual([]);
  });
});
