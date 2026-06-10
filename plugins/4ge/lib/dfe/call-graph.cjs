// lib/dfe/call-graph.cjs
'use strict';

const ts = require('typescript');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_DEPTH = 5;

/**
 * Escape a string for safe use in a RegExp constructor.
 * @param {string} str
 * @returns {string}
 */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Load taint sinks configuration.
 * @returns {Object} Sinks grouped by category
 */
function loadSinks() {
  const configPath = path.join(__dirname, 'config', 'taint-sinks.json');
  try {
    const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return data.sinks || {};
  } catch {
    return {};
  }
}

/**
 * Load taint sanitizers configuration.
 * @returns {Array} Sanitizer entries
 */
function loadSanitizers() {
  const configPath = path.join(__dirname, 'config', 'taint-sanitizers.json');
  try {
    const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return data.sanitizers || [];
  } catch {
    return [];
  }
}

/**
 * Parse a source file and extract function-to-function call relationships.
 * @param {string} filePath
 * @returns {Object} { functions: Map<name, {params, line, calls}>, requireMap: Map<alias, resolvedPath> }
 */
function parseFileCalls(filePath) {
  let source;
  try {
    source = fs.readFileSync(filePath, 'utf8');
  } catch {
    return { functions: new Map(), requireMap: new Map() };
  }

  const ext = path.extname(filePath);
  const scriptKind = ['.ts', '.tsx'].includes(ext) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, scriptKind);

  const functions = new Map();
  const requireMap = new Map();

  function getLine(node) {
    return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  }

  // Collect require() imports
  function collectRequires(node) {
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      node.initializer.expression.getText(sf) === 'require' &&
      node.initializer.arguments.length === 1 &&
      ts.isStringLiteral(node.initializer.arguments[0])
    ) {
      const specifier = node.initializer.arguments[0].text;
      if (specifier.startsWith('.')) {
        const resolved = resolveRelative(filePath, specifier);
        if (ts.isObjectBindingPattern(node.name)) {
          for (const el of node.name.elements) {
            requireMap.set(el.name.getText(sf), { resolved, exportName: el.name.getText(sf) });
          }
        } else if (ts.isIdentifier(node.name)) {
          requireMap.set(node.name.getText(sf), { resolved, exportName: '*' });
        }
      }
    }
    ts.forEachChild(node, collectRequires);
  }

  // Collect function declarations and their calls
  function collectFunctions(node) {
    if (ts.isFunctionDeclaration(node) && node.name) {
      const name = node.name.getText(sf);
      const params = node.parameters.map((p) => p.name.getText(sf));
      const calls = [];
      collectCallsInBody(node, calls);
      functions.set(name, { name, params, line: getLine(node), calls, file: filePath });
    }
    ts.forEachChild(node, collectFunctions);
  }

  function collectCallsInBody(node, calls) {
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(sf);
      calls.push({ callee, line: getLine(node), args: node.arguments.map((a) => a.getText(sf)) });
    }
    ts.forEachChild(node, (child) => collectCallsInBody(child, calls));
  }

  ts.forEachChild(sf, collectRequires);
  ts.forEachChild(sf, collectFunctions);

  return { functions, requireMap };
}

