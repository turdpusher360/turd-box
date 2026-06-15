#!/usr/bin/env node
/**
 * os-boot.cjs — Plugin Hook (4ge) [D3]
 *
 * SessionStart boot for the VENDORED Agentic OS (plugins/4ge/vendor/).
 * Marketplace installs get the full OS — kernel boot, capability registry,
 * boot-status/health state for the HUD — without any project-side install.
 *
 * Precedence (os-guard.cjs):
 *   - If the PROJECT wires its own os-boot in .claude/settings.json
 *     (the source monorepo, or any Blueprint-installed project), this hook
 *     defers — the project-managed OS is authoritative.
 *   - The OS module tree resolves project-first: <cwd>/lib/os when present,
 *     else the vendored copy via CLAUDE_PLUGIN_DATA → CLAUDE_PLUGIN_ROOT →
 *     __dirname/../vendor.
 *
 * Deltas vs the project-managed hook (the source monorepo's os-boot):
 *   - memoryHubUrl: null unless the user configures .4ge/config.json
 *     memory.hubUrl or DEV_MEMORY_URL (no hardcoded localhost hub).
 *   - AISLE hook server: NOT spawned unless .4ge/config.json
 *     aisle.spawnServer === true (no detached background processes by
 *     default in stranger sessions).
 *   - boot-status.json gains booted_by: 'plugin' for observability.
 *
 * State stays project-local at <cwd>/_runs/os/ — exactly what the HUD reads.
 * Always exits 0. Never blocks the session.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { readStdinJson, deriveSessionNumber, enforceTimeout } = require('./hook-utils.cjs');
const { isProjectManaged, resolveOsRoot } = require('./os-guard.cjs');

/** Append a structured event to activity.jsonl */
function emitEvent(stateDir, stream, event, data) {
  const entry = { ts: new Date().toISOString(), stream, event, ...data };
  try {
    fs.appendFileSync(path.join(stateDir, 'activity.jsonl'), JSON.stringify(entry) + '\n');
  } catch { /* non-fatal */ }
}

/** Read .4ge/config.json best-effort. */
function readForgeConfig(cwd) {
  try {
    return JSON.parse(fs.readFileSync(path.join(cwd, '.4ge', 'config.json'), 'utf8')) || {};
  } catch {
    return {};
  }
}

