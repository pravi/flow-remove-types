var babylon = require('babylon');
var vlq = require('vlq');

/**
 * Given a string JavaScript source which contains Flow types, return a string
 * which has removed those types.
 *
 * Options:
 *
 *   - all: (default: false)
 *     If true, bypasses looking for an @flow pragma comment before parsing.
 *
 *   - pretty: (default: false)
 *     If true, removes types completely rather than replacing with spaces.
 *     This may require using source maps.
 *
 * Returns an object with two methods:
 *
 *   - .toString()
 *     Returns the transformed source code.
 *
 *   - .generateMap()
 *     Returns a v3 source map.
 */
module.exports = function flowRemoveTypes(source, options) {
  // Options
  var all = Boolean(options && options.all);
  if (options && options.checkPragma) {
    throw new Error(
      'flow-remove-types: the "checkPragma" option has been replaced by "all".'
    );
  }

  // If there's no @flow or @noflow flag, then expect no annotation.
  var pragmaStart = source.indexOf('@' + 'flow');
  var pragmaSize = 5;
  if (pragmaStart === -1) {
    pragmaStart = source.indexOf('@' + 'noflow');
    pragmaSize = 7;
    if (pragmaStart === -1 && !all) {
      return resultPrinter(options, source);
    }
  }

  var removedNodes = [];

  // Remove the flow pragma.
  if (pragmaStart !== -1) {
    var prePragmaLines = source.slice(0, pragmaStart).split('\n');
    var pragmaLine = prePragmaLines.length;
    var pragmaCol = prePragmaLines[pragmaLine - 1].length;
    removedNodes.push({
      start: pragmaStart,
      end: pragmaStart + pragmaSize,
      loc: {
        start: { line: pragmaLine, column: pragmaCol },
        end: { line: pragmaLine, column: pragmaCol + pragmaSize }
      },
    })
  }

  // Babylon is one of the sources of truth for Flow syntax. This parse
  // configuration is intended to be as permissive as possible.
  var ast = babylon.parse(source, {
    allowImportExportEverywhere: true,
    allowReturnOutsideFunction: true,
    allowSuperOutsideMethod: true,
    sourceType: 'module',
    plugins: [ '*', 'jsx', 'flow' ],
  });

  var context = {
    ast: ast,
    source: source,
    removedNodes: removedNodes,
    pretty: Boolean(options && options.pretty)
  };

  visit(ast, context, removeFlowVisitor);

  return resultPrinter(options, source, removedNodes);
}

function resultPrinter(options, source, removedNodes) {
  // Options
  var pretty = Boolean(options && options.pretty);

  return {
    toString: function () {
      if (!removedNodes || removedNodes.length === 0) {
        return source;
      }

      var result = '';
      var lastPos = 0;

      // Step through the removed nodes, building up the resulting string.
      for (var i = 0; i < removedNodes.length; i++) {
        var node = removedNodes[i];
        result += source.slice(lastPos, node.start);
        lastPos = node.end;
        if (!pretty) {
          var toReplace = source.slice(node.start, node.end);
          if (!node.loc || node.loc.start.line === node.loc.end.line) {
            result += space(toReplace.length);
          } else {
            var toReplaceLines = toReplace.split(LINE_RX);
            result += space(toReplaceLines[0].length);
            for (var j = 1; j < toReplaceLines.length; j += 2) {
              result += toReplaceLines[j] + space(toReplaceLines[j + 1].length);
            }
          }
        }
      }

      return result += source.slice(lastPos);
    },
    generateMap: function () {
      return {
        version: 3,
        sources: [ 'source.js' ],
        names: [],
        mappings: pretty ? generateSourceMappings(removedNodes) : ''
      };
    }
  }
}

var LINE_RX = /(\r\n?|\n|\u2028|\u2029)/;

// A collection of methods for each AST type names which contain Flow types to
// be removed.
var removeFlowVisitor = {
  DeclareClass: removeNode,
  DeclareFunction: removeNode,
  DeclareInterface:removeNode,
  DeclareModule: removeNode,
  DeclareTypeAlias: removeNode,
  DeclareVariable: removeNode,
  InterfaceDeclaration: removeNode,
  TypeAlias: removeNode,
  TypeAnnotation: removeNode,
  TypeParameterDeclaration: removeNode,
  TypeParameterInstantiation: removeNode,

  ClassDeclaration: removeImplementedInterfaces,
  ClassExpression: removeImplementedInterfaces,

  Identifier: function (context, node, ast) {
    if (node.optional) {
      // Find the optional token.
      var idx = findTokenIndex(ast.tokens, node.start);
      do {
        idx++;
      } while (ast.tokens[idx].type.label !== '?');
      removeNode(context, ast.tokens[idx]);
    }
  },

  ClassProperty: function (context, node) {
    if (!node.value) {
      return removeNode(context, node)
    }
  },

  ExportNamedDeclaration: function (context, node) {
    if (node.exportKind === 'type') {
      return removeNode(context, node);
    }
  },

  ImportDeclaration: function (context, node) {
    if (node.importKind === 'type') {
      return removeNode(context, node);
    }
  }
};

