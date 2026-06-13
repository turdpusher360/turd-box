#!/usr/bin/env node
/**
 * PostToolUse Hook: weasley-heartbeat
 *
 * The WRITER half of the Weasley Clock. On each tool call it records the calling
 * agent's identity + (for edit tools) the file it just touched into the shared
 * clock.json in the AISLE state dir — a CC-cache-immune, cross-session-shared
 * location. This is what lets parallel sessions know who is working where.
 *
 * It ALSO bridges to the `/ps` agent-process dashboard: `/ps` reads
 * `_runs/os/session-processes.json` whose `tracked_pids` is hollow —
 * It is never populated by any code. Claude subagents share one V8 heap, so there is NO
 * per-agent OS PID to fabricate — fabricating PIDs would break
 * `/ps`'s reaper-log zombie cross-reference. Instead, Weasley writes a SEPARATE
 * honest ledger, `_runs/os/agent-clock.json`, listing live agents (by identity,
 * not PID) for `/ps` to surface. We deliberately do NOT read-modify-write
 * session-processes.json (os-accounting already owns its last_heartbeat field;
 * a second rmw'er would race and clobber it).
 *
 * Composes with os-accounting.cjs (which writes _runs/os/heartbeats/{aid}.json):
 * os-accounting tracks per-agent COST; Weasley tracks per-agent FILE OWNERSHIP,
 * which os-accounting does not — that ownership is what powers conflict checks.
 *
 * Exit codes:
 *   - 0: always (PostToolUse is warn-only; hooks never crash the session)
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { readStdinJson } = require('./hook-utils.cjs');
const {
  classifyCaller,
  clockKey,
  readClock,
  writeClock,
  pruneStale,
  extractEditTarget,
  upsertEntry,
} = require('./weasley-utils.cjs');

(async () => {
  try {
    let input = {};
    try {
      input = await readStdinJson({ timeoutMs: 200 });
    } catch { /* stdin unavailable — still register a bare heartbeat below */ }

    const toolName = input.tool_name || '';
    const toolInput = input.tool_input || {};
    const sessionId = input.session_id || '';
    const caller = classifyCaller(input);
    const key = clockKey(sessionId, caller);
    const now = Date.now();

    // Only edit tools establish file ownership; other tools just refresh liveness.
    const touchedFile = extractEditTarget(toolName, toolInput);

    // Read-modify-write the authoritative clock (best-effort; expiry bounds races).
    let clock = readClock();
    clock = pruneStale(clock, now);
    upsertEntry(clock, key, caller, sessionId, touchedFile, null, now);
    writeClock(clock);

    // --- /ps bridge: honest mirror in _runs/os/agent-clock.json ---
    // Identity-based, NO fabricated PIDs. /ps.md can surface this with a one-line
    // follow-up (it is owned by another lane this session — left untouched here).
    try {
      const osDir = path.join(process.cwd(), '_runs', 'os');
      fs.mkdirSync(osDir, { recursive: true });
      const live = Object.entries(clock.agents).map(([k, v]) => ({
        key: k,
        type: v.type,
        name: v.name,
        session: v.session,
        lastActive: v.lastActive,
        files: Object.keys(v.files || {}),
      }));
      const mirror = {
        updated_at: new Date(now).toISOString(),
        source: 'weasley-heartbeat',
        agent_count: live.length,
        agents: live,
      };
      const tmp = path.join(osDir, 'agent-clock.json.' + process.pid + '.tmp');
      const dest = path.join(osDir, 'agent-clock.json');
      fs.writeFileSync(tmp, JSON.stringify(mirror, null, 2));
      fs.renameSync(tmp, dest);
    } catch { /* mirror is best-effort; never fatal */ }
  } catch {
    // Hooks never crash.
  }
  process.exit(0);
})();
