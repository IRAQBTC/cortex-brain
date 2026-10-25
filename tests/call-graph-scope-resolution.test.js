import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { extractLocalCalls } = require('../call-graph.js');

describe('Cortex lexical call resolution', () => {
  it('resolves recursive calls to the correct enclosing lexical scope', () => {
    const source = `
function parseCodeDetailed(root) {
  const visit = node => {
    if (node.child) visit(node.child);
  };
  visit(root);
}
function parseCode(tree) {
  const visit = node => {
    visit(node.child);
  };
  visit(tree.rootNode);
}
`;

    const result = extractLocalCalls(source, 'javascript');
    const visits = result.declarations.filter(item => item.name === 'visit');
    const calls = result.calls.filter(item => item.callee === 'visit');

    expect(result.hasSyntaxErrors).toBe(false);
    expect(visits).toHaveLength(2);
    expect(calls).toHaveLength(4);
    expect(calls.every(item => item.resolution === 'unique_name_candidate')).toBe(true);
    expect(calls.every(item => Number.isInteger(item.targetLine))).toBe(true);

    for (const call of calls) {
      const caller = visits.find(item => item.line === call.callerLine);

      if (caller) {
        expect(call.targetLine).toBe(caller.line);
      }
    }
  });

  it('resolves same-named helpers in separate function scopes independently', () => {
    const source = `
function routeA(value) {
  const count = input => input;
  return count(value);
}
function routeB(value) {
  const count = input => input;
  return count(value);
}
`;

    const result = extractLocalCalls(source, 'javascript');
    const calls = result.calls.filter(item => item.callee === 'count');

    expect(calls).toHaveLength(2);
    expect(calls.every(item => item.resolution === 'unique_name_candidate')).toBe(true);
    expect(new Set(calls.map(item => item.targetLine)).size).toBe(2);
  });

  it('selects the nearest binding when a local declaration shadows an outer name', () => {
    const source = `
const normalize = value => value;
function localCase(value) {
  const normalize = input => input;
  return normalize(value);
}
function outerCase(value) {
  return normalize(value);
}
`;

    const result = extractLocalCalls(source, 'javascript');
    const localCase = result.declarations.find(item => item.name === 'localCase');
    const outerCase = result.declarations.find(item => item.name === 'outerCase');
    const normalizeDeclarations = result.declarations.filter(
      item => item.name === 'normalize'
    );
    const calls = result.calls.filter(item => item.callee === 'normalize');

    expect(localCase).toBeDefined();
    expect(outerCase).toBeDefined();
    expect(normalizeDeclarations).toHaveLength(2);
    expect(calls).toHaveLength(2);
    expect(calls.every(item => item.resolution === 'unique_name_candidate')).toBe(true);

    const localCall = calls.find(item => item.caller === 'localCase');
    const outerCall = calls.find(item => item.caller === 'outerCase');

    expect(localCall).toBeDefined();
    expect(outerCall).toBeDefined();

    // Identify each declaration by its relationship to the enclosing function,
    // not by assuming a fixed source line number.
    const localNormalize = normalizeDeclarations.find(
      item => item.line > localCase.line && item.line < outerCase.line
    );
    const outerNormalize = normalizeDeclarations.find(
      item => item.line < localCase.line
    );

    expect(localNormalize).toBeDefined();
    expect(outerNormalize).toBeDefined();
    expect(localCall.targetLine).toBe(localNormalize.line);
    expect(outerCall.targetLine).toBe(outerNormalize.line);
  });

  it('resolves a local var function binding instead of an outer function', () => {
    const source = `
function execute() {}
function work() {
  execute();
  var execute = function localExecute() {};
}
`;

    const result = extractLocalCalls(source, 'javascript');
    const call = result.calls.find(
      item => item.callee === 'execute' && item.caller === 'work'
    );
    const expectedLine = source.split('\n').findIndex(
      line => line.includes('var execute = function localExecute')
    ) + 1;

    expect(call).toBeDefined();
    expect(call.resolution).toBe('unique_name_candidate');
    expect(call.targetLine).toBe(expectedLine);
  });

  it('does not resolve a non-callable local const to an outer function', () => {
    const source = `
function execute() {}
function work() {
  execute();
  const execute = 42;
}
`;

    const result = extractLocalCalls(source, 'javascript');
    const call = result.calls.find(
      item => item.callee === 'execute' && item.caller === 'work'
    );

    expect(call).toBeDefined();
    expect(call.resolution).toBe('unresolved_name');
    expect(call.targetLine).toBeNull();
  });

  it('keeps duplicate declarations in the same scope ambiguous', () => {
    const source = `
function run() {}
function run() {}
function start() {
  run();
}
`;

    const result = extractLocalCalls(source, 'javascript');
    const call = result.calls.find(item => item.callee === 'run');

    expect(call).toBeDefined();
    expect(call.resolution).toBe('ambiguous_name');
    expect(call.targetLine).toBeNull();
  });
});