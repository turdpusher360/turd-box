'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { reactiveTtlMap } = require('../lib/hud-events.cjs');

function readJsonSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function timestampMs(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : NaN;
  }
  return NaN;
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function readFreshJson(filePath, options = {}) {
  const fallback = hasOwn(options, 'fallback') ? options.fallback : null;
  const raw = readJsonSafe(filePath);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fallback;

  const ttlMs = Number(options.ttlMs);
  if (!Number.isFinite(ttlMs)) return raw;

  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const timestampKeys = Array.isArray(options.timestampKeys) ? options.timestampKeys : [];
  let ts = NaN;

  if (typeof options.getTimestampMs === 'function') {
    ts = Number(options.getTimestampMs(raw, filePath));
  } else {
    for (const key of timestampKeys) {
      ts = timestampMs(raw[key]);
      if (Number.isFinite(ts)) break;
    }
  }

  if (!Number.isFinite(ts) && options.mtimeFallback === true) {
    try {
      ts = fs.statSync(filePath).mtimeMs;
    } catch {
      return fallback;
    }
  }

  if (!Number.isFinite(ts)) return fallback;
  if (now - ts > ttlMs) return fallback;
  return raw;
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
  return readFreshJson(filePath, {
    ttlMs: HUD_CTX_TTL_MS,
    timestampKeys: ['updated_at'],
    fallback: {},
  });
}

// Forge-progress.json uses top-level `startedAt` (ISO, written by forge-progress-writer.cjs).
// A session that was abandoned without `clear` would linger and show a ghost progress bar.
// 10 minutes: long enough to survive agent context switches, short enough to clear crashed
// sessions before the next session starts.
const FORGE_PROGRESS_TTL_MS = 10 * 60 * 1000;

function readFreshForgeProgress(filePath) {
  return readFreshJson(filePath, {
    ttlMs: FORGE_PROGRESS_TTL_MS,
    timestampKeys: ['startedAt'],
    mtimeFallback: true,
  });
}

// .forge-session.json uses top-level `started` (ISO) per SKILL.md Phase-5 schema.
// Missing / malformed → treat as no active session. TTL mirrors forge-progress so
// they expire together when cleanup is skipped.
const FORGE_SESSION_TTL_MS = FORGE_PROGRESS_TTL_MS;

function readFreshForgeSession(filePath) {
  return readFreshJson(filePath, {
    ttlMs: FORGE_SESSION_TTL_MS,
    timestampKeys: ['started'],
    mtimeFallback: true,
  });
}

const REACTIVE_EVENT_TTL_MS = reactiveTtlMap();
const DEFAULT_REACTIVE_EVENT_TTL_MS = 30000;
const ANOMALY_TTL_MS = 10 * 60 * 1000;
const VRAM_CACHE_TTL_MS = 10 * 60 * 1000;
const REAPER_LOG_TTL_MS = 2 * 60 * 60 * 1000;

const HUD_HISTORY_TTL_MS = 6 * 60 * 60 * 1000;
const HUD_HISTORY_MAX_SAMPLES = 120;
const HUD_HISTORY_MIN_SAMPLE_MS = 30000;

function clampPct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, n));
}

function readFreshReactiveState(filePath, now = Date.now()) {
  const raw = readJsonSafe(filePath);
  if (!raw || typeof raw !== 'object') return null;

  let event = '';
  let ts = 0;
  if (raw.lastEvent && typeof raw.lastEvent === 'object') {
    event = typeof raw.lastEvent.event === 'string' ? raw.lastEvent.event : '';
    const rawTs = raw.lastEvent.triggeredAt || raw.lastEvent.triggered_at || raw.lastEvent.ts;
    ts = typeof rawTs === 'number' ? rawTs : Date.parse(rawTs);
  }

  if (!event && raw.events && typeof raw.events === 'object') {
    for (const [name, value] of Object.entries(raw.events)) {
      if (typeof name !== 'string' || !name) continue;
      if (name.startsWith('anomaly:')) continue;
      const candidate = typeof value === 'number' ? value : Date.parse(value);
      if (Number.isFinite(candidate) && candidate > ts) {
        event = name;
        ts = candidate;
      }
    }
  }

  if (!event || !Number.isFinite(ts) || ts <= 0) return null;
  const ageMs = Math.max(0, now - ts);
  const ttlMs = REACTIVE_EVENT_TTL_MS[event] || DEFAULT_REACTIVE_EVENT_TTL_MS;
  if (ageMs > ttlMs) return null;
  return {
    event,
    triggeredAt: new Date(ts).toISOString(),
    ageMs,
  };
}

