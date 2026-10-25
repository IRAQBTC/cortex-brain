import { describe, it, expect } from 'vitest';
import {
  getPackageName,
  classifyImport,
  getDeclaredPackages
} from '../dependency-audit-report.js';

describe('dependency audit classification', () => {
  const context = {
    rootPackages: new Set(['express', '@modelcontextprotocol/sdk']),
    extensionPackages: new Set(['some-extension-package']),
    extensionEntryExists: true,
    extensionEngineDeclared: true
  };

  it('extracts regular and scoped package names', () => {
    expect(getPackageName('express/lib/router')).toBe('express');
    expect(getPackageName('@modelcontextprotocol/sdk/server')).toBe(
      '@modelcontextprotocol/sdk'
    );
  });

  it('does not treat relative paths or aliases as package names', () => {
    expect(getPackageName('../lib/helper')).toBeNull();
    expect(getPackageName('@/lib/helper')).toBeNull();
  });

  it('classifies Node built-ins', () => {
    expect(classifyImport('node:fs', 'src/a.js', context)).toBe('node_builtin');
    expect(classifyImport('path', 'src/a.js', context)).toBe('node_builtin');
  });

  it('recognizes packages declared in the root manifest', () => {
    expect(classifyImport('express', 'src/server.js', context)).toBe(
      'declared_package_dependency'
    );
  });

  it('uses the extension manifest for extension source files', () => {
    expect(
      classifyImport(
        'some-extension-package/api',
        'vscode-extension/extension.js',
        context
      )
    ).toBe('declared_package_dependency');
  });

  it('recognizes VS Code host-provided imports only in extension context', () => {
    expect(
      classifyImport('vscode', 'vscode-extension/extension.js', context)
    ).toBe('host_provided_dependency');

    expect(classifyImport('vscode', 'src/extension.js', context)).toBe(
      'unknown_bare_import'
    );
  });

  it('does not claim undeclared bare imports are missing packages', () => {
    expect(classifyImport('not-in-manifest', 'src/a.js', context)).toBe(
      'unknown_bare_import'
    );
  });

  it('classifies aliases and unresolved relative imports separately', () => {
    expect(classifyImport('@/shared/util', 'src/a.js', context)).toBe(
      'project_alias_requires_configuration'
    );
    expect(classifyImport('../missing', 'src/a.js', context)).toBe(
      'relative_import_not_resolved'
    );
  });

  it('collects all standard package declaration sections', () => {
    const packages = getDeclaredPackages({
      dependencies: { a: '1' },
      devDependencies: { b: '1' },
      optionalDependencies: { c: '1' },
      peerDependencies: { d: '1' }
    });

    expect([...packages].sort()).toEqual(['a', 'b', 'c', 'd']);
  });
});
