'use strict';

/**
 * security-scanner.cjs — Detect common security vulnerabilities via regex
 *
 * Detects:
 *   - shell-injection:   execSync/exec called with template literal or string concat
 *   - path-traversal:    path.join where second arg is a function parameter
 *   - hardcoded-secret:  high-entropy string literals matching common API key patterns
 *
 * Usage:
 *   node security-scanner.cjs <file-path>
 *
 * Output: JSON { findings: [{ type, line, text }] }
 */

const fs = require('node:fs');

/**
 * Scan a single source file for security patterns.
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

  // Regex patterns
  // shell-injection: execSync( or exec( followed by a template literal (backtick) or string concat (+)
  const shellInjectionRe = /\bexec(?:Sync)?\s*\(\s*[`"'][^`"']*\$\{/;
  const shellInjectionConcatRe = /\bexec(?:Sync)?\s*\([^)]*\+/;

  // path-traversal: path.join( where arguments include a bare variable (function param or variable)
  // Heuristic: path.join with a second arg that is not a string literal
  const pathTraversalRe = /\bpath\.join\s*\(\s*['"`][^'"`]+['"`]\s*,\s*(?!['"`])\w+/;

  // hardcoded-secret: common API key prefixes followed by long alphanumeric strings
  const hardcodedSecretRe = /['"`](sk-[a-zA-Z0-9_-]{20,}|pk_[a-zA-Z0-9_-]{20,}|AKIA[0-9A-Z]{16}|[a-zA-Z0-9_-]{40,})['"`]/;

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const text = lines[i];

    if (shellInjectionRe.test(text) || shellInjectionConcatRe.test(text)) {
      findings.push({ type: 'shell-injection', line: lineNum, text: text.trim() });
    }

    if (pathTraversalRe.test(text)) {
      findings.push({ type: 'path-traversal', line: lineNum, text: text.trim() });
    }

    if (hardcodedSecretRe.test(text)) {
      findings.push({ type: 'hardcoded-secret', line: lineNum, text: text.trim() });
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
    process.stderr.write('Usage: node security-scanner.cjs <file-path>\n');
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(scan(filePath), null, 2) + '\n');
}

module.exports = { scan };