function normalizeAnomalyState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const type = typeof raw.type === 'string' ? raw.type.trim() : '';
  const reason = typeof raw.reason === 'string' ? raw.reason.replace(/\s+/g, ' ').trim() : '';
  if (!type || !reason) return null;
  const severity = raw.severity === 'critical' || raw.severity === 'flash'
    ? raw.severity
    : 'signal';
  return {
    type,
    severity,
    reason,
    metrics: (raw.metrics && typeof raw.metrics === 'object' && !Array.isArray(raw.metrics)) ? raw.metrics : {},
    updatedAt: typeof raw.updatedAt === 'string'
      ? raw.updatedAt
      : (typeof raw.updated_at === 'string' ? raw.updated_at : ''),
  };
}

function readFreshAnomalyState(filePath, now = Date.now()) {
  const raw = readFreshJson(filePath, {
    ttlMs: ANOMALY_TTL_MS,
    timestampKeys: ['updatedAt', 'updated_at', 'ts'],
    fallback: null,
    now,
  });
  return normalizeAnomalyState(raw);
}

function normalizeVramState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const freeMiB = Number(raw.freeMiB ?? raw.free_mib ?? raw.free);
  if (!Number.isFinite(freeMiB) || freeMiB < 0) return null;
  const totalMiB = Number(raw.totalMiB ?? raw.total_mib ?? raw.total);
  const ts = timestampMs(raw.updatedAt ?? raw.updated_at ?? raw.ts);
  const out = { freeMiB: Math.round(freeMiB) };
  if (Number.isFinite(totalMiB) && totalMiB >= 0) out.totalMiB = Math.round(totalMiB);
  out.updatedAt = Number.isFinite(ts) ? new Date(ts).toISOString() : '';
  return out;
}

function readFreshVramState(filePath, now = Date.now()) {
  const raw = readFreshJson(filePath, {
    ttlMs: VRAM_CACHE_TTL_MS,
    timestampKeys: ['updatedAt', 'updated_at', 'ts'],
    fallback: null,
    now,
  });
  return normalizeVramState(raw);
}

function readTailText(filePath, maxBytes = 64 * 1024) {
  let fd;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size <= 0) return '';
    const size = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(size);
    fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buffer, 0, size, stat.size - size);
    return buffer.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

function normalizeReaperState(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const ts = timestampMs(raw.updatedAt ?? raw.updated_at ?? raw.ts);
  if (!Number.isFinite(ts) || now - ts > REAPER_LOG_TTL_MS) return null;

  const totalProcs = Number(raw.totalProcs ?? raw.total_procs);
  const mcpProcs = Number(raw.mcpProcs ?? raw.mcp_procs);
  const killed = Number(raw.killed);
  if (!Number.isFinite(totalProcs) && !Number.isFinite(mcpProcs) && !Number.isFinite(killed)) return null;

  return {
    event: typeof raw.event === 'string' ? raw.event : '',
    sessionId: typeof raw.sessionId === 'string'
      ? raw.sessionId
      : (typeof raw.session_id === 'string' ? raw.session_id : ''),
    totalProcs: Number.isFinite(totalProcs) && totalProcs >= 0 ? Math.round(totalProcs) : 0,
    mcpProcs: Number.isFinite(mcpProcs) && mcpProcs >= 0 ? Math.round(mcpProcs) : 0,
    killed: Number.isFinite(killed) && killed >= 0 ? Math.round(killed) : 0,
    kills: Array.isArray(raw.kills) ? raw.kills : [],
    updatedAt: new Date(ts).toISOString(),
  };
}

function readFreshReaperState(filePath, now = Date.now()) {
  const text = readTailText(filePath);
  if (!text) return null;
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines.slice(-20).reverse()) {
    try {
      const normalized = normalizeReaperState(JSON.parse(line), now);
      if (normalized) return normalized;
    } catch { /* ignore partial or malformed tail lines */ }
  }
  return null;
}

