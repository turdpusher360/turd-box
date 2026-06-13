#!/usr/bin/env node
/**
 * PostToolUse Hook: forge-heartbeat
 *
 * Monitors teammate activity during forge sessions.
 * - Early exit when no .forge-session.json exists (<1ms)
 * - Throttled: updates heartbeat every 10 tool uses (counter in file)
 * - Warns when teammate silent >10 minutes
 * - Escalates after 2 consecutive timeouts (20 minutes)
 *
 * Exit codes:
 * - 0: Always (warn only, PostToolUse)
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { resolveForgeStateDir, migrateIfNeeded } = require('./forge-utils.cjs');
const { readStdinJson } = require('./hook-utils.cjs');

const SESSION_FILE = '.forge-session.json';
const THROTTLE_INTERVAL = 10;
const TIMEOUT_MS = 600000; // 10 minutes
const ESCALATION_THRESHOLD = 2;

(async () => {
  try {
    // Fast exit: no forge session
    if (!fs.existsSync(SESSION_FILE)) {
      process.exit(0);
    }

    // Read stdin to identify which agent triggered this PostToolUse hook.
    // We need agent_id to update only the active teammate's last_seen timestamp,
    // not a global timer that resets on every lead tool use.
    // readStdinJson has a 5s timeout to prevent Windows stdin hangs.
    let agentId = null;
    try {
      const payload = await readStdinJson({ timeoutMs: 100 });
      agentId = payload.agent_id || null;
    } catch { /* stdin unavailable or not JSON — fall back to no-op for last_seen */ }

    // Resolve state dir from CLAUDE_PLUGIN_DATA with _runs/ fallback
    const stateDir = resolveForgeStateDir();
    const HEARTBEAT_FILE = path.join(stateDir, '.forge-heartbeat.json');

    // Migrate from old location if needed
    migrateIfNeeded(
      path.join(process.cwd(), '_runs', '.forge-heartbeat.json'),
      HEARTBEAT_FILE
    );

    // Read or initialize heartbeat data
    let heartbeat;
    try {
      heartbeat = JSON.parse(fs.readFileSync(HEARTBEAT_FILE, 'utf8'));
    } catch {
      heartbeat = { call_count: 0, teammates: {} };
    }

    // Increment call counter
    heartbeat.call_count = (heartbeat.call_count || 0) + 1;

    // Read OS state for IPC heartbeat (deferred to after fast-exit check)
    let osState;
    try {
      osState = JSON.parse(fs.readFileSync(
        path.join(process.cwd(), '_runs', '.os-state.json'), 'utf8'
      ));
    } catch { /* OS not booted — skip IPC heartbeat */ }

    // Throttle: only do full update every N calls
    if (heartbeat.call_count % THROTTLE_INTERVAL !== 0) {
      fs.writeFileSync(HEARTBEAT_FILE, JSON.stringify(heartbeat));
      process.exit(0);
    }

    // IPC heartbeat: broadcast to all listeners when OS is running
    if (osState) {
      try {
        const { createIPC } = require(path.join(process.cwd(), 'lib/os/services/ipc.cjs'));
        const ipc = createIPC(osState.stateDir, osState.sessionId);
        ipc.send({
          type: 'HEARTBEAT',
          from: { pid: process.pid },
          to: { pid: '*' },
          payload: { turns: heartbeat.call_count, timestamp: Date.now() }
        });
        ipc.cleanup(300000); // 5 minutes
      } catch { /* IPC failure is non-fatal */ }
    }

    // Full heartbeat update: sync teammate list from session file
    let session;
    try {
      session = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    } catch {
      process.exit(0);
    }

    const now = Date.now();

    // R05: deterministically populate the HUD forge-progress zone from the live
    // .forge-session.json on each throttled full-heartbeat. Without this the zone
    // only fills when the /forge SKILL prose remembers to shell the writer, so it
    // usually renders blank during real runs. Non-destructive: upserts a per-phase
    // wave keyed by session.phase, preserving any waves the SKILL wrote.
    try {
      const fp = require('../lib/forge-progress-writer.cjs');
      const STMAP = { active: 'running', running: 'running', done: 'done', complete: 'done', failed: 'failed', error: 'failed' };
      const phaseId = String(session.phase != null ? session.phase : 'forge');
      if (!fp.readProgress()) {
        fp.startSession({
          session: session.id || session.session || '',
          task: session.task || session.scope || '',
          startedAt: session.startedAt || session.started_at,
        });
      }
      fp.upsertWave({
        id: phaseId,
        label: session.phase_label || (session.phase != null ? `Phase ${session.phase}` : 'Forge'),
        status: 'running',
        agents: (session.teammates || []).map((tm) => ({
          name: tm.name,
          type: tm.type || tm.agent_type || '',
          status: STMAP[tm.status] || 'running',
        })),
      });
    } catch { /* writer is best-effort and never throws */ }

    // Build a lookup: agent_id -> teammate name (session teammates may carry agent_id).
    // Falls back to name-matching if agent_id is absent from session records.
    const agentIdToName = {};
    for (const tm of (session.teammates || [])) {
      if (tm.agent_id) agentIdToName[tm.agent_id] = tm.name;
    }
    const activeTeammateName = agentId ? (agentIdToName[agentId] || null) : null;

    // Sync teammates from session into heartbeat.
    // last_seen is only updated on initial registration here; ongoing activity
    // is tracked below in the timeout loop using activeTeammateName.
    for (const tm of (session.teammates || [])) {
      if (!heartbeat.teammates[tm.name]) {
        heartbeat.teammates[tm.name] = {
          status: tm.status,
          last_seen: now,
          timeout_count: 0
        };
      } else {
        heartbeat.teammates[tm.name].status = tm.status;
      }
    }

    // Check for timeouts.
    // Reset the active teammate's clock FIRST (before the timeout comparison) so
    // a teammate that was silent for >TIMEOUT_MS but is now active again can
    // recover. Without this, once silentMs > TIMEOUT_MS the else-if branch is
    // unreachable for that teammate and it permanently stays timed-out.
    const warnings = [];
    for (const [name, data] of Object.entries(heartbeat.teammates)) {
      if (data.status !== 'active') continue;

      // Reset active teammate's clock before measuring silence.
      if (name === activeTeammateName) {
        data.last_seen = now;
        data.timeout_count = 0;
      }

      const silentMs = now - (data.last_seen || 0);
      if (silentMs > TIMEOUT_MS) {
        data.timeout_count = (data.timeout_count || 0) + 1;
        if (data.timeout_count >= ESCALATION_THRESHOLD) {
          warnings.push(`[forge-heartbeat] ESCALATION: Teammate "${name}" silent for ${Math.round(silentMs / 60000)}m (${data.timeout_count} consecutive timeouts). May be stuck.`);
        } else {
          warnings.push(`[forge-heartbeat] WARNING: Teammate "${name}" silent for ${Math.round(silentMs / 60000)}m.`);
        }
      }
      // Other active teammates: no last_seen update — their silence continues to age.
    }

    // Write heartbeat (sync — process.exit below must not race the write)
    fs.writeFileSync(HEARTBEAT_FILE, JSON.stringify(heartbeat, null, 2));

    // Output warnings
    if (warnings.length > 0) {
      console.log(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext: warnings.join('\n')
        }
      }));
    }
  } catch {
    // Hooks never crash
  }
  process.exit(0);
})();
