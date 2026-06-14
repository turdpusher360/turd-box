'use strict';

const fs = require('node:fs');
const path = require('node:path');

function readJsonSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

// hud-context.json carries an event label set by os-accounting when a forge /
// maintain / dfe workflow is active. Nothing clears it on workflow end, so a
// stale label can persist for days. We treat anything older than HUD_CTX_TTL_MS
// as empty so the HUD context zone doesn't show last week's workflow.
//
// 6 hours is intentionally shorter than 24h: long enough to span a workday
// lunch break, short enough to clear overnight stale labels.
const HUD_CTX_TTL_MS = 6 * 60 * 60 * 1000;

function readFreshHudContext(filePath) {
  const raw = readJsonSafe(filePath);
  if (!raw || typeof raw !== 'object') return {};
  const updatedAt = raw.updated_at;
  if (typeof updatedAt !== 'string') return {};
  const t = Date.parse(updatedAt);
  if (!Number.isFinite(t)) return {};
  if (Date.now() - t > HUD_CTX_TTL_MS) return {};
  return raw;
}

// Forge-progress.json uses top-level `startedAt` (ISO, written by forge-progress-writer.cjs).
// A session that was abandoned without `clear` would linger and show a ghost progress bar.
// 10 minutes: long enough to survive agent context switches, short enough to clear crashed
// sessions before the next session starts.
const FORGE_PROGRESS_TTL_MS = 10 * 60 * 1000;

function readFreshForgeProgress(filePath) {
  const raw = readJsonSafe(filePath);
  if (!raw || typeof raw !== 'object') return null;
  const t = Date.parse(raw.startedAt);
  // No valid in-JSON timestamp → fall back to file mtime (forge-progress-writer didn't
  // include startedAt in early format; mtime is close enough for staleness detection).
  if (!Number.isFinite(t)) {
    try {
      const mtime = fs.statSync(filePath).mtimeMs;
      if (Date.now() - mtime > FORGE_PROGRESS_TTL_MS) return null;
    } catch { return null; }
    return raw;
  }
  if (Date.now() - t > FORGE_PROGRESS_TTL_MS) return null;
  return raw;
}

// .forge-session.json uses top-level `started` (ISO) per SKILL.md Phase-5 schema.
// Missing / malformed → treat as no active session. TTL mirrors forge-progress so
// they expire together when cleanup is skipped.
const FORGE_SESSION_TTL_MS = FORGE_PROGRESS_TTL_MS;

function readFreshForgeSession(filePath) {
  const raw = readJsonSafe(filePath);
  if (!raw || typeof raw !== 'object') return null;
  const t = Date.parse(raw.started);
  if (!Number.isFinite(t)) {
    // No in-JSON timestamp: defer to mtime.
    try {
      const mtime = fs.statSync(filePath).mtimeMs;
      if (Date.now() - mtime > FORGE_SESSION_TTL_MS) return null;
    } catch { return null; }
    return raw;
  }
  if (Date.now() - t > FORGE_SESSION_TTL_MS) return null;
  return raw;
}

function clipHudText(value, max = 160) {
  if (typeof value !== 'string') return '';
  const text = value.replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return text.slice(0, max - 3).trimEnd() + '...';
}

function firstOpenTask(tasks) {
  if (!Array.isArray(tasks)) return '';
  const task = tasks.find(t => t && t.done !== true && typeof t.text === 'string' && t.text.trim());
  return task ? task.text : '';
}

