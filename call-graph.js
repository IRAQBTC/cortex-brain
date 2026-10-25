'use strict';

const Parser = require('tree-sitter');
const JavaScript = require('tree-sitter-javascript');
const Python = require('tree-sitter-python');

const LANGUAGES = {
  javascript: JavaScript,
  typescript: JavaScript,
  python: Python
};

function unwrapAssignedFunction(value) {
  while (
    value &&
    value.type === 'parenthesized_expression' &&
    value.namedChildren.length === 1
  ) {
    value = value.namedChildren[0];
  }

  return value;
}

function isSameAssignedFunction(left, right) {
  return Boolean(
    left &&
    right &&
    left.type === right.type &&
    left.startIndex === right.startIndex &&
    left.endIndex === right.endIndex
  );
}

function getDeclarationName(node) {
  if (!node) return null;

  const direct = node.childForFieldName('name');
  if (direct) return direct.text;

  if (
    node.type === 'arrow_function' ||
    node.type === 'function_expression'
  ) {
    let parent = node.parent;

    while (parent && parent.type !== 'variable_declarator') {
      if (
        parent.type === 'statement_block' ||
        parent.type === 'program'
      ) {
        return null;
      }

      parent = parent.parent;
    }

    if (parent) {
      const assignedValue = unwrapAssignedFunction(
        parent.childForFieldName('value')
      );

      // Do not attribute an outer variable name to a nested callback.
      if (!isSameAssignedFunction(assignedValue, node)) {
        return null;
      }

      const name = parent.childForFieldName('name');
      return name ? name.text : null;
    }
  }

  return null;
}

const JS_SCOPE_TYPES = new Set([
  'program',
  'statement_block',
  'class_body',
  'switch_body',
  'catch_clause',
  'for_statement',
  'for_in_statement',
  'for_of_statement',
  'function_declaration',
  'function_expression',
  'arrow_function',
  'method_definition'
]);

const JS_FUNCTION_SCOPE_TYPES = new Set([
  'program',
  'function_declaration',
  'function_expression',
  'arrow_function',
  'method_definition'
]);

function scopeKey(node) {
  return node
    ? `${node.type}:${node.startIndex}:${node.endIndex}`
    : null;
}

function nearestJavaScriptScope(node, functionScopeOnly = false) {
  let current = node;

  while (current) {
    const eligible = functionScopeOnly
      ? JS_FUNCTION_SCOPE_TYPES.has(current.type)
      : JS_SCOPE_TYPES.has(current.type);

    if (eligible) return scopeKey(current);
    current = current.parent;
  }

  return null;
}

function getDeclarationBindingScopeKey(node, language) {
  if (language !== 'javascript' && language !== 'typescript') {
    return null;
  }

  if (node.type === 'method_definition') return null;

  if (
    node.type === 'function_expression' &&
    node.childForFieldName('name')
  ) {
    return scopeKey(node);
  }

  if (
    node.type === 'arrow_function' ||
    node.type === 'function_expression'
  ) {
    let binding = node.parent;

    while (binding && binding.type !== 'variable_declarator') {
      binding = binding.parent;
    }

    if (!binding) return null;

    const assignedValue = unwrapAssignedFunction(
      binding.childForFieldName('value')
    );

    if (!isSameAssignedFunction(assignedValue, node)) {
      return null;
    }

    const declaration = binding.parent;
    if (!declaration) return null;

    if (declaration.type === 'variable_declaration') {
      return nearestJavaScriptScope(declaration.parent, true);
    }

    return nearestJavaScriptScope(declaration.parent, false);
  }

  return nearestJavaScriptScope(node.parent, false);
}

function getVisibleScopeKeys(node, language) {
  if (language !== 'javascript' && language !== 'typescript') {
    return [];
  }

  const scopes = [];
  let current = node.parent;

  while (current) {
    if (JS_SCOPE_TYPES.has(current.type)) {
      scopes.push(scopeKey(current));
    }

    current = current.parent;
  }

  return scopes;
}

function getAnonymousDeclarationName(node) {
  if (
    !node ||
    (node.type !== 'arrow_function' &&
     node.type !== 'function_expression')
  ) {
    return null;
  }

  const line = node.startPosition.row + 1;
  const column = node.startPosition.column + 1;

  return `__cortex_anonymous_${line}_${column}`;
}

