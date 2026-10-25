
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

  parseCode(code, language) {
    const grammar = LANGUAGES[language];

    if (!grammar) {
      return [];
    }

    this.parser.setLanguage(grammar);

    const tree = this.parser.parse(code);
    const elements = [];
    const source = String(code);

    const getText = node =>
      source.substring(node.startIndex, node.endIndex);

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