function resolveRelative(fromFile, specifier) {
  const dir = path.dirname(fromFile);
  const exts = ['.cjs', '.js', '.mjs', '.ts', ''];
  for (const ext of exts) {
    const candidate = path.resolve(dir, specifier + ext);
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.resolve(dir, specifier);
}

/**
 * Build a call graph starting from an entry file.
 * @param {Object} opts
 * @param {string} opts.entry - Entry file path
 * @param {number} [opts.depth] - Max traversal depth
 * @param {string} [opts.trace] - Specific function to trace
 * @returns {Object} Call graph { nodes, edges, truncated, max_depth_reached }
 */
function buildGraph(opts) {
  const maxDepth = opts.depth !== undefined ? opts.depth : DEFAULT_DEPTH;
  const entryPath = path.resolve(opts.entry);

  if (!fs.existsSync(entryPath)) {
    return { error: `entry file not found: ${entryPath}`, nodes: [], edges: [], truncated: false, max_depth_reached: 0 };
  }

  const nodes = [];
  const edges = [];
  const visited = new Set();
  let maxReached = 0;
  let wasTruncated = false;

  function processFile(filePath, depth) {
    if (depth > maxDepth) {
      wasTruncated = true;
      return;
    }
    if (visited.has(filePath)) return;
    visited.add(filePath);
    if (depth > maxReached) maxReached = depth;

    const { functions, requireMap } = parseFileCalls(filePath);
    const base = path.basename(filePath);

    for (const [name, fn] of functions) {
      const nodeId = `${base}::${name}`;
      nodes.push({ id: nodeId, file: filePath, line: fn.line });

      for (const call of fn.calls) {
        const imported = requireMap.get(call.callee.split('.')[0]);
        if (imported && imported.resolved) {
          const targetBase = path.basename(imported.resolved);
          const targetFn = call.callee.includes('.') ? call.callee.split('.')[1] : imported.exportName;
          const targetId = `${targetBase}::${targetFn}`;
          edges.push({ from: nodeId, to: targetId, type: 'call', line: call.line });
          processFile(imported.resolved, depth + 1);
        } else {
          // Local call within same file
          if (functions.has(call.callee)) {
            edges.push({ from: nodeId, to: `${base}::${call.callee}`, type: 'call', line: call.line });
          }
        }
      }
    }
  }

  processFile(entryPath, 0);

  return {
    nodes,
    edges,
    truncated: wasTruncated,
    max_depth_reached: maxReached,
  };
}

/**
 * Run taint analysis from a specific function parameter.
 * @param {Object} opts
 * @param {string} opts.entry - File path
 * @param {string} opts.taintParam - Parameter name to trace
 * @param {string} opts.traceFunction - Function containing the parameter
 * @returns {Object} Taint analysis result
 */
function taintAnalysis(opts) {
  const entryPath = path.resolve(opts.entry);
  const sinks = loadSinks();
  const sanitizers = loadSanitizers();

  if (!fs.existsSync(entryPath)) {
    return { error: `entry file not found: ${entryPath}`, tainted_paths: [] };
  }

  // Build a flat set of all sink function names
  const sinkNames = new Set();
  const sinkRiskMap = {};
  for (const [, entries] of Object.entries(sinks)) {
    for (const entry of entries) {
      sinkNames.add(entry.function);
      sinkRiskMap[entry.function] = entry.risk;
    }
  }

  // Build a set of sanitizer function names
  const sanitizerMap = new Map(sanitizers.filter((s) => s.cleans && s.cleans.length > 0).map((s) => [s.function, s.cleans]));

  const { functions } = parseFileCalls(entryPath);
  const targetFn = functions.get(opts.traceFunction);

  if (!targetFn) {
    return { error: `function '${opts.traceFunction}' not found in ${entryPath}`, tainted_paths: [] };
  }

  // Simple intra-procedural taint tracking
  const taintedVars = new Set([opts.taintParam]);
  const taintedPaths = [];

  let source;
  try {
    source = fs.readFileSync(entryPath, 'utf8');
  } catch {
    return { error: `read failed: ${entryPath}`, tainted_paths: [] };
  }

  const ext = path.extname(entryPath);
  const scriptKind = ['.ts', '.tsx'].includes(ext) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const sf = ts.createSourceFile(entryPath, source, ts.ScriptTarget.Latest, true, scriptKind);

  // Find the function node
  let fnNode = null;
  function findFn(node) {
    if (ts.isFunctionDeclaration(node) && node.name && node.name.getText(sf) === opts.traceFunction) {
      fnNode = node;
    }
    ts.forEachChild(node, findFn);
  }
  ts.forEachChild(sf, findFn);

  if (!fnNode) {
    return { error: `function node '${opts.traceFunction}' not found`, tainted_paths: [] };
  }

  function getLine(node) {
    return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  }

  // Walk the function body and track taint propagation
  function walkTaint(node) {
    // Variable declaration: const x = <expr> -- if expr uses tainted var, x is tainted
    if (ts.isVariableDeclaration(node) && node.name && ts.isIdentifier(node.name) && node.initializer) {
      const initText = node.initializer.getText(sf);
      const varName = node.name.getText(sf);

      // Check if initializer references a tainted var
      let isTainted = false;
      for (const tv of taintedVars) {
        if (new RegExp('\\b' + escapeRegex(tv) + '\\b').test(initText)) {
          isTainted = true;
          break;
        }
      }

      // Check if it passes through a sanitizer
      if (isTainted && ts.isCallExpression(node.initializer)) {
        const callee = node.initializer.expression.getText(sf);
        const calleeName = callee.split('.').pop();
        if (sanitizerMap.has(calleeName)) {
          isTainted = false;
        }
      }

      if (isTainted) {
        taintedVars.add(varName);
      }
    }

    // Call expression: check if a tainted var reaches a sink
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(sf);
      const calleeName = callee.split('.').pop();

      if (sinkNames.has(calleeName)) {
        // Check if any argument is tainted
        for (const arg of node.arguments) {
          const argText = arg.getText(sf);
          for (const tv of taintedVars) {
            if (new RegExp('\\b' + escapeRegex(tv) + '\\b').test(argText)) {
              taintedPaths.push({
                source: {
                  function: opts.traceFunction,
                  param: opts.taintParam,
                  file: entryPath,
                  line: targetFn.line,
                },
                sink: {
                  function: calleeName,
                  file: entryPath,
                  line: getLine(node),
                },
                path: [...taintedVars, calleeName],
                risk: sinkRiskMap[calleeName] || 'unsanitized input reaches dangerous function',
              });
              break;
            }
          }
        }
      }
    }

    ts.forEachChild(node, walkTaint);
  }

  if (fnNode.body) {
    ts.forEachChild(fnNode.body, walkTaint);
  }

  return { tainted_paths: taintedPaths };
}

// CLI entry point
if (require.main === module) {
  const args = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--entry' && args[i + 1]) opts.entry = args[++i];
    if (args[i] === '--depth' && args[i + 1]) opts.depth = parseInt(args[++i], 10);
    if (args[i] === '--trace' && args[i + 1]) opts.trace = args[++i];
    if (args[i] === '--taint' && args[i + 1]) opts.taintParam = args[++i];
  }

  if (!opts.entry) {
    process.stderr.write('Usage: node call-graph.cjs --entry <file> [--depth 3] [--trace <fn>] [--taint <param>]\n');
    process.exit(1);
  }

  if (opts.taintParam && opts.trace) {
    const result = taintAnalysis({ entry: opts.entry, taintParam: opts.taintParam, traceFunction: opts.trace });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    const result = buildGraph(opts);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  }
}

module.exports = { buildGraph, taintAnalysis, loadSinks, loadSanitizers };