function normalizeHudHistorySample(sample, now = Date.now()) {
  if (!sample || typeof sample !== 'object') return null;
  const tsRaw = sample.ts || sample.capturedAt || sample.captured_at;
  const tsMs = typeof tsRaw === 'number' ? tsRaw : Date.parse(tsRaw);
  if (!Number.isFinite(tsMs) || tsMs <= 0) return null;
  if (now - tsMs > HUD_HISTORY_TTL_MS) return null;

  const normalized = { ts: new Date(tsMs).toISOString() };
  const contextPct = clampPct(sample.contextPct);
  const rateFiveHour = clampPct(sample.rateFiveHour);
  const rateSevenDay = clampPct(sample.rateSevenDay);
  if (contextPct !== null) normalized.contextPct = contextPct;
  if (rateFiveHour !== null) normalized.rateFiveHour = rateFiveHour;
  if (rateSevenDay !== null) normalized.rateSevenDay = rateSevenDay;
  if (normalized.contextPct === undefined && normalized.rateFiveHour === undefined && normalized.rateSevenDay === undefined) return null;
  return normalized;
}

function readFreshHudHistory(filePath, now = Date.now()) {
  const raw = readJsonSafe(filePath);
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.samples)) return { v: 1, samples: [] };
  const samples = raw.samples
    .map((sample) => normalizeHudHistorySample(sample, now))
    .filter(Boolean)
    .slice(-HUD_HISTORY_MAX_SAMPLES);
  return { v: 1, samples };
}

function hudHistorySessionFields(history) {
  const samples = history && Array.isArray(history.samples) ? history.samples : [];
  const contextPctHistory = samples
    .map((sample) => sample.contextPct)
    .filter((value) => Number.isFinite(value));
  const rateLimitHistory = samples
    .filter((sample) => Number.isFinite(sample.rateFiveHour) || Number.isFinite(sample.rateSevenDay))
    .map((sample) => ({
      ts: sample.ts,
      fiveHour: Number.isFinite(sample.rateFiveHour) ? sample.rateFiveHour : 0,
      sevenDay: Number.isFinite(sample.rateSevenDay) ? sample.rateSevenDay : 0,
    }));

  const fields = {};
  if (contextPctHistory.length > 0) fields.contextPctHistory = contextPctHistory;
  if (rateLimitHistory.length > 0) fields.rateLimitHistory = rateLimitHistory;
  return fields;
}

function hydrateHudHistoryState(state, history) {
  if (!state || typeof state !== 'object') return state;
  state.session = state.session || {};
  Object.assign(state.session, hudHistorySessionFields(history));
  return state;
}

function sameHudHistoryValues(a, b) {
  if (!a || !b) return false;
  return a.contextPct === b.contextPct
    && a.rateFiveHour === b.rateFiveHour
    && a.rateSevenDay === b.rateSevenDay;
}

