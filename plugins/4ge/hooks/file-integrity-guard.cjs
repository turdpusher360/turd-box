#!/usr/bin/env node
/**
 * file-integrity-guard.cjs — Plugin Hook (4ge)
 *
 * Standalone file-integrity hook for the 4ge plugin. No dependency on the
 * OS capability layer — resolves paths via CLAUDE_PLUGIN_ROOT.
 *
 * Three modes triggered by hook events:
 *
 *   Boot   (SessionStart)           node ".../file-integrity-guard.cjs" boot
 *   Track  (PostToolUse:Write|Edit) node ".../file-integrity-guard.cjs"
 *   Verify (PostToolUse:Bash)       node ".../file-integrity-guard.cjs"
 *
 * Boot mode has ZERO dependency on hook-utils.cjs — it runs before boot
 * has a chance to restore hook-utils, so it uses only node builtins and
 * the core module at ${CLAUDE_PLUGIN_ROOT}/../../lib/os/capabilities/file-integrity.cjs
 * OR falls back to inline implementation if core is unavailable.
 *
 * Always exits 0 — never crashes, never blocks Claude Code.
 *
 * Workaround for: https://github.com/anthropics/claude-code/issues/42383
 */

'use strict';

const path = require('node:path');
const crypto = require('node:crypto');

// CLAUDE_PLUGIN_ROOT is set by the CC plugin runtime to the plugin directory.
// Fallback to __dirname (same result when invoked directly from plugin dir).
const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_DATA || process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..');

// Resolve core module via cwd (works from both cache and local install)
const CORE_PATH = path.resolve(process.cwd(), 'lib', 'os', 'capabilities', 'file-integrity.cjs');

// Plugin-local hook-utils (same dir as this file)
const HOOK_UTILS_PATH = path.resolve(PLUGIN_ROOT, 'hooks', 'hook-utils.cjs');

// -----------------------------------------------------------------------
// Boot mode — SessionStart
// Zero dependency on hook-utils; delegates directly to core module.
// -----------------------------------------------------------------------

if (process.argv[2] === 'boot') {
  try {
    const core = require(CORE_PATH);
    core.boot();
  } catch {
    // Core module unavailable — skip silently
  }
  process.exit(0);
}

// -----------------------------------------------------------------------
// Track / Verify mode — PostToolUse
// Uses plugin-local hook-utils.cjs
// -----------------------------------------------------------------------

(async () => {
  try {
    const { readStdinJson } = require(HOOK_UTILS_PATH);
    const input = await readStdinJson();

    const sessionId =
      input.session_id ||
      process.env.CLAUDE_SESSION_ID ||
      crypto.randomUUID();

    const toolName = input.tool_name || '';
    const filePath = (input.tool_input && input.tool_input.file_path) || '';

    let core;
    try {
      core = require(CORE_PATH);
    } catch {
      // Core module missing — degrade gracefully
      process.exit(0);
    }

    if (toolName === 'Write' || toolName === 'Edit') {
      // Track mode
      if (filePath) {
        core.track(filePath, sessionId);
      }
    } else {
      // KILL-SWITCH (T3 95%-conf rogue Edit-reversion).
      // core.verify() was auto-repairing legitimately-edited files via
      // git checkout HEAD -- <file> when mtime <= entry.ts.
      // track() left running so snapshots stay current. To restore: uncomment.
      // Verify mode (Bash or any other PostToolUse event)
      // core.verify(sessionId);
    }
  } catch {
    // Hooks never crash
  }
  process.exit(0);
})();
