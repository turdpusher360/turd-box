// lib/dfe/complexity-scorer.cjs
'use strict';

const ts = require('typescript');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_THRESHOLDS = {
  complex: 10,
  deep_nesting: 4,
  long: 50,
  high_complexity: 25,
};

/**
 * Compute cyclomatic complexity and nesting depth for all functions in a file.
 * @param {string} filePath - Absolute file path
 * @param {Object} [thresholds] - Custom thresholds
 * @returns {Object} File scoring result
 */
function scoreFile(filePath, thresholds = {}) {
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };
  let source;

  try {
    source = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    return { path: filePath, error: `read_failed: ${err.message}`, functions: [], file_complexity: 0, flags: [] };
  }

  if (!source.trim()) {
    return { path: filePath, functions: [], file_complexity: 0, flags: [] };
  }

  const ext = path.extname(filePath);
  const scriptKind = ['.ts', '.tsx'].includes(ext) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, scriptKind);

  const functions = [];

  function getLine(node) {
    return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  }

  function getEndLine(node) {
    return sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
  }

  function countBranches(node) {
    let count = 0;
    function walk(n) {
      switch (n.kind) {
        case ts.SyntaxKind.IfStatement:
        case ts.SyntaxKind.ForStatement:
        case ts.SyntaxKind.ForInStatement:
        case ts.SyntaxKind.ForOfStatement:
        case ts.SyntaxKind.WhileStatement:
        case ts.SyntaxKind.DoStatement:
        case ts.SyntaxKind.CaseClause:
        case ts.SyntaxKind.CatchClause:
        case ts.SyntaxKind.ConditionalExpression:
          count++;
          break;
        case ts.SyntaxKind.BinaryExpression: {
          const op = n.operatorToken.kind;
          if (
            op === ts.SyntaxKind.AmpersandAmpersandToken ||
            op === ts.SyntaxKind.BarBarToken ||
            op === ts.SyntaxKind.QuestionQuestionToken
          ) {
            count++;
          }
          break;
        }
      }
      ts.forEachChild(n, walk);
    }
    ts.forEachChild(node, walk);
    return count;
  }

  function computeMaxNesting(node) {
    let maxDepth = 0;
    function walk(n, depth) {
      let newDepth = depth;
      switch (n.kind) {
        case ts.SyntaxKind.IfStatement:
        case ts.SyntaxKind.ForStatement:
        case ts.SyntaxKind.ForInStatement:
        case ts.SyntaxKind.ForOfStatement:
        case ts.SyntaxKind.WhileStatement:
        case ts.SyntaxKind.DoStatement:
        case ts.SyntaxKind.SwitchStatement:
        case ts.SyntaxKind.TryStatement:
          newDepth = depth + 1;
          if (newDepth > maxDepth) maxDepth = newDepth;
          break;
      }
      ts.forEachChild(n, (child) => walk(child, newDepth));
    }
    ts.forEachChild(node, (child) => walk(child, 0));
    return maxDepth;
  }

  function visitFunctions(node) {
    if (ts.isFunctionDeclaration(node) && node.name) {
      const name = node.name.getText(sourceFile);
      const line = getLine(node);
      const lineCount = getEndLine(node) - line + 1;
      const cyclomatic = 1 + countBranches(node);
      const maxNesting = computeMaxNesting(node);

      const flags = [];
      if (cyclomatic > t.complex) flags.push('complex');
      if (maxNesting > t.deep_nesting) flags.push('deep-nesting');
      if (lineCount > t.long) flags.push('long');

      functions.push({ name, line, cyclomatic, max_nesting: maxNesting, line_count: lineCount, flags });
    }

    // Also handle function expressions assigned to variables
    if (
      ts.isVariableDeclaration(node) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isFunctionExpression(node.initializer) || ts.isArrowFunction(node.initializer))
    ) {
      const name = node.name.getText(sourceFile);
      const fnNode = node.initializer;
      const line = getLine(node);
      const lineCount = getEndLine(fnNode) - line + 1;
      const cyclomatic = 1 + countBranches(fnNode);
      const maxNesting = computeMaxNesting(fnNode);

      const flags = [];
      if (cyclomatic > t.complex) flags.push('complex');
      if (maxNesting > t.deep_nesting) flags.push('deep-nesting');
      if (lineCount > t.long) flags.push('long');

      functions.push({ name, line, cyclomatic, max_nesting: maxNesting, line_count: lineCount, flags });
    }

    ts.forEachChild(node, visitFunctions);
  }

  ts.forEachChild(sourceFile, visitFunctions);

  const fileComplexity = functions.reduce((sum, f) => sum + f.cyclomatic, 0);
  const fileFlags = [];
  if (fileComplexity > t.high_complexity) fileFlags.push('high-complexity');

  return { path: filePath, functions, file_complexity: fileComplexity, flags: fileFlags };
}

/**
 * Score multiple files.
 * @param {string[]} filePaths
 * @param {Object} [thresholds]
 * @returns {Object}
 */
function score(filePaths, thresholds = {}) {
  const files = filePaths.map((fp) => scoreFile(fp, thresholds));
  return { files };
}

// CLI entry point
if (require.main === module) {
  const args = process.argv.slice(2);
  const filePaths = [];
  let thresholds = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--thresholds' && args[i + 1]) {
      try { thresholds = JSON.parse(args[++i]); } catch { /* ignore */ }
    } else {
      filePaths.push(path.resolve(args[i]));
    }
  }

  if (filePaths.length === 0) {
    process.stderr.write('Usage: node complexity-scorer.cjs <file> [<file>...] [--thresholds <json>]\n');
    process.exit(1);
  }

  const result = score(filePaths, thresholds);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

module.exports = { scoreFile, score, DEFAULT_THRESHOLDS };
