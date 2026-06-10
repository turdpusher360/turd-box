'use strict';

/**
 * trust-analyzer.cjs — Detect unsafe trust assumptions via regex
 *
 * Detects:
 *   - unchecked-null:        property chains of 3+ dots without optional chaining ?.
 *   - type-assertion-hiding: @type JSDoc casts or as unknown as double-cast patterns
 *   - missing-validation:    function parameters used directly in operations without guards
 *
 * Usage:
 *   node trust-analyzer.cjs <file-path>
 *
 * Output: JSON { findings: [{ type, line, text }] }
 */

const fs = require('node:fs');

/**
 * Scan a single source file for trust assumption issues.
 * @param {string} filePath
 * @returns {{ findings: Array<{type: string, line: number, text: string}> }}
 */
function scan(filePath) {
  let source;
  try {
    source = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    return { findings: [], error: `read_failed: ${err.message}` };
  }

  const lines = source.split('\n');
  const findings = [];

  // unchecked-null: property access chain with 3+ dot-accesses and NO optional chaining
  // Match: identifier.prop.prop.prop (without any ?. in the chain)
  // Exclude lines that already use ?. anywhere in the chain
  const deepChainRe = /\b\w+\.\w+\.\w+\.\w+/;
  const optionalChainRe = /\?\./;

  // type-assertion-hiding: JSDoc @type cast — /** @type {...} */ (expr)
  const jsdocTypeRe = /\/\*\*\s*@type\s*\{[^}]+\}\s*\*\//;
  // TypeScript double-cast: as unknown as Type
  const doubleAsRe = /\bas\s+unknown\s+as\b/;

  // missing-validation: spread of a function parameter without preceding validation
  // Heuristic: { id, ...param } or { ...payload } where payload is a function parameter
  // and no if/check precedes on nearby lines
  const spreadParamRe = /\{\s*\w+\s*,\s*\.\.\.\w+\s*\}|const\s+\w+\s*=\s*\{[^}]*\.\.\.\w+/;

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const text = lines[i];

    // unchecked-null: deep chain without optional chaining
    if (deepChainRe.test(text) && !optionalChainRe.test(text)) {
      // Skip comment lines and require/import lines
      const trimmed = text.trim();
      if (!trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.includes('require(')) {
        findings.push({ type: 'unchecked-null', line: lineNum, text: trimmed });
      }
    }

    // type-assertion-hiding: JSDoc @type cast or TS double-cast
    if (jsdocTypeRe.test(text) || doubleAsRe.test(text)) {
      findings.push({ type: 'type-assertion-hiding', line: lineNum, text: text.trim() });
    }

    // missing-validation: spread of parameter into object literal
    if (spreadParamRe.test(text)) {
      findings.push({ type: 'missing-validation', line: lineNum, text: text.trim() });
    }
  }

  return { findings };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

if (require.main === module) {
  const filePath = process.argv[2];
  if (!filePath) {
    process.stderr.write('Usage: node trust-analyzer.cjs <file-path>\n');
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(scan(filePath), null, 2) + '\n');
}

module.exports = { scan };
