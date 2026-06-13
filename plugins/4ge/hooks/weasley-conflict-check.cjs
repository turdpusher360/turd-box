#!/usr/bin/env node
/**
 * PreToolUse Hook (matcher: Write|Edit): weasley-conflict-check
 *
 * The READER half of the Weasley Clock. Before an edit lands, it checks the
 * shared clock.json for another LIVE agent that recently touched the same file.
 * If found, it emits an advisory warning via PreToolUse additionalContext.
 *
 * It NEVER blocks (permissionDecision is never "deny"): cross-session edit
 * collisions are a coordination smell, not a security boundary, and a false
 * positive must never wedge a legitimate edit. The conflict logic lives in
 * weasley-utils.detectConflict (a pure function) and already excludes the
 * caller's own entries, stale agents, and files not touched recently.
 *
 * Exit codes:
 *   - 0: always (advisory only)
 */
'use strict';

const { readStdinJson } = require('./hook-utils.cjs');
const {
  classifyCaller,
  clockKey,
  readClock,
  extractEditTarget,
  detectConflict,
} = require('./weasley-utils.cjs');

(async () => {
  try {
    let input = {};
    try {
      input = await readStdinJson({ timeoutMs: 200 });
    } catch { process.exit(0); }

    const toolName = input.tool_name || '';
    const toolInput = input.tool_input || {};
    const candidateFile = extractEditTarget(toolName, toolInput);
    if (!candidateFile) process.exit(0);

    const caller = classifyCaller(input);
    const selfKey = clockKey(input.session_id || '', caller);
    const clock = readClock();
    const warning = detectConflict(clock, candidateFile, selfKey, Date.now());

    if (warning) {
      // Advisory context — surfaced to the agent, does not block the edit.
      console.log(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          additionalContext: warning,
        },
      }));
    }
  } catch {
    // Hooks never crash.
  }
  process.exit(0);
})();