// If this class declaration or expression implements interfaces, remove
// the associated tokens.
function removeImplementedInterfaces(context, node, ast) {
  if (node.implements && node.implements.length > 0) {
    var first = node.implements[0];
    var last = node.implements[node.implements.length - 1];
    var idx = findTokenIndex(ast.tokens, first.start);
    do {
      idx--;
    } while (ast.tokens[idx].value !== 'implements');

    var lastIdx = findTokenIndex(ast.tokens, last.start);
    do {
      if (ast.tokens[idx].type !== 'CommentBlock' &&
          ast.tokens[idx].type !== 'CommentLine') {
        removeNode(context, ast.tokens[idx]);
      }
    } while (idx++ !== lastIdx);
  }
}

// Append node to the list of removed nodes, ensuring the order of the nodes
// in the list.
function removeNode(context, node) {
  var removedNodes = context.removedNodes;
  var length = removedNodes.length;
  var index = length;

  // Check for line's trailing space to be removed.
  var lineNode = context.pretty ? getTrailingLineNode(context, node) : null;

  while (index > 0 && removedNodes[index - 1].end > node.start) {
    index--;
  }

  if (index === length) {
    if (lineNode) {
      removedNodes.push(node, lineNode);
    } else {
      removedNodes.push(node);
    }
  } else {
    if (lineNode) {
      removedNodes.splice(index, 0, node, lineNode);
    } else {
      removedNodes.splice(index, 0, node);
    }
  }

  return false;
}

function getTrailingLineNode(state, node) {
  var source = state.source;
  var start = node.end;
  var end = start;
  while (source[end] === ' ' || source[end] === '\t') {
    end++;
  }

  // Remove all space including the line break if this token was alone on the line.
  if (source[end] === '\n' || source[end] === '\r') {
    if (source[end] === '\r' && source[end + 1] === '\n') {
      end++;
    }
    end++;

    var ast = state.ast;
    var idx = findTokenIndex(ast.tokens, node.start);
    var prevToken = ast.tokens[idx - 1];
    if (prevToken.loc.end.line !== node.loc.end.line) {
      return {
        start: start,
        end: end,
        loc: { start: node.loc.end, end: node.loc.end }
      };
    }
  }
}

// Given the AST output of babylon parse, walk through in a depth-first order,
// calling methods on the given visitor, providing context as the first argument.
function visit(ast, context, visitor) {
  var stack;
  var parent;
  var keys = [];
  var index = -1;

  do {
    index++;
    if (stack && index === keys.length) {
      parent = stack.parent;
      keys = stack.keys;
      index = stack.index;
      stack = stack.prev;
    } else {
      var node = parent ? parent[keys[index]] : ast.program;
      if (node && typeof node === 'object' && (node.type || node.length && node[0].type)) {
        if (node.type) {
          var visitFn = visitor[node.type];
          if (visitFn && visitFn(context, node, ast) === false) {
            continue;
          }
        }
        stack = { parent: parent, keys: keys, index: index, prev: stack };
        parent = node;
        keys = Object.keys(node);
        index = -1;
      }
    }
  } while (stack);
}

// Given an array of sorted tokens, find the index of the token which contains
// the given offset. Uses binary search for O(log N) performance.
function findTokenIndex(tokens, offset) {
  var min = 0;
  var max = tokens.length - 1;

  while (min <= max) {
    var ptr = (min + max) / 2 | 0;
    var token = tokens[ptr];
    if (token.end <= offset) {
      min = ptr + 1;
    } else if (token.start > offset) {
      max = ptr - 1;
    } else {
      return ptr;
    }
  }

  return ptr;
}

// Produce a string full of space characters of a given size.
function space(size) {
  var sp = ' '
  var result = '';

  for (;;) {
    if ((size & 1) === 1) {
      result += sp;
    }
    size >>>= 1;
    if (size === 0) {
      break;
    }
    sp += sp;
  }
  return result;
}

// Generate a source map when *removing* nodes rather than replacing them
// with spaces.
function generateSourceMappings(removedNodes) {
  var mappings = '';
  if (!removedNodes || removedNodes.length === '') {
    return mappings;
  }

  var end = { line: 1, column: 0 };

  for (var i = 0; i < removedNodes.length; i++) {
    var start = removedNodes[i].loc.start;
    var lineDiff = start.line - end.line;
    var columnDiff = start.column - end.column;
    if (lineDiff) {
      for (var l = 0; l !== lineDiff; l++) {
        mappings += ';';
      }
      mappings += vlq.encode([ start.column, 0, lineDiff, columnDiff ]);
    } else if (columnDiff) {
      if (i) {
        mappings += ',';
      }
      mappings += vlq.encode([ columnDiff, 0, lineDiff, columnDiff ]);
    }

    end = removedNodes[i].loc.end;
    mappings += ',';
    mappings += vlq.encode([ 0, 0, end.line - start.line, end.column - start.column ]);
  }

  return mappings;
}
