'use strict';

/**
 * logic-analyzer.cjs — Detect common logic errors via regex
 *
 * Detects:
 *   - off-by-one:        for-loop using <= with .length (should be <)
 *   - inverted-boolean:  functions named isAllowed/hasPermission/canAccess/hasAdminAccess
 *                        containing a negated role/permission check that returns truthy
 *   - falsy-value:       !value ternary that treats 0/empty-string as missing
 *
 * Usage:
 *   node logic-analyzer.cjs <file-path>
 *
 * Output: JSON { findings: [{ type, line, text }] }
 */

const fs = require('node:fs');

/**
 * Scan a single source file for logic error patterns.
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

  // off-by-one: for loop using <= someVar.length
  const offByOneRe = /\bfor\s*\([^)]*<=\s*\w+\.length/;

  // inverted-boolean: function body contains !== 'admin' (or similar negated role check)
  // and returns true/truthy in the positive branch
  const invertedBoolRe = /!==\s*['"`]admin['"`]/;
  // also catch patterns like: role !== 'user', permission !== 'allowed'
  const invertedBoolBroadRe = /\b\w+\s*!==\s*['"`]\w+['"`]/;

  // falsy-value: !value ternary pattern — !value ? default : value
  const falsyValueRe = /!\s*\w+\s*\?/;

  // Track whether we are inside a permission-gating function
  // We look for functions whose name contains access/permission/allowed/admin
  const accessFuncRe = /\b(?:function|const|let|var)\s+(?:isAllowed|hasPermission|canAccess|hasAdminAccess|isAdmin|checkAccess)\b/;

  let inAccessFunc = false;
  let braceDepth = 0;
  let accessFuncStartLine = -1;

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const text = lines[i];

    // Track access-function scope
    if (accessFuncRe.test(text)) {
      inAccessFunc = true;
      accessFuncStartLine = lineNum;
      braceDepth = 0;
    }
    if (inAccessFunc) {
      braceDepth += (text.match(/\{/g) || []).length;
      braceDepth -= (text.match(/\}/g) || []).length;
      if (braceDepth <= 0 && accessFuncStartLine !== lineNum) {
        inAccessFunc = false;
      }
    }

    // off-by-one detection
    if (offByOneRe.test(text)) {
      findings.push({ type: 'off-by-one', line: lineNum, text: text.trim() });
    }

    // inverted-boolean: negated role/status check inside access-gating functions
    if (inAccessFunc && invertedBoolRe.test(text)) {
      findings.push({ type: 'inverted-boolean', line: lineNum, text: text.trim() });
    }

    // falsy-value: !value ternary — skip pure comment lines only
    if (falsyValueRe.test(text) && !/^\s*\/\//.test(text)) {
      findings.push({ type: 'falsy-value', line: lineNum, text: text.trim() });
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
    process.stderr.write('Usage: node logic-analyzer.cjs <file-path>\n');
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(scan(filePath), null, 2) + '\n');
}

module.exports = { scan };
