'use strict';

/**
 * AISLE Intent-Contract Bash command-classing (P2 of DIS-SEC-001).
 *
 * Coarse regex classing — NOT a shell parser (brief R3: "classes, not full
 * parsing"; `guard-git-scope.cjs:16-45` is the in-budget precedent). Maps a Bash
 * command string to zero or more capability classes so the intent-contract hook
 * can check a Bash call against a contract's `allowed_tool_classes` using the
 * SAME vocabulary a non-Bash tool maps to (see store.cjs TOOL_CLASS_MAP). Both
 * sides share this class vocabulary so the two can never drift.
 *
 * Classes: read | write | git-mutate | net-fetch | proc-spawn | delete.
 *
 * Design choices (deliberate, documented):
 *  - The WHOLE command string is scanned, so a chained/piped command
 *    (`curl x | tee y`) yields the UNION of every class it touches
 *    (net-fetch + write). No command splitting needed.
 *  - A command matching nothing returns `[]` (empty). Benign builtins
 *    (`echo`, `cd`, `true`, `export`) and transforms-to-stdout produce no class,
 *    so they raise no contract violation. This is the honest R3 limit: an
 *    arbitrary-Bash envelope is porous — classing surfaces the high-signal
 *    capabilities (network, delete, spawn, git-mutate, file-write), it is not a
 *    sandbox.
 *  - Classing is heuristic. A `>` inside a quoted string can false-positive as a
 *    write; git subcommands are matched coarsely. Acceptable for a WARN-ONLY
 *    perimeter whose job is to make drift VISIBLE, not to be authoritative.
 *
 * SECURITY: this module returns only class labels. Callers MUST NOT log the raw
 * command (it can carry secrets); only the derived classes are safe to record.
 *
 * Purity: no stdin, no process.exit, no I/O. Importing has no side effects.
 */

/** The shared capability-class vocabulary. Frozen so callers can enumerate. */
const CLASSES = Object.freeze(['read', 'write', 'git-mutate', 'net-fetch', 'proc-spawn', 'delete']);

// Mutating git subcommands (state/working-tree/ref changes). Read-only git
// (status/log/diff/show/…) is intentionally NOT here — it classes as `read`.
const GIT_MUTATE = /\bgit\s+(?:add|commit|push|rm|mv|reset|checkout|restore|merge|rebase|cherry-pick|revert|stash|tag|clean|apply|am|pull|init|clone|switch|worktree|filter-repo|update-ref|update-index|gc)\b|\bgit\s+branch\s+-[a-zA-Z]*[dD]\b/;

const PATTERNS = Object.freeze({
  'net-fetch': [
    /\b(?:curl|wget|nc|ncat|telnet|ssh|scp|sftp|rsync|aria2c|httpie)\b/,
    /\bgit\s+(?:fetch|pull|clone|push)\b/,
    /\b(?:npm|pnpm)\s+(?:i|install|ci|add|publish|update|up)\b/,
    /\byarn\s+(?:add|install|up|upgrade)\b/,
    /\bpip3?\s+install\b/,
    /\bnpx\b/,
    /\b(?:Invoke-WebRequest|iwr)\b/i,
    /https?:\/\//,
  ],
  'git-mutate': [GIT_MUTATE],
  delete: [
    /\brm\s+/, /\brmdir\b/, /\bunlink\b/, /\bshred\b/, /\btrash\b/,
    /\bgit\s+clean\b/,
    /\bfind\b[^|;&]*\s-delete\b/,
    /\btruncate\b/,
  ],
  write: [
    /(?:^|\s)>>?\s*\S/,        // > file  or  >> file  (spaced redirection)
    /\d+>(?:&\d+|\s*\S)/,      // 2>file, 2>&1
    /&>\s*\S/,                 // &>file
    /\btee\b/, /\bcp\s+/, /\bmv\s+/, /\btouch\b/, /\bmkdir\b/,
    /\bsed\s+-[a-zA-Z]*i\b/, /\bsed\s+--in-place\b/,
    /\bln\s+-/, /\bchmod\b/, /\bchown\b/, /\bdd\s+/, /\binstall\s+-/,
  ],
  'proc-spawn': [
    /\b(?:node|deno|bun|python3?|ruby|perl|php|bash|sh|zsh|ksh)\s+\S/,
    /\b(?:npm|pnpm|yarn)\s+run\b/, /\bnpx\b/, /\bmake\b/,
    /\b(?:vitest|jest|mocha|pytest|tsx?)\b/,
    /\bdocker\s+(?:run|exec|compose|start)\b/,
    /\b(?:systemctl|service|nohup|xargs|eval|exec|source)\b/,
    /(?:^|\s)\.\/\S+/,         // ./script.sh
    /\s&\s*$/,                 // trailing & (background)
  ],
  read: [
    /\b(?:cat|ls|grep|egrep|fgrep|rg|head|tail|awk|wc|stat|file|diff|pwd|env|printenv|less|more|od|xxd|hexdump|realpath|readlink|dirname|basename|tree|du|df|which|type)\b/,
    /\bgit\s+(?:status|log|diff|show|branch|ls-files|rev-parse|blame|describe|remote|cat-file|for-each-ref|reflog)\b/,
    /\bfind\b/,
  ],
});

/**
 * Classify a Bash command string into zero or more capability classes.
 *
 * @param {string} command the raw Bash command (never logged by callers)
 * @returns {string[]} deduped classes drawn from CLASSES, in CLASSES order;
 *          `[]` for a non-string, empty, or unrecognized/benign command.
 */
function classify(command) {
  if (typeof command !== 'string' || command.length === 0) {
    return [];
  }
  const found = new Set();
  for (const cls of CLASSES) {
    const patterns = PATTERNS[cls];
    if (patterns.some((re) => re.test(command))) {
      found.add(cls);
    }
  }
  // Return in the stable CLASSES order for deterministic output/tests.
  return CLASSES.filter((c) => found.has(c));
}

module.exports = { classify, CLASSES };
