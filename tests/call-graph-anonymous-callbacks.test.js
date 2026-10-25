import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { extractLocalCalls } = require('../call-graph.js');

describe('Cortex anonymous callback ownership', () => {
  it('assigns calls inside anonymous callbacks to the callback, not an outer function', () => {
    const source = `
function target() {}
function outer() {
  register(() => {
    target();
  });
}
`;

    const result = extractLocalCalls(source, 'javascript');
    const callback = result.declarations.find(item => item.isAnonymous);
    const target = result.declarations.find(item => item.name === 'target');
    const targetCall = result.calls.find(item => item.callee === 'target');

    expect(result.hasSyntaxErrors).toBe(false);
    expect(callback).toBeDefined();
    expect(callback.name).toMatch(/^__cortex_anonymous_\d+_\d+$/);
    expect(target).toBeDefined();
    expect(targetCall).toBeDefined();
    expect(targetCall.caller).toBe(callback.name);
    expect(targetCall.callerLine).toBe(callback.line);
    expect(targetCall.resolution).toBe('unique_name_candidate');
    expect(targetCall.targetLine).toBe(target.line);
  });

  it('assigns different identities to multiple callbacks on the same line', () => {
    const source = `
function first() {}
function second() {}
const callbacks = [() => first(), () => second()];
`;

    const result = extractLocalCalls(source, 'javascript');
    const callbacks = result.declarations.filter(item => item.isAnonymous);
    const firstCall = result.calls.find(item => item.callee === 'first');
    const secondCall = result.calls.find(item => item.callee === 'second');

    expect(callbacks).toHaveLength(2);
    expect(new Set(callbacks.map(item => item.name)).size).toBe(2);
    expect(firstCall).toBeDefined();
    expect(secondCall).toBeDefined();
    expect(firstCall.caller).not.toBe(secondCall.caller);
    expect(firstCall.resolution).toBe('unique_name_candidate');
    expect(secondCall.resolution).toBe('unique_name_candidate');
  });

  it('captures the anonymous test callback as the owner of assertion calls', () => {
    const source = `
it('example', () => {
  expect(1).toBe(1);
});
`;

    const result = extractLocalCalls(source, 'javascript');
    const callback = result.declarations.find(item => item.isAnonymous);
    const expectCall = result.calls.find(item => item.callee === 'expect');
    const itCall = result.calls.find(item => item.callee === 'it');

    expect(callback).toBeDefined();
    expect(expectCall).toBeDefined();
    expect(itCall).toBeDefined();
    expect(expectCall.caller).toBe(callback.name);
    expect(itCall.caller).toBeNull();
  });
});