function extractLocalCalls(source, language) {
  const grammar = LANGUAGES[language];

  if (!grammar) {
    return {
      calls: [],
      declarations: [],
      hasSyntaxErrors: false,
      unsupportedLanguage: true
    };
  }

  const parser = new Parser();
  parser.setLanguage(grammar);

  const sourceText = String(source);
  const bufferSize = Math.max(64 * 1024, Buffer.byteLength(sourceText, 'utf8') + 1);
  const tree = parser.parse(sourceText, null, { bufferSize });
  const declarations = [];
  const rawCalls = [];
  // Variable bindings are separate from function declarations.
  const variableBindings = [];

  const declarationTypes = new Set([
    'function_declaration',
    'function_definition',
    'method_definition',
    'arrow_function',
    'function_expression'
  ]);

  const callTypes = new Set([
    'call_expression',
    'call'
  ]);

  function visit(node) {
    if (
      (language === 'javascript' || language === 'typescript') &&
      node.type === 'variable_declarator'
    ) {
      const nameNode = node.childForFieldName('name');
      const declarationNode = node.parent;
      const valueNode = unwrapAssignedFunction(
        node.childForFieldName('value')
      );

      if (
        nameNode &&
        nameNode.type === 'identifier' &&
        declarationNode &&
        (
          declarationNode.type === 'variable_declaration' ||
          declarationNode.type === 'lexical_declaration'
        )
      ) {
        const kind = declarationNode.type === 'variable_declaration'
          ? 'var'
          : (
              declarationNode.childForFieldName('kind')?.text || 'let'
            );

        const bindingScopeKey = kind === 'var'
          ? (
              nearestJavaScriptScope(declarationNode.parent, true) ||
              nearestJavaScriptScope(declarationNode.parent, false)
            )
          : nearestJavaScriptScope(declarationNode.parent, false);

        const isCallable = Boolean(
          valueNode &&
          (
            valueNode.type === 'arrow_function' ||
            valueNode.type === 'function_expression'
          )
        );

        variableBindings.push({
          name: nameNode.text,
          bindingScopeKey,
          isCallable,
          targetLine: isCallable
            ? valueNode.startPosition.row + 1
            : null
        });
      }
    }
    if (declarationTypes.has(node.type)) {
      const declaredName = getDeclarationName(node);
      const isAnonymous = (
        !declaredName &&
        (node.type === 'arrow_function' ||
         node.type === 'function_expression')
      );

      const name = declaredName ||
        (isAnonymous ? getAnonymousDeclarationName(node) : null);

      if (name) {
        declarations.push({
          name,
          kind: node.type,
          line: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          column: node.startPosition.column + 1,
          isAnonymous,
          bindingScopeKey: isAnonymous
            ? null
            : getDeclarationBindingScopeKey(node, language)
        });
      }
    }

    if (callTypes.has(node.type)) {
      const fn = node.childForFieldName('function');

      // Resolve only direct identifier calls in this initial version.
      // Member calls such as object.method() are deliberately excluded.
      if (fn && fn.type === 'identifier') {
        let caller = null;
        let callerLine = null;
        let parent = node.parent;

        while (parent) {
          if (declarationTypes.has(parent.type)) {
            const parentIdentity =
              getDeclarationName(parent) ||
              getAnonymousDeclarationName(parent);

            if (parentIdentity) {
              caller = parentIdentity;
              callerLine = parent.startPosition.row + 1;
              break;
            }
          }

          parent = parent.parent;
        }

        rawCalls.push({
          caller,
          callerLine,
          callee: fn.text,
          line: node.startPosition.row + 1,
          scopeKeys: getVisibleScopeKeys(node, language)
        });
      }
    }

    for (const child of node.namedChildren) {
      visit(child);
    }
  }

  visit(tree.rootNode);

  const declarationsByName = new Map();

  for (const declaration of declarations) {
    if (declaration.isAnonymous) continue;

    if (!declarationsByName.has(declaration.name)) {
      declarationsByName.set(declaration.name, []);
    }

    declarationsByName.get(declaration.name).push(declaration);
  }

  const calls = rawCalls.map(rawCall => {
    const { scopeKeys = [], ...call } = rawCall;

    let resolution = 'unresolved_name';
    let targetLine = null;

    if (language === 'javascript' || language === 'typescript') {
      const namedDeclarations = (
        declarationsByName.get(call.callee) || []
      ).filter(declaration => declaration.bindingScopeKey);

      const namedBindings = variableBindings.filter(
        binding => binding.name === call.callee && binding.bindingScopeKey
      );

      // Search from the nearest visible scope outwards.
      // A local variable binding shadows outer function declarations,
      // even when the local value is not callable.
      for (const key of scopeKeys) {
        const bindingsHere = namedBindings.filter(
          binding => binding.bindingScopeKey === key
        );

        if (bindingsHere.length > 0) {
          if (bindingsHere.length > 1) {
            resolution = 'ambiguous_name';
          } else if (bindingsHere[0].isCallable) {
            resolution = 'unique_name_candidate';
            targetLine = bindingsHere[0].targetLine;
          }

          // Non-callable local bindings deliberately remain unresolved.
          break;
        }

        const declarationsHere = namedDeclarations.filter(
          declaration => declaration.bindingScopeKey === key
        );

        if (declarationsHere.length === 1) {
          resolution = 'unique_name_candidate';
          targetLine = declarationsHere[0].line;
          break;
        }

        if (declarationsHere.length > 1) {
          resolution = 'ambiguous_name';
          break;
        }
      }
    } else {
      // Keep Python behavior unchanged until Python-specific scope tests exist.
      const candidates = declarationsByName.get(call.callee) || [];

      if (candidates.length === 1) {
        resolution = 'unique_name_candidate';
        targetLine = candidates[0].line;
      } else if (candidates.length > 1) {
        resolution = 'ambiguous_name';
      }
    }

    return {
      ...call,
      resolution,
      targetLine
    };
  });

  return {
    calls,
    declarations,
    hasSyntaxErrors: Boolean(tree.rootNode.hasError),
    unsupportedLanguage: false
  };
}

module.exports = {
  extractLocalCalls
};
