'use strict';

/**
 * runtime-checker.cjs — Detect runtime environment mismatches and async errors
 *
 * Detects:
 *   - missing-await:        fetch() called without await in an async context
 *   - browser-api-in-node:  localStorage/sessionStorage/document usage in .cjs/.js files
 *   - global-mutable-state: module-level mutable variable declarations (let/var at top scope)
 *
 * Usage:
 *   node runtime-checker.cjs <file-path>
 *
 * Output: JSON { findings: [{ type, line, text }] }
 */

const fs = require('node:fs');
const path = require('node:path');

/**
 * Scan a single source file for runtime environment issues.
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

  const ext = path.extname(filePath).toLowerCase();
  const isNodeFile = ['.cjs', '.js', '.mjs'].includes(ext);

  const lines = source.split('\n');
  const findings = [];

  // missing-await: const/let/var x = fetch( without await
  // Must NOT have 'await' immediately preceding fetch
  const missingAwaitRe = /\b(?:const|let|var)\s+\w+\s*=\s*fetch\s*\(/;
  const hasAwaitRe = /\bawait\s+fetch\s*\(/;

  // browser-api-in-node: direct use of browser globals
  const browserApiRe = /\blocalStorage\b|\bsessionStorage\b|\bdocument\./;

  // global-mutable-state: top-level let/var declarations (not inside function/class/block)
  // Simple heuristic: line starts with let/var (after optional whitespace of 0-1 level)
  const globalMutableRe = /^(?:let|var)\s+\w+/;

  // Track brace depth to identify top-level scope
  let braceDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const text = lines[i];

    // Update brace depth before checking global scope
    const openBraces = (text.match(/\{/g) || []).length;
    const closeBraces = (text.match(/\}/g) || []).length;

    // missing-await check
    if (missingAwaitRe.test(text) && !hasAwaitRe.test(text)) {
      findings.push({ type: 'missing-await', line: lineNum, text: text.trim() });
    }

    // browser-api-in-node: only flag in node-targeted files
    if (isNodeFile && browserApiRe.test(text)) {
      findings.push({ type: 'browser-api-in-node', line: lineNum, text: text.trim() });
    }

    // global-mutable-state: only flag top-level declarations (braceDepth === 0)
    if (braceDepth === 0 && globalMutableRe.test(text.trimStart())) {
      findings.push({ type: 'global-mutable-state', line: lineNum, text: text.trim() });
    }

    braceDepth += openBraces - closeBraces;
    if (braceDepth < 0) braceDepth = 0;
  }

  return { findings };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

if (require.main === module) {
  const filePath = process.argv[2];
  if (!filePath) {
    process.stderr.write('Usage: node runtime-checker.cjs <file-path>\n');
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(scan(filePath), null, 2) + '\n');
}

module.exports = { scan };
