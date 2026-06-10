#!/usr/bin/env node
/**
 * PostToolUse Hook: dfe-post-edit
 *
 * Tracks Write/Edit tool calls per session and suggests /dfe after 10+ code edits.
 * Suggestion fires at 10, then every 10 after (20, 30, ...).
 *
 * Counter stored in: /tmp/dfe-edit-count-<session_id>.json
 *
 * Exit codes:
 * - 0: Always (warn only, PostToolUse)
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readStdinJson } = require('./hook-utils.cjs');

const TRIGGER_INTERVAL = 10;
// File extensions that count as "code edits"
const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.cjs', '.mjs', '.jsx',
  '.py', '.go', '.rs', '.rb', '.java', '.cs', '.cpp', '.c', '.h',
]);

(async () => {
  try {
    const input = await readStdinJson();
    const toolName = input.tool_name || '';

    // Only track Write and Edit tool calls
    if (!/^(Write|Edit)$/.test(toolName)) {
      process.exit(0);
    }

    // Get the file path from tool input
    const toolInput = input.tool_input || {};
    const filePath = toolInput.file_path || toolInput.path || '';

    // Only count code file edits (skip docs, configs, markdown)
    const ext = path.extname(filePath).toLowerCase();
    if (!CODE_EXTENSIONS.has(ext)) {
      process.exit(0);
    }

    // Resolve session counter file
    const sessionId = input.session_id || 'unknown';
    const safeSessionId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '');
    if (!safeSessionId) {
      process.exit(0);
    }
    const counterFile = path.join(os.tmpdir(), `dfe-edit-count-${safeSessionId}.json`);

    // Read or initialize counter
    let count = 0;
    try {
      const raw = fs.readFileSync(counterFile, 'utf8');
      count = JSON.parse(raw).count || 0;
    } catch {
      // File doesn't exist yet — start from 0
    }

    count += 1;

    // Persist updated count
    fs.writeFileSync(counterFile, JSON.stringify({ count }), 'utf8');

    // Suggest /dfe at every TRIGGER_INTERVAL
    if (count > 0 && count % TRIGGER_INTERVAL === 0) {
      process.stdout.write(
        `[dfe-post-edit] ${count} code edits this session. Run /dfe to catch hallucinated APIs, logic bugs, and security issues before committing.\n`
      );
    }

    process.exit(0);
  } catch {
    // Never block on hook errors
    process.exit(0);
  }
})();