function loadLatestHandoffSummary(cwd) {
  try {
    const runsDir = path.join(cwd, '_runs');
    const entries = fs.readdirSync(runsDir)
      .map(name => {
        const m = name.match(/^HANDOFF-S(\d+)\.md$/);
        return m ? { name, n: Number(m[1]) } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.n - a.n);
    if (entries.length === 0) return '';
    const content = fs.readFileSync(path.join(runsDir, entries[0].name), 'utf8');
    const line = content.split(/\r?\n/)
      .map(s => s.trim())
      .find(s => s && !s.startsWith('#') && !s.startsWith('---') && !s.startsWith('>'));
    return line || '';
  } catch {
    return '';
  }
}

function loadSessionMemory(cwd, forgeSession) {
  const memory = {};
  const cartridge = readJsonSafe(path.join(cwd, '_runs', 'session-cartridge.json'));
  if (cartridge && typeof cartridge === 'object') {
    const momentum = cartridge.momentum && typeof cartridge.momentum === 'object'
      ? cartridge.momentum
      : {};
    const openTask = firstOpenTask(cartridge.tasks);
    memory.lastSession = clipHudText(momentum.summary, 180);
    memory.next = clipHudText(momentum.next, 160);
    memory.parked = clipHudText(openTask, 160);
  }

  if (!memory.lastSession) {
    memory.lastSession = clipHudText(loadLatestHandoffSummary(cwd), 180);
  }

  if (!memory.parked && forgeSession && typeof forgeSession === 'object') {
    const phase = forgeSession.phase || forgeSession.current_phase || '';
    const scope = forgeSession.scope || forgeSession.slug || '';
    memory.parked = clipHudText([phase, scope].filter(Boolean).join(': '), 160);
  }

  for (const key of Object.keys(memory)) {
    if (!memory[key]) delete memory[key];
  }
  return memory;
}

/**
 * Build capabilities map by merging boot-status init_ms/status with
 * flat health.json ok/reason. `health` is already flat -- no .capabilities key.
 */
function buildCapabilities(bootStatus, health) {
  const caps = {};
  if (bootStatus && bootStatus.capabilities) {
    for (const [name, info] of Object.entries(bootStatus.capabilities)) {
      caps[name] = {
        status: info.status || 'unknown',
        init_ms: info.init_ms || 0,
        ok: info.status === 'ready',
      };
      if (info.reason) caps[name].reason = info.reason;
      if (info.shelved === true) caps[name].shelved = true;
    }
  }
  if (health && typeof health === 'object') {
    for (const [name, h] of Object.entries(health)) {
      if (!caps[name]) {
        caps[name] = { status: h && h.ok ? 'ready' : 'degraded', init_ms: 0 };
      } else {
        caps[name] = { ...caps[name] };
      }
      if (h && typeof h === 'object') {
        if (h.ok !== undefined) {
          caps[name].ok = !!h.ok;
          // Keep status aligned with live probe result -- boot-status caches
          // init-time state and can go stale when probe recovers (e.g., aisle
          // state dir created mid-session). Prefer current probe truth.
          caps[name].status = h.ok ? 'ready' : 'degraded';
        }
        if (h.reason) caps[name].reason = h.reason;
      }
    }
  }
  return caps;
}

function computeUptime(bootStatus) {
  if (!bootStatus || !bootStatus.booted_at) return 0;
  const bootedAt = Date.parse(bootStatus.booted_at);
  if (Number.isNaN(bootedAt)) return 0;
  return Math.max(0, Date.now() - bootedAt);
}

function deriveOverall(caps) {
  const statuses = Object.values(caps).map(c => c.status);
  if (statuses.includes('failed')) return 'failed';
  if (statuses.includes('degraded')) return 'degraded';
  if (statuses.length === 0) return 'unknown';
  return 'ready';
}

function loadHudData(opts = {}) {
  const stateDir = opts.stateDir || path.join(process.cwd(), '_runs', 'os');
  const cwd = opts.cwd || process.cwd();
  const runExpensiveProbes = !!opts.runExpensiveProbes;
  const stdinOverride = opts.stdinOverride || null;

  if (runExpensiveProbes) {
    try {
      const { refreshAll } = require(path.resolve(cwd, 'lib/os/health-refresh.cjs'));
      const capDir = path.resolve(cwd, 'lib/os/capabilities');
      refreshAll(capDir, stateDir);
    } catch { /* best-effort */ }
  }

  // Refresh companion memory cache (best-effort, async, non-blocking)
  try {
    const { refreshMemoryCache } = require('./companion-insights.cjs');
    refreshMemoryCache(cwd).catch(() => {});
  } catch { /* companion-insights unavailable */ }

  const health = readJsonSafe(path.join(stateDir, 'health.json')) || {};
  const bootStatus = readJsonSafe(path.join(stateDir, 'boot-status.json')) || {};
  const meta = readJsonSafe(path.join(stateDir, 'session-meta.json')) || {};
  const hudCtx = readFreshHudContext(path.join(stateDir, 'hud-context.json'));
  const forgeSession = readFreshForgeSession(path.join(cwd, '.forge-session.json'));
  const forgeProgress = readFreshForgeProgress(path.join(stateDir, 'forge-progress.json'));
  const sessionMemory = loadSessionMemory(cwd, forgeSession);

  const capabilities = buildCapabilities(bootStatus, health);
  const overallHealth = deriveOverall(capabilities);
  const uptime = computeUptime(bootStatus);

  // Optional transcript enrichment (AD-6). Gated on freshness.
  let transcript = null;
  try {
    const { loadTranscriptActivity } = require('./hud-transcript-source.cjs');
    const sessionId = meta.session_id || (bootStatus && bootStatus.session_id) || '';
    if (sessionId) {
      const result = loadTranscriptActivity({ cwd, sessionId });
      if (result && result.transcriptPath) {
        let mtime = 0;
        try { mtime = fs.statSync(result.transcriptPath).mtimeMs; } catch { /* ignore */ }
        if (mtime > 0 && (Date.now() - mtime) < 30000) {
          transcript = result;
        }
      }
    }
  } catch { /* best-effort — transcript unavailable */ }

  const raw = {
    projectRoot: cwd,
    terminal: {
      cols: process.stdout.columns || 80,
      rows: process.stdout.rows || 24,
    },
    session: {
      id: meta.session_id || (bootStatus && bootStatus.session_id) || '',
      model: meta.model || 'unknown',
      modelId: meta.model || '',
      sessionNumber: meta.session_number || 0,
      contextPct: meta.est_context_pct || 0,
      contextLabel: meta.est_context_pct ? '' : 'est.',
      toolCount: meta.tool_count_running || 0,
      uptime,
      rateLimits: 'N/A',
    },
    os: {
      overallHealth,
      bootTime: (bootStatus && bootStatus.total_boot_ms) || 0,
      capabilities,
    },
    forge: forgeSession ? {
      active: true,
      phase: forgeSession.phase || null,
      teammates: forgeSession.teammates || [],
      scope: forgeSession.scope || null,
    } : {
      active: false,
      phase: null,
      teammates: [],
      scope: null,
    },
    context: {
      trigger: 'unknown',
      event: (hudCtx && hudCtx.label) || null,
      zone: null,
    },
    badges: readJsonSafe(path.join(cwd, 'plugins/4ge/.data/badges.json')) || {},
    memory: sessionMemory,
    forgeProgress: forgeProgress || null,
    transcript,
  };

  // Git state: mode-aware read via smart-order (C-10, T4.3)
  try {
    const smartOrder = require(path.resolve(__dirname, '../lib/smart-order.cjs'));
    if (smartOrder.readGitState) {
      const gitState = smartOrder.readGitState({ refresh: runExpensiveProbes });
      if (gitState) {
        raw.git = gitState;
        if (gitState.branch) raw.session.branch = gitState.branch;
      }
    }
  } catch { /* smart-order unavailable */ }

  if (stdinOverride && typeof stdinOverride === 'object') {
    for (const [k, v] of Object.entries(stdinOverride)) {
      raw[k] = v;
    }
  }

  return raw;
}

/**
 * Merge live harness stdin data into a canonical engine state.
 * Harness values are authoritative — they override disk-derived estimates.
 *
 * Harness stdin schema:
 *   { model, context_window, rate_limits, cost, session_id, effort, thinking }
 *
 * @param {object} state   - Canonical state from loadHudData()
 * @param {object} harness - Parsed JSON from harness stdin (may be null/partial)
 * @returns {object} The mutated state (same reference)
 */
function mergeHarnessStdin(state, harness) {
  if (!harness || typeof harness !== 'object') return state;

  // Model label
  if (harness.model) {
    state.session.model =
      harness.model.display_name ||
      harness.model.id ||
      state.session.model;
  }

  // Context %
  if (harness.context_window) {
    const cw = harness.context_window;
    if (typeof cw.used_percentage === 'number') {
      state.session.contextPct = cw.used_percentage;
      // Harness provides real data — clear the estimate label if still default
      if (state.session.contextLabel === 'est.') state.session.contextLabel = '';
    }
    if (typeof cw.total_output_tokens === 'number') {
      state.session.outputTokens = cw.total_output_tokens;
    }
    if (typeof cw.total_tokens === 'number') {
      // Express as "of 1M", "of 200K", etc.
      const total = cw.total_tokens;
      const label =
        total >= 900000
          ? `of ${Math.round(total / 1000000)}M`
          : total >= 1000
          ? `of ${Math.round(total / 1000)}K`
          : `of ${total}`;
      state.session.contextLabel = label;
    }
  }

  // Rate limits — replace 'N/A' sentinel with live object
  if (harness.rate_limits) {
    const rl = harness.rate_limits;
    state.session.rateLimits = {
      fiveHour:
        (rl.five_hour && typeof rl.five_hour.used_percentage === 'number')
          ? rl.five_hour.used_percentage
          : 0,
      sevenDay:
        (rl.seven_day && typeof rl.seven_day.used_percentage === 'number')
          ? rl.seven_day.used_percentage
          : 0,
      fiveHourResetsAt: (rl.five_hour && rl.five_hour.resets_at) || null,
      sevenDayResetsAt: (rl.seven_day && rl.seven_day.resets_at) || null,
    };
  }

  // Session ID
  if (harness.session_id) {
    state.session.id = harness.session_id;
  }

  // Cost — total USD and breakdown
  if (harness.cost) {
    if (typeof harness.cost.total_cost_usd === 'number') state.session.cost = harness.cost.total_cost_usd;
    if (typeof harness.cost.total_duration_ms === 'number') state.session.durationMs = harness.cost.total_duration_ms;
    if (typeof harness.cost.total_api_duration_ms === 'number') state.session.apiDurationMs = harness.cost.total_api_duration_ms;
    if (typeof harness.cost.input_tokens === 'number') state.session.inputTokens = harness.cost.input_tokens;
    if (typeof harness.cost.output_tokens === 'number') state.session.outputTokens = harness.cost.output_tokens;
    if (typeof harness.cost.cache_read_tokens === 'number') state.session.cacheReadTokens = harness.cost.cache_read_tokens;
    if (typeof harness.cost.cache_creation_tokens === 'number') state.session.cacheCreationTokens = harness.cost.cache_creation_tokens;
    if (typeof harness.cost.total_lines_added === 'number') state.session.linesAdded = harness.cost.total_lines_added;
    if (typeof harness.cost.total_lines_removed === 'number') state.session.linesRemoved = harness.cost.total_lines_removed;
  }

  // Worktree and workspace
  if (harness.worktree) {
    if (typeof harness.worktree.branch === 'string') state.session.branch = harness.worktree.branch;
    if (typeof harness.worktree.path === 'string') state.session.worktreePath = harness.worktree.path;
  }
  if (harness.workspace && typeof harness.workspace.name === 'string') {
    state.session.workspace = harness.workspace.name;
  }

  // Harness metadata
  if (typeof harness.version === 'string') state.session.harnessVersion = harness.version;
  if (typeof harness.output_style === 'string') state.session.outputStyle = harness.output_style;
  if (typeof harness.vim === 'boolean') state.session.vimMode = harness.vim;

  // Model breakdown
  if (harness.model) {
    if (typeof harness.model.id === 'string') state.session.modelId = harness.model.id;
    if (typeof harness.model.provider === 'string') state.session.modelProvider = harness.model.provider;
    // Write the live model back to session-meta.json when it drifts.
    // os-boot.cjs seeds meta.model from the settings.json pin at boot and nothing
    // corrected it afterward, so boot-dashboard renders (no harness stdin) showed
    // the pin forever. Harness stdin is ground truth; persist it on change only —
    // a no-op on every tick except the one right after a /model switch.
    if (typeof harness.model.id === 'string' && harness.model.id) {
      try {
        const fs = require('node:fs');
        const path = require('node:path');
        const root = state.projectRoot || process.env.CLAUDE_PROJECT_DIR || process.cwd();
        const metaPath = path.join(root, '_runs', 'os', 'session-meta.json');
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        if (meta && meta.model !== harness.model.id) {
          meta.model = harness.model.id;
          meta.model_updated_at = new Date().toISOString();
          fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');
        }
      } catch { /* best-effort — never let write-back break a render */ }
    }
  }

  // Context window — remaining tokens + 200K degradation flag
  if (harness.context_window && typeof harness.context_window.remaining_tokens === 'number') {
    state.session.remainingTokens = harness.context_window.remaining_tokens;
  }
  if (harness.exceeds_200k_tokens === true) {
    state.session.exceeds200k = true;
  }

  // Agent context
  if (harness.agent) {
    if (typeof harness.agent.id === 'string') state.context.agentId = harness.agent.id;
    if (typeof harness.agent.type === 'string') state.context.agentType = harness.agent.type;
    if (typeof harness.agent.name === 'string') state.context.agentName = harness.agent.name;
  }

  // Effort level (v2.1.119+)
  if (harness.effort && typeof harness.effort.level === 'string') {
    state.session.effortLevel = harness.effort.level;
  }

  // Thinking enabled (v2.1.119+)
  if (harness.thinking && typeof harness.thinking.enabled === 'boolean') {
    state.session.thinkingEnabled = harness.thinking.enabled;
  }

  return state;
}

module.exports = {
  loadHudData,
  buildCapabilities,
  computeUptime,
  deriveOverall,
  readJsonSafe,
  mergeHarnessStdin,
};
