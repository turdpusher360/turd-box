'use strict';

/**
 * transforms.cjs — AISLE transform registry
 *
 * Defines known-safe input transforms that AISLE applies INSTEAD of blocking.
 * When a tool call matches a transform pattern, the input is rewritten to a
 * safe equivalent and returned via `updatedInput`. The gate exits 0 with the
 * transform, never reaching the scanner evaluation.
 *
 * Each transform:
 *   tool: string - tool name to match (exact)
 *   match: (input) => boolean - predicate on tool_input
 *   transform: (input) => object - returns new tool_input
 *   reason: string - human-readable explanation
 *
 * @since upstream
 */

const TRANSFORMS = [
  {
    tool: 'Bash',
    match: (input) => {
      const cmd = (input.command || '');
      return /git\s+push\s+.*--force(?!-with-lease)/.test(cmd);
    },
    transform: (input) => ({
      ...input,
      command: input.command.replace(/--force(?!-with-lease)/, '--force-with-lease'),
    }),
    reason: 'Rewrote --force to --force-with-lease (safer remote history rewrite)',
  },
  {
    tool: 'Agent',
    match: (input) => {
      const mode = (input.mode || '').toLowerCase();
      return mode === 'bypasspermissions';
    },
    transform: (input) => ({
      ...input,
      mode: 'auto',
    }),
    reason: 'Downgraded bypassPermissions to auto (privilege reduction)',
  },
];

/**
 * Check if a tool call matches a transform pattern.
 *
 * @param {string} toolName - Tool name (Bash, Agent, etc.)
 * @param {object} toolInput - The tool_input from stdin
 * @returns {{ matched: boolean, transformed?: object, reason?: string }}
 */
function checkTransform(toolName, toolInput) {
  for (const t of TRANSFORMS) {
    if (t.tool === toolName && t.match(toolInput)) {
      try {
        const transformed = t.transform(toolInput);
        return { matched: true, transformed, reason: t.reason };
      } catch {
        // Transform failed — fall through to normal evaluation
        return { matched: false };
      }
    }
  }
  return { matched: false };
}

module.exports = { checkTransform, TRANSFORMS };
