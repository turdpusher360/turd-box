'use strict';

/**
 * provenance-scanner.cjs — Detect adversarial content and obfuscated payloads
 *
 * Detects:
 *   - instruction-injection: AI instruction override directives in comments
 *                            (SYSTEM:, Ignore all previous, Do not flag)
 *   - hidden-fetch:          Buffer.from(...base64...).toString('utf8') pattern
 *                            used to obfuscate URLs or endpoints
 *   - encoded-payload:       Buffer.from(hex/base64 string).toString followed by eval()
 *
 * Usage:
 *   node provenance-scanner.cjs <file-path>
 *
 * Output: JSON { findings: [{ type, line, text }] }
 */

const fs = require('node:fs');

/**
 * Scan a single source file for provenance/adversarial patterns.
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

  // instruction-injection: AI override patterns in comments or strings
  // Patterns: "SYSTEM:", "Ignore all previous", "Do not flag", "ignore previous instructions"
  const injectionRe = /\bSYSTEM\s*:|Ignore all previous|Do not flag|ignore previous instructions/i;

  // hidden-fetch: Buffer.from(<base64-string>, 'base64').toString('utf8')
  // The base64 string must be long enough to encode a URL (>=20 chars)
  const hiddenFetchRe = /Buffer\.from\s*\(\s*['"`][A-Za-z0-9+/=]{20,}['"`]\s*,\s*['"`]base64['"`]\s*\)\s*\.toString\s*\(\s*['"`]utf8?['"`]\s*\)/;

  // encoded-payload: Buffer.from with hex encoding, followed by eval (possibly on next lines)
  // Detect the Buffer.from hex decode pattern as the signal
  const encodedPayloadRe = /Buffer\.from\s*\(\s*['"`][0-9a-fA-F]{20,}['"`]\s*,\s*['"`]hex['"`]\s*\)\s*\.toString\s*\(\s*['"`]utf8?['"`]\s*\)/;

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const text = lines[i];

    // instruction-injection
    if (injectionRe.test(text)) {
      findings.push({ type: 'instruction-injection', line: lineNum, text: text.trim() });
    }

    // hidden-fetch: base64-encoded URL construction
    if (hiddenFetchRe.test(text)) {
      findings.push({ type: 'hidden-fetch', line: lineNum, text: text.trim() });
    }

    // encoded-payload: hex-encoded eval target
    if (encodedPayloadRe.test(text)) {
      findings.push({ type: 'encoded-payload', line: lineNum, text: text.trim() });
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
    process.stderr.write('Usage: node provenance-scanner.cjs <file-path>\n');
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(scan(filePath), null, 2) + '\n');
}

module.exports = { scan };
