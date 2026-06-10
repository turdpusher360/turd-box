#!/usr/bin/env node
/**
 * PreToolUse Hook: forge-prompt-lint
 *
 * Checks teammate prompts for completeness during forge sessions.
 * Only fires on Agent tool when .forge-session.json exists.
 * Warns (exit 0) when 2+ quality checks fail.
 *
 * Intentionally warn-only (never blocks):
 * This hook uses additionalContext rather than permissionDecision:"deny" because
 * blocking under-specified prompts at the PreToolUse stage would prevent agents
 * from spawning entirely — too aggressive for a style/quality check. The warning
 * surfaces in Claude's tool response context so it can inform the next dispatch
 * without halting the current one. If you need hard enforcement, upgrade to
 * exit(2) with a deny reason and tighten the quality thresholds.
 *
 * Exit codes:
 * - 0: Always (warn only)
 */

'use strict';

const fs = require('node:fs');
const { readStdinJson, parseToolInput } = require('./hook-utils.cjs');

const SESSION_FILE = '.forge-session.json';

function lintPrompt(promptText) {
  const missing = [];
  const text = promptText || '';

  // Check 1: Task description (>20 non-whitespace characters)
  if (text.replace(/\s/g, '').length <= 20) {
    missing.push('task description (>20 characters)');
  }

  // Check 2: File/directory scope (path-like patterns)
  if (!/(?:\/[\w.-]+(?:\/[\w.*-]+)*|\.\w+$|src\/|lib\/|tests?\/|\.claude\/)/.test(text)) {
    missing.push('file/directory scope');
  }

  // Check 3: Acceptance criteria
  if (!/(?:criteria|should|must|verify|ensure|make sure|confirm|check that|validate|expect|^\s*[-*]\s)/mi.test(text)) {
    missing.push('acceptance criteria');
  }

  return { missing, shouldWarn: missing.length >= 2 };
}

(async () => {
  try {
    // Fast exit: no forge session
    if (!fs.existsSync(SESSION_FILE)) {
      process.exit(0);
    }

    const input = await readStdinJson();
    const toolName = input.tool_name || input.tool || '';

    // Only lint Agent tool prompts
    if (toolName !== 'Agent') {
      process.exit(0);
    }

    const prompt = parseToolInput(input, 'prompt', '');
    const result = lintPrompt(prompt);

    if (result.shouldWarn) {
      console.log(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          additionalContext: `[forge-prompt-lint] Teammate prompt may be under-specified (missing: ${result.missing.join(', ')}). Consider using a template from the forge plugin's references/teammate-templates.md`
        }
      }));
    }
  } catch {
    // Hooks never crash
  }
  process.exit(0);
})();
