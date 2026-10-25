'use strict';

const path = require('node:path');
const Parser = require('tree-sitter');
const JavaScript = require('tree-sitter-javascript');

function parse(source) {
  const parser = new Parser();
  parser.setLanguage(JavaScript);
  return parser.parse(String(source || '')).rootNode;
}

function visit(node, callback) {
  callback(node);
  for (const child of node.namedChildren || []) {
    visit(child, callback);
  }
}

function fieldText(node, field) {
  const value = node && node.childForFieldName(field);
  return value ? value.text : null;
}

function unquote(value) {
  if (!value || value.length < 2) return '';
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === "'" || first === '"') && last === first) {
    return value.slice(1, -1);
  }
  return value;
}

function normalize(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\/+/, '').toLowerCase();
}

function resolveRelativeImport(importer, specifier, indexedPaths) {
  if (!specifier.startsWith('.')) return null;

  const base = path.posix.normalize(
    path.posix.join(path.posix.dirname(importer.replace(/\\/g, '/')), specifier)
  );

  const ext = path.posix.extname(base);
  const candidates = ext ? [base] : [
    base,
    ...['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py']
      .map(extension => base + extension),
    ...['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py']
      .map(extension => base + '/index' + extension)
  ];

  for (const candidate of candidates) {
    const match = indexedPaths.get(normalize(candidate));
    if (match) return match;
  }

  return null;
}

function getNamedExportNames(source, localName) {
  const root = parse(source);
  const exportedNames = new Set();

  visit(root, statement => {
    if (statement.type !== 'export_statement') return;

    // Re-exports from another module are deliberately not inferred here.
    if (fieldText(statement, 'source')) return;

    const clauseNodes = [];
    visit(statement, node => {
      if (node.type === 'export_specifier') clauseNodes.push(node);
    });

    for (const specifier of clauseNodes) {
      const local = fieldText(specifier, 'name');
      const alias = fieldText(specifier, 'alias');
      if (local === localName) exportedNames.add(alias || local);
    }

    // Handle direct named declarations: export function foo() {}
    // and named variable declarations: export const foo = () => {}.
    const declaration = fieldText(statement, 'declaration');
    if (declaration) {
      const declarationNode = statement.namedChildren.find(
        node => node.text === declaration
      );

      if (declarationNode) {
        visit(declarationNode, node => {
          if (node.type === 'function_declaration') {
            const name = fieldText(node, 'name');
            if (name === localName) exportedNames.add(name);
          }

          if (node.type === 'variable_declarator') {
            const name = fieldText(node, 'name');
            const value = node.childForFieldName('value');

            if (
              name === localName &&
              value &&
              ['arrow_function', 'function_expression'].includes(value.type)
            ) {
              exportedNames.add(name);
            }
          }
        });
      }
    }
  });

  return exportedNames;
}

function getNamedImports(source, importerPath, targetPath, fileNodes, exportNames) {
  if (!exportNames || exportNames.size === 0) return [];

  const indexedPaths = new Map(
    fileNodes.map(file => [normalize(file.file_path), file.file_path])
  );

  const root = parse(source);
  const result = [];

  visit(root, statement => {
    if (statement.type !== 'import_statement') return;

    const sourceNode = statement.childForFieldName('source');
    if (!sourceNode) return;

    const specifier = unquote(sourceNode.text);
    const resolved = resolveRelativeImport(importerPath, specifier, indexedPaths);

    if (!resolved || normalize(resolved) !== normalize(targetPath)) return;

    visit(statement, node => {
      if (node.type !== 'import_specifier') return;

      const importedName = fieldText(node, 'name');
      const alias = fieldText(node, 'alias');
      const localName = alias || importedName;

      if (importedName && localName && exportNames.has(importedName)) {
        result.push({ importedName, localName });
      }
    });
  });

  return result;
}

module.exports = {
  getNamedExportNames,
  getNamedImports
};