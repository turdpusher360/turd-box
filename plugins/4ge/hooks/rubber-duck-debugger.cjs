'use strict';

const fs = require('fs');
const path = require('path');

const WINDOW_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Normalizes an error message by removing volatile parts (paths, line numbers, timestamps).
 *
 * @param {string} msg
 * @returns {string}
 */
function normalizeError(msg) {
  return (msg || '')
    .replace(/\/[\w/.-]+:\d+:\d+/g, '<path>') // Unix file paths with line:col
    .replace(/[A-Z]:\\[\w\\.-]+:\d+:\d+/g, '<path>') // Windows paths with line:col
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[.\d]*Z?/g, '<timestamp>')
    .replace(/\d{10,13}/g, '<epoch>')
    .trim();
}

/**
 * Detects 3+ consecutive failures with the same normalized error within the window.
 *
 * Scans from the most-recent entry backwards; stops counting as soon as the
 * normalized error differs.
 *
 * @param {Array<{timestamp: string, error: string, tool: string}>} failures
 * @param {number} nowMs - Current time in ms (injectable for testing)
 * @returns {{ triggered: boolean, count: number, normalizedError: string }}
 */
function detectConsecutiveFailures(failures, nowMs) {
  const windowStart = nowMs - WINDOW_MS;
  const recent = failures.filter(f => new Date(f.timestamp).getTime() >= windowStart);

  if (recent.length < 3) return { triggered: false, count: 0, normalizedError: '' };

  // Count consecutive same-error from the end of the window-filtered list
  const lastNorm = normalizeError(recent[recent.length - 1].error);
  let count = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    if (normalizeError(recent[i].error) === lastNorm) {
      count++;
    } else {
      break;
    }
  }

  return {
    triggered: count >= 3,
    count,
    normalizedError: lastNorm,
  };
}

/**
 * Generates a Socratic prompt to help break out of a failure loop.
 *
 * @param {string} error - Normalized error message
 * @param {number} count - Number of times the error has been seen
 * @returns {string}
 */
function generateSocraticPrompt(error, count) {
  return [
    `[rubber-duck] You have hit the same error ${count} times in 5 minutes.`,
    `Error: ${error.slice(0, 200)}`,
    '',
    'Before retrying, pause and evaluate:',
    '1. What assumptions are you making about the cause?',
    '2. Is there a different root cause you have not checked?',
    '3. Have you verified the inputs to the failing operation?',
    '4. Would a different approach bypass this error entirely?',
    '',
    'Consider: step back, read the relevant source, and verify your mental model.',
  ].join('\n');
}

// Hook entry point — PostToolUseFailure event
if (require.main === module) {
  (async () => {
    const { readStdinJson } = require('./hook-utils.cjs');
    const data = await readStdinJson();

    // Read recent failures from JSONL written by post-tool-failure-tracker.cjs
    const failurePath = path.join(data.cwd || process.cwd(), '_runs', 'tool-failures.jsonl');
    let failures = [];
    if (fs.existsSync(failurePath)) {
      try {
        const lines = fs.readFileSync(failurePath, 'utf8').trim().split('\n').filter(Boolean);
        failures = lines
          .map(l => { try { return JSON.parse(l); } catch { return null; } })
          .filter(Boolean);
      } catch { /* best effort — don't crash on unreadable log */ }
    }

    // Append current failure to the log for future runs
    // PostToolUseFailure sends error at the top level of the input object (same as tool_name, is_interrupt)
    const currentError = data.error || '';
    if (currentError) {
      const entry = JSON.stringify({
        timestamp: new Date().toISOString(),
        error: currentError,
        tool: data.tool_name || '',
      });
      try {
        fs.mkdirSync(path.dirname(failurePath), { recursive: true });
        fs.appendFileSync(failurePath, entry + '\n');
        failures.push(JSON.parse(entry));
      } catch { /* best effort */ }
    }

    const result = detectConsecutiveFailures(failures, Date.now());
    if (result.triggered) {
      const prompt = generateSocraticPrompt(result.normalizedError, result.count);
      process.stdout.write(prompt + '\n');
    }

    process.exit(0); // PostToolUseFailure — always exit 0
  })();
}

module.exports = { normalizeError, detectConsecutiveFailures, generateSocraticPrompt, WINDOW_MS };