function appendHudHistorySample(state, options = {}) {
  if (!state || typeof state !== 'object' || !state.projectRoot || !state.session) return state;
  const now = options.now || Date.now();
  const sample = { ts: new Date(now).toISOString() };

  if (options.includeContext === true) {
    const contextPct = clampPct(state.session.contextPct);
    if (contextPct !== null) sample.contextPct = contextPct;
  }

  if (options.includeRate === true && state.session.rateLimits && typeof state.session.rateLimits === 'object') {
    const rateFiveHour = clampPct(state.session.rateLimits.fiveHour);
    const rateSevenDay = clampPct(state.session.rateLimits.sevenDay);
    if (rateFiveHour !== null) sample.rateFiveHour = rateFiveHour;
    if (rateSevenDay !== null) sample.rateSevenDay = rateSevenDay;
  }

  if (sample.contextPct === undefined && sample.rateFiveHour === undefined && sample.rateSevenDay === undefined) return state;

  const historyPath = path.join(state.projectRoot, '_runs', 'os', 'hud-history.json');
  const history = readFreshHudHistory(historyPath, now);
  const last = history.samples[history.samples.length - 1];
  const lastMs = last ? Date.parse(last.ts) : 0;
  const tooSoonSame = last
    && sameHudHistoryValues(last, sample)
    && Number.isFinite(lastMs)
    && now - lastMs < HUD_HISTORY_MIN_SAMPLE_MS;

  const nextHistory = tooSoonSame
    ? history
    : { v: 1, samples: [...history.samples, sample].slice(-HUD_HISTORY_MAX_SAMPLES) };

  if (!tooSoonSame) {
    try {
      fs.mkdirSync(path.dirname(historyPath), { recursive: true });
      fs.writeFileSync(historyPath, JSON.stringify(nextHistory, null, 2) + '\n');
    } catch { /* best-effort -- HUD history must never break statusline render */ }
  }

  return hydrateHudHistoryState(state, nextHistory);
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

/**
 * Resolve THIS session's uptime, anchored to the live CC `session_id` instead of
 * the OS/process boot time.
 *
 * Why this exists: the HUD uptime was `Date.now() - boot-status.booted_at`,
 * and `booted_at` is stamped once at OS boot and never refreshed for the life of the
 * harness process (os-boot's PID-sentinel skips re-boot on every same-process
 * SessionStart re-fire). A terminal left open across conversations / `/clear` /
 * resume therefore reported the whole PROCESS lifetime, not the session — a 15.8h-open
 * terminal showed `947m`. The CC `session_id` (changes on `/clear` + relaunch) is the
 * correct "this session" identity.
 *
 * We persist a per-session anchor `{ session_id, started_at_ms, tool_count_base }`
 * in `session-uptime.json` and reset it whenever the live `session_id` changes.
 * `tool_count_base` snapshots the cumulative all-caller `tool_count_running` at
 * session start, so the HUD can show THIS session's tool count (running - base)
 * the same way it shows this session's uptime — both were process-cumulative
 * before (the inflated tool count shared the uptime bug's root cause).
 *
 * Returns `{ uptimeMs, sessionToolCount }` for the current session, or `null`
 * when no live session_id is available (caller keeps the boot-time fallback).
 * `sessionToolCount` is null when no running count was supplied. Write is
 * best-effort + atomic; it only writes when the session changes (or to backfill
 * `tool_count_base` on an anchor written before tool tracking existed).
 */
function resolveSessionUptime({ stateDir, sessionId, now = Date.now(), toolCountRunning = null } = {}) {
  if (!sessionId || typeof sessionId !== 'string') return null;
  const hasRunning = typeof toolCountRunning === 'number' && toolCountRunning >= 0;
  const anchorPath = path.join(stateDir, 'session-uptime.json');
  let anchor = readJsonSafe(anchorPath);
  let dirty = false;
  if (!anchor || anchor.session_id !== sessionId || typeof anchor.started_at_ms !== 'number') {
    anchor = { session_id: sessionId, started_at_ms: now, tool_count_base: hasRunning ? toolCountRunning : 0 };
    dirty = true;
  } else if (typeof anchor.tool_count_base !== 'number' && hasRunning) {
    // Backfill base for an anchor written before tool-count tracking existed.
    anchor.tool_count_base = toolCountRunning;
    dirty = true;
  }
  if (dirty) {
    try {
      const tmp = `${anchorPath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(anchor, null, 2), 'utf8');
      fs.renameSync(tmp, anchorPath);
    } catch { /* best-effort — fall back to a fresh anchor in-memory */ }
  }
  const uptimeMs = Math.max(0, now - anchor.started_at_ms);
  const sessionToolCount = (hasRunning && typeof anchor.tool_count_base === 'number')
    ? Math.max(0, toolCountRunning - anchor.tool_count_base)
    : null;
  return { uptimeMs, sessionToolCount };
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
  const reactive = readFreshReactiveState(path.join(stateDir, 'hud-last-reactive.json'));
  const anomaly = readFreshAnomalyState(path.join(stateDir, 'hud-last-anomaly.json'));
  const vram = readFreshVramState(path.join(stateDir, 'vram-cache.json'));
  const processes = readFreshReaperState(path.join(stateDir, 'reaper-log.jsonl'));
  const hudHistory = readFreshHudHistory(path.join(stateDir, 'hud-history.json'));
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
      ...hudHistorySessionFields(hudHistory),
    },
    os: {
      overallHealth,
      bootTime: (bootStatus && bootStatus.total_boot_ms) || 0,
      capabilities,
      vram,
      processes,
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
    reactive,
    anomaly,
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
  let includeHistoryContext = false;
  let includeHistoryRate = false;

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
      includeHistoryContext = true;
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
    includeHistoryRate = true;
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

  if (includeHistoryContext || includeHistoryRate) {
    appendHudHistorySample(state, {
      includeContext: includeHistoryContext,
      includeRate: includeHistoryRate,
    });
  }

  return state;
}

module.exports = {
  loadHudData,
  buildCapabilities,
  computeUptime,
  resolveSessionUptime,
  deriveOverall,
  readJsonSafe,
  readFreshJson,
  readFreshReactiveState,
  readFreshAnomalyState,
  normalizeAnomalyState,
  readFreshVramState,
  normalizeVramState,
  readFreshReaperState,
  normalizeReaperState,
  readFreshHudHistory,
  REACTIVE_EVENT_TTL_MS,
  ANOMALY_TTL_MS,
  VRAM_CACHE_TTL_MS,
  REAPER_LOG_TTL_MS,
  HUD_HISTORY_TTL_MS,
  HUD_HISTORY_MAX_SAMPLES,
  appendHudHistorySample,
  mergeHarnessStdin,
};
