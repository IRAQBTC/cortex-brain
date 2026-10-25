
'use strict';

const Parser = require('tree-sitter');
const Python = require('tree-sitter-python');
const JavaScript = require('tree-sitter-javascript');

const LANGUAGES = {
  python: Python,
  javascript: JavaScript,
  typescript: JavaScript
};

const EXTENSIONS = {
  py: 'python',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript'
};

class CortexParser {
  constructor() {
    this.parser = new Parser();
  }

  detectLanguage(filePath) {
    const extension = pathExtension(filePath);
    return EXTENSIONS[extension] || null;
  }


  /**
   * Detailed parsing API. parseCode() remains backward compatible.
   */
  parseCodeDetailed(code, language) {
    const grammar = LANGUAGES[language];

    if (!grammar) {
      return {
        symbols: [],
        hasErrors: false,
        diagnostics: [],
        unsupportedLanguage: true
      };
    }

    const source = String(code);
    this.parser.setLanguage(grammar);
    const sourceBytes = Buffer.byteLength(String(source), 'utf8');
    let sourceBufferSize = 32768;
    while (sourceBufferSize <= sourceBytes) {
      sourceBufferSize *= 2;
    }
    const tree = sourceBytes < 32768
      ? this.parser.parse(source)
      : this.parser.parse(source, null, { bufferSize: sourceBufferSize });
    const root = tree && tree.rootNode;
    const diagnostics = [];
    const seen = new Set();

    const readFlag = (node, key) => {
      try {
        const value = node[key];
        return typeof value === "function"
          ? Boolean(value.call(node))
          : Boolean(value);
      } catch (_) {
        return false;
      }
    };

    const addDiagnostic = (type, node) => {
      const start = node && node.startPosition
        ? node.startPosition : { row: 0, column: 0 };
      const end = node && node.endPosition
        ? node.endPosition : start;

      const startLine = Number(start.row || 0) + 1;
      const startColumn = Number(start.column || 0) + 1;
      const endLine = Number(end.row || 0) + 1;
      const endColumn = Number(end.column || 0) + 1;
      const key = [type, startLine, startColumn, endLine, endColumn].join(":");

      if (seen.has(key)) return;
      seen.add(key);

      const lines = source.split(/\r?\n/);
      const excerpt = String(lines[startLine - 1] || "").trim().slice(0, 240);

      diagnostics.push({
        type,
        startLine,
        startColumn,
        endLine,
        endColumn,
        excerpt
      });
    };

    const visit = (node) => {
      if (!node) return;

      if (node.type === "ERROR") {
        addDiagnostic("ERROR", node);
      } else if (readFlag(node, "isMissing")) {
        addDiagnostic("MISSING_TOKEN", node);
      }

      let count = 0;
      try {
        count = Number(node.childCount || 0);
      } catch (_) {}

      for (let i = 0; i < count; i++) {
        let child = null;
        try { child = node.child(i); } catch (_) {}
        if (child) visit(child);
      }
    };

    if (root) visit(root);

    const treeHasErrors = root ? readFlag(root, "hasError") : false;
    if (treeHasErrors && diagnostics.length === 0) {
      addDiagnostic("SYNTAX_ERROR", root);
    }

    // Preserve the existing symbol extraction contract.
    const symbols = this.parseCode(source, language);

    return {
      symbols,
      hasErrors: treeHasErrors || diagnostics.length > 0,
      diagnostics,
      unsupportedLanguage: false
    };
  }

  parseCode(code, language) {
    const grammar = LANGUAGES[language];

    if (!grammar) {
      return [];
    }

    this.parser.setLanguage(grammar);

    const codeBytes = Buffer.byteLength(String(code), 'utf8');
    let codeBufferSize = 32768;
    while (codeBufferSize <= codeBytes) {
      codeBufferSize *= 2;
    }
    const tree = codeBytes < 32768
      ? this.parser.parse(code)
      : this.parser.parse(code, null, { bufferSize: codeBufferSize });
    const elements = [];
    const source = String(code);

    const getText = node =>
      source.substring(node.startIndex, node.endIndex);

    const unwrapAssignedFunction = value => {
      while (
        value &&
        value.type === 'parenthesized_expression' &&
        value.namedChildren.length === 1
      ) {
        value = value.namedChildren[0];
      }

      return value;
    };

    const isSameAssignedFunction = (left, right) => Boolean(
      left &&
      right &&
      left.type === right.type &&
      left.startIndex === right.startIndex &&
      left.endIndex === right.endIndex
    );

    const getName = node => {
      const direct = node.childForFieldName('name');

      if (direct) {
        return getText(direct);
      }

      // For declarations such as: const handler = () => {}
      if (node.type === 'arrow_function') {
        let parent = node.parent;

        while (parent && parent.type !== 'variable_declarator') {
          if (
            parent.type === 'statement_block' ||
            parent.type === 'program'
          ) {
            break;
          }

          parent = parent.parent;
        }

        if (parent && parent.type === 'variable_declarator') {
          const assignedValue = unwrapAssignedFunction(
            parent.childForFieldName('value')
          );

          // A callback nested inside another expression is not the variable's value.
          if (!isSameAssignedFunction(assignedValue, node)) {
            return null;
          }

          const nameNode = parent.childForFieldName('name');

          if (nameNode) {
            return getText(nameNode);
          }
        }
      }

      return null;
    };

    const classify = node => {
      if (
        node.type === 'class_definition' ||
        node.type === 'class_declaration'
      ) {
        return 'class';
      }

      if (
        node.type === 'method_definition' ||
        (
          language === 'python' &&
          node.type === 'function_definition' &&
          node.parent &&
          node.parent.type === 'block' &&
          node.parent.parent &&
          node.parent.parent.type === 'class_definition'
        )
      ) {
        return 'method';
      }

      return 'function';
    };

    const visit = node => {
      const supported = new Set([
        'function_definition',
        'function_declaration',
        'class_definition',
        'class_declaration',
        'method_definition',
        'arrow_function'
      ]);

      if (supported.has(node.type)) {
        const name = getName(node);

        if (name) {
          const startLine = node.startPosition.row + 1;
          const endLine = node.endPosition.row + 1;
          const text = getText(node);
          const firstLine = text.split(/\r?\n/, 1)[0].trim();

          elements.push({
            type: classify(node),
            name,
            code: text,
            signature: firstLine,
            jsdoc: null,
            startLine,
            endLine
          });
        }
      }

      for (let i = 0; i < node.childCount; i++) {
        visit(node.child(i));
      }
    };

    visit(tree.rootNode);

    return elements;
  }
}

function pathExtension(filePath) {
  const parts = String(filePath).split(/[\\/]/);
  const filename = parts[parts.length - 1] || '';
  const index = filename.lastIndexOf('.');

  return index >= 0
    ? filename.slice(index + 1).toLowerCase()
    : '';
}

module.exports = new CortexParser();
