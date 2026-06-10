'use strict';

const ts = require('typescript');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

/**
 * Analyze a single file using the TypeScript compiler API.
 * @param {string} filePath - Absolute path to the file
 * @param {Object} [opts] - Options
 * @param {string} [opts.check] - Filter: 'signatures' | 'imports' | 'unreachable' | 'all'
 * @param {string[]} [opts.fileSet] - Full file set for dead export detection
 * @returns {Object} Analysis result
 */
function analyzeFile(filePath, opts = {}) {
  const check = opts.check || 'all';
  let source;

  try {
    source = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    return { path: filePath, error: `read_failed: ${err.message}`, partial_results: [] };
  }

  const ext = path.extname(filePath);
  const scriptKind = ['.ts', '.tsx'].includes(ext) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, scriptKind);

  const functions = [];
  const imports = [];
  const exports = [];
  const unreachable = [];
  const exportedNames = new Set();

  // Collect CJS module.exports names
  function collectCjsExports(node) {
    // module.exports = { name1, name2 }
    if (
      ts.isBinaryExpression(node) &&
      ts.isPropertyAccessExpression(node.left) &&
      node.left.expression.getText(sourceFile) === 'module' &&
      node.left.name.getText(sourceFile) === 'exports'
    ) {
      if (ts.isObjectLiteralExpression(node.right)) {
        for (const prop of node.right.properties) {
          if (ts.isShorthandPropertyAssignment(prop)) {
            exportedNames.add(prop.name.getText(sourceFile));
            exports.push({ name: prop.name.getText(sourceFile), line: getLine(prop) });
          } else if (ts.isPropertyAssignment(prop)) {
            exportedNames.add(prop.name.getText(sourceFile));
            exports.push({ name: prop.name.getText(sourceFile), line: getLine(prop) });
          }
        }
      }
    }

    // module.exports.name = value
    if (
      ts.isBinaryExpression(node) &&
      ts.isPropertyAccessExpression(node.left) &&
      ts.isPropertyAccessExpression(node.left.expression) &&
      node.left.expression.expression.getText(sourceFile) === 'module' &&
      node.left.expression.name.getText(sourceFile) === 'exports'
    ) {
      const name = node.left.name.getText(sourceFile);
      exportedNames.add(name);
      exports.push({ name, line: getLine(node) });
    }
  }

  // Collect ESM exports
  function collectEsmExports(node) {
    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const spec of node.exportClause.elements) {
        const name = spec.name.getText(sourceFile);
        exportedNames.add(name);
        exports.push({ name, line: getLine(spec) });
      }
    }
  }

  function getLine(node) {
    return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  }

  function resolveImport(specifier) {
    // Built-in modules
    if (specifier.startsWith('node:') || Module.builtinModules.includes(specifier)) {
      return true;
    }
    // Relative paths
    if (specifier.startsWith('.') || specifier.startsWith('/')) {
      const dir = path.dirname(filePath);
      const exts = ['.cjs', '.js', '.mjs', '.ts', '.tsx', '.json', ''];
      for (const ext of exts) {
        if (fs.existsSync(path.resolve(dir, specifier + ext))) return true;
        if (fs.existsSync(path.resolve(dir, specifier, 'index' + ext))) return true;
      }
      // Try exact path
      if (fs.existsSync(path.resolve(dir, specifier))) return true;
      return false;
    }
    // Package imports — check node_modules
    try {
      require.resolve(specifier, { paths: [path.dirname(filePath)] });
      return true;
    } catch {
      return false;
    }
  }

  function visit(node) {
    // Function declarations
    if (ts.isFunctionDeclaration(node) && node.name) {
      const name = node.name.getText(sourceFile);
      const params = node.parameters.map((p) => p.name.getText(sourceFile));
      const returnType = node.type ? node.type.getText(sourceFile) : 'void';
      functions.push({
        name,
        line: getLine(node),
        params,
        returnType,
        exported: false, // set after export collection
      });
    }

    // ESM export function
    if (
      ts.isFunctionDeclaration(node) &&
      node.name &&
      node.modifiers &&
      node.modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      exportedNames.add(node.name.getText(sourceFile));
      exports.push({ name: node.name.getText(sourceFile), line: getLine(node) });
    }

    // CJS require() calls
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.getText(sourceFile) === 'require' &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      const specifier = node.arguments[0].text;
      const specifiers = [];

      // Check if parent is destructuring: const { a, b } = require('...')
      const parent = node.parent;
      if (parent && ts.isVariableDeclaration(parent) && ts.isObjectBindingPattern(parent.name)) {
        for (const element of parent.name.elements) {
          specifiers.push(element.name.getText(sourceFile));
        }
      }

      imports.push({
        source: specifier,
        specifiers,
        line: getLine(node),
        resolved: resolveImport(specifier),
      });
    }

    // ESM import declarations
    if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      const specifiers = [];

      if (node.importClause) {
        if (node.importClause.name) {
          specifiers.push(node.importClause.name.getText(sourceFile));
        }
        if (node.importClause.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
          for (const element of node.importClause.namedBindings.elements) {
            specifiers.push(element.name.getText(sourceFile));
          }
        }
      }

      imports.push({
        source: specifier,
        specifiers,
        line: getLine(node),
        resolved: resolveImport(specifier),
      });
    }

    collectCjsExports(node);
    collectEsmExports(node);

    ts.forEachChild(node, visit);
  }

  ts.forEachChild(sourceFile, visit);

  // Mark exported functions
  for (const fn of functions) {
    fn.exported = exportedNames.has(fn.name);
  }

  // Amendment A4: Detect unreachable code after return/throw/break/continue
  if (check === 'all' || check === 'unreachable') {
    function detectUnreachable(node, enclosingFnName) {
      if (ts.isBlock(node)) {
        const stmts = node.statements;
        for (let i = 0; i < stmts.length - 1; i++) {
          const kind = stmts[i].kind;
          if (
            kind === ts.SyntaxKind.ReturnStatement ||
            kind === ts.SyntaxKind.ThrowStatement ||
            kind === ts.SyntaxKind.BreakStatement ||
            kind === ts.SyntaxKind.ContinueStatement
          ) {
            // All statements after this one in the same block are unreachable
            for (let j = i + 1; j < stmts.length; j++) {
              unreachable.push({
                function: enclosingFnName || '<module>',
                line: getLine(stmts[j]),
                after: ts.SyntaxKind[kind],
                code: stmts[j].getText(sourceFile).slice(0, 80),
              });
            }
            break; // Only report the first unreachable block per scope
          }
        }
      }
      ts.forEachChild(node, (child) => {
        let fnName = enclosingFnName;
        if (ts.isFunctionDeclaration(child) && child.name) {
          fnName = child.name.getText(sourceFile);
        }
        detectUnreachable(child, fnName);
      });
    }
    detectUnreachable(sourceFile, null);
  }

  // Amendment A4: Detect dead exports (exported but not imported by any file in fileSet)
  let deadExports = [];
  if (check === 'all' && opts.fileSet && opts.fileSet.length > 0) {
    const resolvedFilePath = path.resolve(filePath);
    // Collect all import specifiers from other files in the set
    const externalImports = new Set();
    for (const otherFile of opts.fileSet) {
      if (path.resolve(otherFile) === resolvedFilePath) continue;
      try {
        const otherSource = fs.readFileSync(otherFile, 'utf8');
        const otherExt = path.extname(otherFile);
        const otherKind = ['.ts', '.tsx'].includes(otherExt) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
        const otherSf = ts.createSourceFile(otherFile, otherSource, ts.ScriptTarget.Latest, true, otherKind);
        function collectImportedNames(n) {
          // CJS: const { name } = require('./...')
          if (
            ts.isVariableDeclaration(n) && n.initializer &&
            ts.isCallExpression(n.initializer) &&
            ts.isIdentifier(n.initializer.expression) &&
            n.initializer.expression.getText(otherSf) === 'require' &&
            n.initializer.arguments.length === 1 &&
            ts.isStringLiteral(n.initializer.arguments[0])
          ) {
            if (ts.isObjectBindingPattern(n.name)) {
              for (const el of n.name.elements) {
                externalImports.add(el.name.getText(otherSf));
              }
            }
          }
          // ESM: import { name } from './...'
          if (ts.isImportDeclaration(n) && n.importClause && n.importClause.namedBindings &&
              ts.isNamedImports(n.importClause.namedBindings)) {
            for (const el of n.importClause.namedBindings.elements) {
              externalImports.add(el.name.getText(otherSf));
            }
          }
          ts.forEachChild(n, collectImportedNames);
        }
        ts.forEachChild(otherSf, collectImportedNames);
      } catch {
        // Skip unreadable files
      }
    }
    // Exports from this file that are not imported by any other file in the set
    deadExports = exports
      .filter((e) => !externalImports.has(e.name))
      .map((e) => ({ name: e.name, line: e.line }));
  }

  // Build result based on check filter
  const result = { path: filePath };

  if (check === 'all' || check === 'signatures') {
    result.functions = functions;
  }
  if (check === 'all' || check === 'imports') {
    result.imports = imports;
  }
  if (check === 'all') {
    result.exports = exports;
    result.unreachable = unreachable;
    result.dead_exports = deadExports;
  }

  return result;
}

/**
 * Analyze multiple files.
 * @param {string[]} filePaths - Array of file paths
 * @param {Object} [opts] - Options
 * @returns {Object} Multi-file analysis result
 */
function analyze(filePaths, opts = {}) {
  const files = filePaths.map((fp) => analyzeFile(fp, { ...opts, fileSet: filePaths }));
  return { files };
}

// CLI entry point
if (require.main === module) {
  const args = process.argv.slice(2);
  const filePaths = [];
  const opts = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--check' && args[i + 1]) {
      opts.check = args[++i];
    } else {
      filePaths.push(path.resolve(args[i]));
    }
  }

  if (filePaths.length === 0) {
    process.stderr.write('Usage: node ast-analyzer.cjs <file> [<file>...] [--check signatures|unreachable|imports|all]\n');
    process.exit(1);
  }

  const result = analyze(filePaths, opts);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

module.exports = { analyzeFile, analyze };
