#!/usr/bin/env node
/**
 * PostToolUseFailure Hook: feedback-queue-capture
 *
 * Appends Bash-tool failures to _runs/feedback-queue.jsonl with a normalized
 * pattern_key for dedup-accumulation. The autoresearch operational-failures
 * domain reads this file and surfaces remediation suggestions when any
 * pattern_key hits 3+ occurrences.
 *
 * Path taken: NEW plugin hook (`.claude/hooks/post-tool-failure-tracker.cjs`
 * is GATED — cannot be edited in-session without ALLOW_AGENT_CONFIG_WRITE=1).
 * Registration wiring written to _runs/s420/exec/r09-wiring.md for the lead.
 *
 * Exit codes:
 * - 0: Always (PostToolUseFailure cannot block).
 *
 * Schema (one JSON line per occurrence):
 * {
 *   "ts": "ISO8601",
 *   "tool": "Bash",
 *   "command": "<first 200 chars>",
 *   "error": "<first 300 chars>",
 *   "exit_code": <number | null>,
 *   "category": "shell-escape|zombie-process|hook-crash|tool-misuse|unknown",
 *   "pattern_key": "<cmd_token>:<normalized_error_first_line>"
 * }
 */

'use strict';

const fs = require('fs');
const path = require('path');

const QUEUE_FILE = process.env.FEEDBACK_QUEUE_FILE ||
  path.join(process.cwd(), '_runs', 'feedback-queue.jsonl');

/**
 * Extract the first meaningful token from a shell command.
 * Strips leading env-var assignments, sudo, node invocations, etc.
 * so the key stays stable across repeated invocations.
 *
 * @param {string} cmd
 * @returns {string}
 */
function extractCommandToken(cmd) {
  if (!cmd) return 'unknown';
  // Drop leading VAR=value assignments
  const stripped = cmd.trimStart().replace(/^([A-Z_]+=\S+\s+)+/, '');
  // First space-separated token, capped at 40 chars
  const token = stripped.split(/\s+/)[0] || 'unknown';
  return token.replace(/^.*[/\\]/, '').substring(0, 40); // basename only
}

/**
 * Normalize an error string: strip volatile parts so the same logical error
 * maps to the same pattern_key regardless of run-specific noise.
 *
 * @param {string} err
 * @returns {string}
 */
function normalizeError(err) {
  return (err || '')
    // Strip absolute paths (keep basename)
    .replace(/(?:\/[\w.-]+)+/g, (m) => path.basename(m))
    // Strip Windows paths
    .replace(/[A-Za-z]:\\(?:[\w\\.-]+)/g, (m) => path.basename(m))
    // Strip ISO timestamps
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[\d.Z]*/g, '<ts>')
    // Strip epoch-like numbers (10-13 digits)
    .replace(/\b\d{10,13}\b/g, '<epoch>')
    // Strip hex hashes (git SHAs, etc.)
    .replace(/\b[0-9a-f]{7,64}\b/gi, '<hash>')
    // Collapse multiple digits to N (port numbers, line numbers, etc.)
    .replace(/\b\d+\b/g, 'N')
    .trim();
}

/**
 * Map a normalized error string to a broad failure category.
 *
 * @param {string} cmd
 * @param {string} normErr
 * @returns {string}
 */
function categorize(cmd, normErr) {
  const e = normErr.toLowerCase();
  const c = (cmd || '').toLowerCase();
  if (/eacces|permission denied|operation not permitted/.test(e)) return 'shell-escape';
  if (/zombie|defunct|kill|sigkill|sigterm/.test(e)) return 'zombie-process';
  if (/hook|cjs|require|module_not_found/.test(e) || /\.cjs|hook/.test(c)) return 'hook-crash';
  if (/bad option|unknown flag|usage:|invalid/.test(e)) return 'tool-misuse';
  return 'unknown';
}

/**
 * Build a stable pattern_key from command token + first line of normalized error.
 *
 * @param {string} cmdToken
 * @param {string} normErr
 * @returns {string}
 */
function buildPatternKey(cmdToken, normErr) {
  const firstLine = normErr.split('\n')[0].substring(0, 80);
  return `${cmdToken}:${firstLine}`;
}

// Hook entry point — fires as PostToolUseFailure event
if (require.main === module) {
  (async () => {
    const { readStdinJson } = require('./hook-utils.cjs');
    const data = await readStdinJson();

    // Only process Bash tool failures
    if ((data.tool_name || '') !== 'Bash') {
      process.exit(0);
    }

    const command = String(data.tool_input && data.tool_input.command
      ? data.tool_input.command
      : data.tool_use_input && data.tool_use_input.command
        ? data.tool_use_input.command
        : '').substring(0, 200);

    const error = String(data.error || '').substring(0, 300);
    const exitCode = typeof data.exit_code === 'number' ? data.exit_code : null;

    const cmdToken = extractCommandToken(command);
    const normErr = normalizeError(error);
    const category = categorize(command, normErr);
    const pattern_key = buildPatternKey(cmdToken, normErr);

    const entry = {
      ts: new Date().toISOString(),
      tool: 'Bash',
      command,
      error,
      exit_code: exitCode,
      category,
      pattern_key,
    };

    try {
      const dir = path.dirname(QUEUE_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(QUEUE_FILE, JSON.stringify(entry) + '\n');
    } catch { /* non-fatal — hook must never crash */ }

    // No additionalContext — this hook is accumulation-only, not recovery advice
    process.exit(0);
  })();
}

module.exports = {
  extractCommandToken,
  normalizeError,
  categorize,
  buildPatternKey,
};