(async () => {
  enforceTimeout(9000);

  const cwd = process.cwd();

  // Guard 1 (precedence, order-independent): project-managed OS wins.
  if (isProjectManaged(cwd, 'os-boot')) {
    process.stderr.write('[4ge-os-boot] project-managed OS detected — deferring\n');
    process.exit(0);
  }

  const input = await readStdinJson();

  // Guard 2 (PID sentinel): same-harness re-entry is a no-op.
  const stateDir = path.join(cwd, '_runs', 'os');
  try { fs.mkdirSync(stateDir, { recursive: true }); } catch { /* best-effort */ }
  const bootSentinelPath = path.join(stateDir, '.boot-sentinel');
  const harnessPid = process.ppid;
  try {
    if (fs.existsSync(bootSentinelPath)) {
      const prev = JSON.parse(fs.readFileSync(bootSentinelPath, 'utf8'));
      if (prev && prev.harnessPid === harnessPid) {
        process.stderr.write('[4ge-os-boot] re-entry in harness pid ' + harnessPid + ' — skipping full boot\n');
        process.exit(0);
      }
    }
  } catch { /* sentinel corrupt — fall through */ }

  // Guard 3: compact-triggered re-boot fast path.
  if (input && input.source === 'compact') {
    process.stderr.write('[4ge-os-boot] compact boot (fast path) — skipping full boot\n');
    process.exit(0);
  }

  // Resolve the OS tree (project copy first, then vendored).
  const osRoot = resolveOsRoot(cwd);
  if (!osRoot) {
    process.stderr.write('[4ge-os-boot] no OS tree found (project or vendored) — skipping\n');
    process.exit(0);
  }
  const osLib = path.join(osRoot.root, 'lib', 'os');

  const forgeConfig = readForgeConfig(cwd);

  // Clear tool-ring buffer so a fresh session starts at 'warmup'.
  try {
    const pluginRoot = process.env.CLAUDE_PLUGIN_DATA
      || process.env.CLAUDE_PLUGIN_ROOT
      || path.join(__dirname, '..');
    const toolRingPath = path.join(pluginRoot, 'lib', 'tool-ring.cjs');
    if (fs.existsSync(toolRingPath)) {
      const { clearRing } = require(toolRingPath);
      clearRing(stateDir);
    }
  } catch { /* best-effort — ring is non-critical */ }

  try {
    const boot = require(path.join(osLib, 'kernel', 'boot-sequence.cjs'));

    // RBAC-ENF-001 Phase 1: resolve enforcer singleton for contract registration.
    let enforcer = null;
    try {
      const osApi = require(path.join(osLib, 'index.cjs'));
      if (osApi && osApi.kernel && typeof osApi.kernel.getEnforcer === 'function') {
        enforcer = osApi.kernel.getEnforcer();
      }
    } catch { /* enforcer stays null */ }

    // Memory hub is OPT-IN for plugin-managed boots (no hardcoded local hub).
    const memoryHubUrl =
      (forgeConfig.memory && typeof forgeConfig.memory.hubUrl === 'string' && forgeConfig.memory.hubUrl)
      || process.env.DEV_MEMORY_URL
      || null;

    // Steps 1-7: kernel boot.
    const kernelReport = boot.run({
      agentsDir: path.join(cwd, '.claude', 'agents'),
      stateDir,
      memoryHubUrl,
      enforcer,
    });

    for (const s of kernelReport.steps) {
      emitEvent(stateDir, 'boot', 'kernel_step', { step: s.name, status: s.status, ms: s.ms });
    }

    const kernelLines = kernelReport.steps
      .map(s => `  ${s.status === 'ok' ? '+' : s.status === 'degraded' ? '~' : '!'} ${s.name} (${s.ms}ms)`)
      .join('\n');

    // Steps 8-12: capability boot.
    let capLines = '';
    let capStatus = null;
    if (kernelReport.osEnabled) {
      try {
        const osApi = require(path.join(osLib, 'index.cjs'));
        const { createCapabilityRegistry } = osApi;
        if (createCapabilityRegistry) {
          const registry = createCapabilityRegistry(osApi, { stateDir });
          registry.discover(path.join(osLib, 'capabilities'));
          registry.resolveDeps();
          capStatus = registry.boot();

          if (typeof osApi.setCapabilityRegistry === 'function') {
            osApi.setCapabilityRegistry(registry);
          }

          if (capStatus && capStatus.capabilities) {
            for (const [name, info] of Object.entries(capStatus.capabilities)) {
              emitEvent(stateDir, 'boot', 'capability_ready', {
                capability: name, status: info.status, ms: info.init_ms,
              });
            }
            capLines = Object.entries(capStatus.capabilities)
              .map(([name, info]) => {
                const icon = info.status === 'ready' ? '+' : info.status === 'degraded' ? '~' : '!';
                return `  ${icon} cap:${name} (${info.init_ms}ms)${info.reason ? ` (${info.reason})` : ''}`;
              })
              .join('\n');
          }

          // Observability: mark this boot as plugin-managed in boot-status.json.
          try {
            const bootStatusPath = path.join(stateDir, 'boot-status.json');
            const bootStatus = JSON.parse(fs.readFileSync(bootStatusPath, 'utf8'));
            bootStatus.booted_by = 'plugin';
            bootStatus.os_source = osRoot.source;
            fs.writeFileSync(bootStatusPath, JSON.stringify(bootStatus, null, 2));
          } catch { /* non-fatal */ }
        }
      } catch {
        capLines = '  ~ capabilities: not available';
      }
    }

    const overall = capStatus
      ? `OS ${capStatus.overall} (${capStatus.total_boot_ms}ms)`
      : (kernelReport.osEnabled ? 'OS ready (no capabilities)' : 'OS DISABLED');

    emitEvent(stateDir, 'boot', 'boot_complete', {
      overall: capStatus ? capStatus.overall : (kernelReport.osEnabled ? 'ready' : 'disabled'),
      total_ms: capStatus ? capStatus.total_boot_ms : 0,
      capabilities: capStatus ? Object.keys(capStatus.capabilities).length : 0,
      kernel_steps: kernelReport.steps.length,
      booted_by: 'plugin',
      os_source: osRoot.source,
    });

    // Companion boot animation (best-effort, plugin-relative).
    try {
      const pluginRoot = process.env.CLAUDE_PLUGIN_DATA
        || process.env.CLAUDE_PLUGIN_ROOT
        || path.join(__dirname, '..');
      const companionState = require(path.join(pluginRoot, 'bin', 'companion-state.cjs'));
      companionState.startBoot(8);

      // Update-aware preference notice (Wave 1): once per session (SessionStart is
      // inherently once-per-session, so no sentinel needed) surface the "settings
      // may have changed" notice if the plugin version differs from the acked
      // version. The /hud setter (or /hud face ok) stamps the ack to silence it
      // until the next plugin bump. Critical-tier so it survives boot chatter.
      try {
        const ack = require(path.join(pluginRoot, 'bin', 'companion-ack.cjs'));
        ack.postDriftNoticeIfNeeded(companionState);
      } catch { /* non-fatal — ack surfacing is best-effort */ }
    } catch { /* non-fatal — companion not installed */ }

    // AISLE hook server: OPT-IN only for plugin-managed boots. Spawning a
    // detached background process is a deliberate act (.4ge/config.json
    // aisle.spawnServer: true), never a default in stranger sessions.
    const spawnServerOptIn = !!(forgeConfig.aisle && forgeConfig.aisle.spawnServer === true);
    if (spawnServerOptIn &&
        capStatus && capStatus.capabilities && capStatus.capabilities.aisle &&
        capStatus.capabilities.aisle.status === 'ready') {
      try {
        const { spawn } = require('node:child_process');
        const pidFile = path.join(stateDir, 'aisle-server.pid');
        const portFile = path.join(stateDir, 'aisle-server.port');
        let alreadyRunning = false;
        if (fs.existsSync(pidFile)) {
          try {
            const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
            if (Number.isFinite(pid) && pid > 0) {
              process.kill(pid, 0);
              if (fs.existsSync(portFile)) alreadyRunning = true;
            }
          } catch { /* stale — respawn */ }
        }
        if (!alreadyRunning) {
          const serverPath = path.join(osRoot.root, 'lib', 'aisle', 'server.cjs');
          if (fs.existsSync(serverPath)) {
            const child = spawn(process.execPath, [serverPath], {
              detached: true,
              stdio: 'ignore',
              cwd,
              env: {
                PATH: process.env.PATH || '',
                HOME: process.env.HOME || process.env.USERPROFILE || '',
                NODE_PATH: process.env.NODE_PATH || '',
                AISLE_STATE_DIR: stateDir,
              },
            });
            child.unref();
            emitEvent(stateDir, 'boot', 'aisle_server_spawned', { pid: child.pid });
          }
        }
      } catch { /* non-fatal */ }
    }

    // .os-state.json for IPC heartbeat consumers (forge-heartbeat reads this).
    try {
      fs.writeFileSync(
        path.join(cwd, '_runs', '.os-state.json'),
        JSON.stringify({
          stateDir,
          sessionId: (input && input.session_id) || 'unknown',
          bootedAt: new Date().toISOString(),
          registeredStateFiles: [],
        })
      );
    } catch { /* non-fatal */ }

    // Session metadata for the HUD live data layer.
    try {
      let model = process.env.ANTHROPIC_MODEL || process.env.CLAUDE_MODEL || process.env.CLAUDE_CODE_MODEL || '';
      if (!model && input && typeof input.model === 'string' && input.model) model = input.model;
      if (model) model = model.split('[1m]')[0].trim();
      if (!model) model = 'unknown';
      const contextWindow = /opus/i.test(model) ? 1000000 : 200000;

      let sessionNumber = 0;
      try { sessionNumber = deriveSessionNumber(cwd); } catch { /* 0 */ }

      fs.writeFileSync(
        path.join(stateDir, 'session-meta.json'),
        JSON.stringify({
          model,
          session_id: (input && input.session_id) || 'unknown',
          session_number: sessionNumber,
          session_title: '',
          captured_at: new Date().toISOString(),
          est_tokens_running_total: 0,
          tool_count_running: 0,
          context_window: contextWindow,
          last_refresh_ms: Date.now(),
          consecutive_healthy: 0,
        }, null, 2)
      );
    } catch { /* non-fatal */ }

    // Supervisor config when the feature gate is on.
    try {
      const { createFeatureGates } = require(path.join(osLib, 'kernel', 'feature-gates.cjs'));
      const gates = createFeatureGates();
      if (gates.isEnabled('process-supervisor')) {
        fs.writeFileSync(
          path.join(stateDir, '.supervisor-config.json'),
          JSON.stringify({ heartbeatTimeoutMs: 120000, maxConsecutiveFailures: 3, enabled: true })
        );
      }
    } catch { /* non-fatal */ }

    const output = {
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: `[4ge-os-boot:${osRoot.source}] ${overall}\nKernel:\n${kernelLines}${capLines ? '\nCapabilities:\n' + capLines : ''}`,
      },
    };
    process.stdout.write(JSON.stringify(output));
  } catch {
    // OS tree broken — skip silently, never block the session.
  }

  // Record the boot sentinel so the re-entry guard actually trips.
  try {
    fs.writeFileSync(bootSentinelPath, JSON.stringify({
      harnessPid,
      bootedAt: new Date().toISOString(),
      sessionId: (input && input.session_id) || 'unknown',
      bootedBy: 'plugin',
    }, null, 2));
  } catch { /* non-fatal */ }

  process.exit(0);
})();
