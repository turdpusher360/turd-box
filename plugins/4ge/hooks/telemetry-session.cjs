#!/usr/bin/env node
'use strict';

/**
 * Telemetry session hook — wired to both SessionStart and Stop events.
 *
 * Disambiguation strategy: a temp file marker in os.tmpdir() keyed by session_id.
 * - If marker does NOT exist: this is SessionStart — create telemetry entry and write marker.
 * - If marker EXISTS: this is Stop — read entry, finalize, persist, remove marker.
 *
 * This avoids needing a separate event field in stdin (hooks receive the same
 * BaseHookInput schema regardless of event type).
 */

if (require.main === module) {
  (async () => {
    const { readStdinJson } = require('./hook-utils.cjs');
    const path = require('path');
    const fs = require('fs');
    const os = require('os');

    // Resolve plugin lib/ via CLAUDE_PLUGIN_ROOT so requires survive PLUGIN_DATA migration
    const _pluginRoot = process.env.CLAUDE_PLUGIN_DATA || process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..');
    const { createSessionEntry, finalizeSession } = require(path.join(_pluginRoot, 'lib', 'telemetry-collector.cjs'));

    const data = await readStdinJson();
    const cwd = data.cwd || process.cwd();
    const sessionId = data.session_id || 'unknown';
    const tmpPath = path.join(os.tmpdir(), `4ge-telemetry-${sessionId}.json`);

    if (fs.existsSync(tmpPath)) {
      // Marker present: Stop event fired — finalize and clean up
      try {
        const entry = JSON.parse(fs.readFileSync(tmpPath, 'utf8'));
        // Fix: tools_used/agents_spawned/total_tool_calls were empty in 100% of rows
        // (entry created at SessionStart, never accumulated). Backfill from this session's
        // slice of the existing logs before finalize derives the totals.
        try {
          const root = entry.cwd || cwd;
          const spawnsPath = path.join(root, '_runs', 'subagent-spawns.jsonl');
          if (fs.existsSync(spawnsPath)) {
            const agents = new Set();
            for (const line of fs.readFileSync(spawnsPath, 'utf8').split('\n')) {
              if (!line) continue;
              let r; try { r = JSON.parse(line); } catch { continue; }
              if (r.session === sessionId && r.agent) agents.add(r.agent);
            }
            entry.agents_spawned = [...agents];
          }
          const ledgerPath = path.join(root, '_runs', 'os', 'resource-ledger.jsonl');
          if (fs.existsSync(ledgerPath)) {
            const tools = {};
            for (const line of fs.readFileSync(ledgerPath, 'utf8').split('\n')) {
              if (!line) continue;
              let r; try { r = JSON.parse(line); } catch { continue; }
              if (r.sid === sessionId && r.event === 'tool') {
                const t = r.tool || '(unknown)';
                tools[t] = (tools[t] || 0) + 1;
              }
            }
            entry.tools_used = tools;
          }
        } catch { /* backfill best-effort; finalize still records the session */ }
        finalizeSession(entry);
        fs.unlinkSync(tmpPath);
      } catch {
        // best effort cleanup
      }
    } else {
      // No marker: SessionStart fired — create entry and write marker
      const entry = createSessionEntry(sessionId, cwd);
      try {
        fs.writeFileSync(tmpPath, JSON.stringify(entry));
      } catch {
        // best effort
      }
    }

    process.exit(0);
  })();
}
