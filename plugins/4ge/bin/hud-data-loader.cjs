'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { reactiveTtlMap } = require('../lib/hud-events.cjs');
const { readBoard } = require('../lib/hud-board-store.cjs');

function readJsonSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function readEnvDimension(name) {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function timestampMs(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : NaN;
  }
  return NaN;
}

function roundAgeMinutes(ms) {
  return Math.round(ms / 60000);
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
const TRANSCRIPT_FRESHNESS_MS = 30000;
const ANOMALY_TTL_MS = 10 * 60 * 1000;
const VRAM_CACHE_TTL_MS = 10 * 60 * 1000;
const REAPER_LOG_TTL_MS = 2 * 60 * 60 * 1000;

const HUD_HISTORY_TTL_MS = 6 * 60 * 60 * 1000;
const HUD_HISTORY_MAX_SAMPLES = 120;
const HUD_HISTORY_MIN_SAMPLE_MS = 30000;
const RIG_CONTEXT_DEFAULT_TTL_MS = 60 * 60 * 1000;

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

function rigStatusRank(status) {
  switch (status) {
    case 'error':
    case 'failed':
      return 3;
    case 'warn':
      return 2;
    case 'unknown':
      return 1;
    case 'ok':
    default:
      return 0;
  }
}

function normalizeRigStatus(status) {
  if (status === 'ok' || status === 'warn' || status === 'unknown' || status === 'error') return status;
  if (status === 'failed') return 'error';
  return 'unknown';
}

function normalizeRigContext(raw, { now = Date.now(), relPath = '_runs/os/rig-context.json' } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const checks = raw.checks && typeof raw.checks === 'object' && !Array.isArray(raw.checks)
    ? raw.checks
    : {};
  const issues = Object.entries(checks)
    .map(([name, check]) => {
      const status = normalizeRigStatus(check && check.status);
      if (status === 'ok') return null;
      return {
        name,
        status,
        summary: clipHudText((check && check.summary) || 'No summary', 120),
      };
    })
    .filter(Boolean);

  const status = Object.values(checks).reduce((current, check) => {
    const candidate = normalizeRigStatus(check && check.status);
    return rigStatusRank(candidate) > rigStatusRank(current) ? candidate : current;
  }, Object.keys(checks).length > 0 ? 'ok' : 'unknown');

  const generatedAt = typeof raw.generated_at === 'string'
    ? raw.generated_at
    : (typeof raw.produced_at === 'string' ? raw.produced_at : '');
  const generatedMs = timestampMs(generatedAt);
  const ageMinutes = Number.isFinite(generatedMs)
    ? Math.max(0, roundAgeMinutes(now - generatedMs))
    : null;
  const ttlSeconds = Number(raw.ttl_seconds);
  const ttlMs = Number.isFinite(ttlSeconds) && ttlSeconds > 0
    ? ttlSeconds * 1000
    : RIG_CONTEXT_DEFAULT_TTL_MS;
  const isStale = !Number.isFinite(generatedMs) || (now - generatedMs) > ttlMs;

  return {
    path: relPath,
    status,
    issueCount: issues.length,
    headline: issues.length === 0
      ? 'rig context ok'
      : `${issues.length} rig ${issues.length === 1 ? 'check needs' : 'checks need'} attention`,
    generatedAt,
    ageMinutes,
    isStale,
    sessionId: typeof raw.session_id === 'string' ? raw.session_id : '',
    issues,
  };
}

function readRigContext(filePath, now = Date.now()) {
  return normalizeRigContext(readJsonSafe(filePath), { now });
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
  if (bootStatus && bootStatus.capabilities && typeof bootStatus.capabilities === 'object') {
    for (const [name, info] of Object.entries(bootStatus.capabilities)) {
      const validInfo = !!info && typeof info === 'object';
      caps[name] = {
        status: validInfo ? (info.status || 'unknown') : 'unknown',
        init_ms: validInfo ? (info.init_ms || 0) : 0,
      };
      if (validInfo) {
        caps[name].ok = info.status === 'ready';
        if (info.reason) caps[name].reason = info.reason;
        if (info.shelved === true) caps[name].shelved = true;
      }
    }
  }
  if (health && typeof health === 'object') {
    for (const [name, h] of Object.entries(health)) {
      const healthEntry = h && typeof h === 'object' ? h : null;
      const hasDefinedOk = healthEntry !== null && healthEntry.ok !== undefined;
      const malformedOk = hasDefinedOk && typeof healthEntry.ok !== 'boolean';
      // A defined non-boolean is malformed live evidence, not an absent
      // observation. Fail it closed so it cannot inherit boot-ready state or
      // retain a boot-time shelved exemption from actionable-degradation readers.
      const liveOk = hasDefinedOk
        ? (malformedOk ? false : healthEntry.ok)
        : undefined;
      if (!caps[name]) {
        caps[name] = { status: liveOk === true ? 'ready' : 'degraded', init_ms: 0 };
      } else {
        caps[name] = { ...caps[name] };
      }
      if (healthEntry) {
        if (hasDefinedOk) {
          caps[name].ok = liveOk;
          // Keep status aligned with live probe result -- boot-status caches
          // init-time state and can go stale when probe recovers (e.g., aisle
          // state dir created mid-session). Prefer current probe truth.
          caps[name].status = liveOk ? 'ready' : 'degraded';
          if (malformedOk) delete caps[name].shelved;
        }
        if (healthEntry.reason) caps[name].reason = healthEntry.reason;
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

/** Anchor entries older than this (by `last_seen_ms`) are pruned on write. */
const SESSION_ANCHOR_MAX_AGE_MS = 48 * 60 * 60 * 1000;

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
 * The original implementation kept ONE global anchor slot in
 * `session-uptime.json` and reset it whenever the passed `sessionId` differed
 * from the stored id. That is correct for a single caller but breaks under
 * concurrent callers sharing the same `stateDir` — two Claude Code sessions
 * (or the same session's stdin-fed statusline path racing the stale
 * disk-only path fed by `session-meta.json`) ping-pong the single slot back
 * and forth, each resetting the other's anchor to `now` on every poll.
 * Uptime pins near 0 instead of growing.
 *
 * Fix: `session-uptime.json` now holds a per-session MAP —
 * `{ version: 2, sessions: { [sessionId]: { started_at_ms, tool_count_base,
 * last_seen_ms } } }`. A mismatched `sessionId` creates/reads its OWN entry;
 * it never touches another session's entry. Entries older than
 * `SESSION_ANCHOR_MAX_AGE_MS` (48h, by `last_seen_ms`) are pruned whenever the
 * file is written. Legacy single-slot anchors (`{ session_id, started_at_ms,
 * tool_count_base }`) are migrated into the new map on first read.
 *
 * `tool_count_base` snapshots the cumulative all-caller `tool_count_running` at
 * session start, so the HUD can show THIS session's tool count (running - base)
 * the same way it shows this session's uptime — both were process-cumulative
 * before (the inflated tool count shared the uptime bug's root cause).
 *
 * Returns `{ uptimeMs, sessionToolCount }` for the current session, or `null`
 * when no live session_id is available (caller keeps the boot-time fallback).
 * `sessionToolCount` is null when no running count was supplied. Write is
 * best-effort + atomic; it only writes when this session's entry is new,
 * needs backfill, the file needed migration, or pruning removed an entry
 * (unchanged repeat calls for an already-anchored session do not write).
 */
function resolveSessionUptime({ stateDir, sessionId, now = Date.now(), toolCountRunning = null } = {}) {
  if (!sessionId || typeof sessionId !== 'string') return null;
  const hasRunning = typeof toolCountRunning === 'number' && toolCountRunning >= 0;
  const anchorPath = path.join(stateDir, 'session-uptime.json');
  const raw = readJsonSafe(anchorPath);
  let dirty = false;
  let sessions;
  if (raw && raw.sessions && typeof raw.sessions === 'object') {
    sessions = raw.sessions;
  } else if (raw && typeof raw.session_id === 'string' && typeof raw.started_at_ms === 'number') {
    // Legacy single-slot format — migrate it into the new map under its own id.
    sessions = {
      [raw.session_id]: {
        started_at_ms: raw.started_at_ms,
        tool_count_base: typeof raw.tool_count_base === 'number' ? raw.tool_count_base : 0,
        last_seen_ms: now,
      },
    };
    dirty = true;
  } else {
    sessions = {};
  }

  let entry = sessions[sessionId];
  if (!entry || typeof entry.started_at_ms !== 'number') {
    entry = { started_at_ms: now, tool_count_base: hasRunning ? toolCountRunning : 0, last_seen_ms: now };
    sessions[sessionId] = entry;
    dirty = true;
  } else if (typeof entry.tool_count_base !== 'number' && hasRunning) {
    // Backfill base for an anchor written before tool-count tracking existed.
    entry.tool_count_base = toolCountRunning;
    entry.last_seen_ms = now;
    dirty = true;
  }

  if (dirty) {
    // Prune stale sessions (never touches the entry we just created/updated —
    // its last_seen_ms is `now`, always inside the cutoff window).
    const cutoff = now - SESSION_ANCHOR_MAX_AGE_MS;
    for (const [id, e] of Object.entries(sessions)) {
      const stamp = e && typeof e.last_seen_ms === 'number' ? e.last_seen_ms
        : (e && typeof e.started_at_ms === 'number' ? e.started_at_ms : null);
      if (stamp === null || stamp < cutoff) delete sessions[id];
    }
    try {
      const tmp = `${anchorPath}.${process.pid}.${now}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 2, sessions }, null, 2), 'utf8');
      fs.renameSync(tmp, anchorPath);
      // Best-effort cleanup of stale *.tmp siblings left by prior interrupted writes.
      try {
        const dir = path.dirname(anchorPath);
        const base = path.basename(anchorPath);
        for (const f of fs.readdirSync(dir)) {
          if (f.startsWith(`${base}.`) && f.endsWith('.tmp') && path.join(dir, f) !== tmp) {
            try { fs.unlinkSync(path.join(dir, f)); } catch { /* best-effort */ }
          }
        }
      } catch { /* best-effort */ }
    } catch { /* best-effort — fall back to the in-memory entry this call */ }
  }

  const uptimeMs = Math.max(0, now - entry.started_at_ms);
  const sessionToolCount = (hasRunning && typeof entry.tool_count_base === 'number')
    ? Math.max(0, toolCountRunning - entry.tool_count_base)
    : null;
  return { uptimeMs, sessionToolCount };
}

function deriveOverall(caps, bootStatus = {}) {
  const entries = (caps && typeof caps === 'object') ? Object.values(caps) : [];
  const statuses = entries.map(c => (c && typeof c === 'object') ? c.status : undefined);
  if (statuses.includes('failed')) return 'failed';
  if (statuses.includes('degraded')) return 'degraded';
  if (statuses.length === 0 && bootStatus && bootStatus.overall === 'failed') return 'failed';
  if (statuses.length === 0) return 'unknown';
  return statuses.every(status => status === 'ready') ? 'ready' : 'unknown';
}

// An explicit failed boot that registered no capabilities (os-boot's
// capability-failure status). A separate flag because the next cheap health
// refresh fills the capability map and deriveOverall then reads it as ready;
// the face and health zones key `health failed` on this (HUD r5 review P2-1).
function deriveBootFailed(bootStatus) {
  if (!bootStatus || typeof bootStatus !== 'object' || bootStatus.overall !== 'failed') return false;
  const bootCaps = bootStatus.capabilities;
  return !(bootCaps && typeof bootCaps === 'object' && Object.keys(bootCaps).length > 0);
}

function isFreshTranscriptPath(filePath) {
  let mtime = 0;
  try { mtime = fs.statSync(filePath).mtimeMs; } catch { /* ignore */ }
  return mtime > 0 && (Date.now() - mtime) < TRANSCRIPT_FRESHNESS_MS;
}

function loadHudData(opts = {}) {
  const stateDir = opts.stateDir || path.join(process.cwd(), '_runs', 'os');
  const cwd = opts.cwd || process.cwd();
  const runExpensiveProbes = !!opts.runExpensiveProbes;
  const stdinOverride = opts.stdinOverride || null;

  if (runExpensiveProbes) {
    try {
      // Probe the plugin's own OS tree, never the project's lib/os (BL-404):
      // refreshAll require()s every capability module in capDir. Only where
      // the project carries lib/os/health-refresh.cjs, as before.
      const { resolveOsModule, resolveOsModuleIfProjectHas } = require('../hooks/os-guard.cjs');
      const refreshPath = resolveOsModuleIfProjectHas(cwd, 'health-refresh.cjs');
      if (!refreshPath) throw new Error('plugin OS tree unavailable');
      const { refreshAll } = require(refreshPath);
      const capDir = resolveOsModule('capabilities');
      // Attribute this on-demand /4ge HUD refresh so the boot-writers journal records
      // entry:'cli' instead of 'unknown'.
      refreshAll(capDir, stateDir, { entry: 'cli' });
    } catch { /* best-effort */ }
  }

  // Refresh companion memory cache (best-effort, async, non-blocking).
  // Skipped under Vitest: the cache path resolves from CLAUDE_PROJECT_DIR, which
  // hook-spawned test runs inherit, so every loadHudData test would query the
  // live hub and overwrite the real session's cache (the live cache last held a
  // test-fixture entry from 2026-06-09). companion-insights tests drive the
  // refresh directly through its hub-options seam.
  if (!process.env.VITEST) {
    try {
      const { refreshMemoryCache } = require('./companion-insights.cjs');
      refreshMemoryCache(cwd).catch(() => {});
    } catch { /* companion-insights unavailable */ }
  }

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
  const rigContext = readRigContext(path.join(stateDir, 'rig-context.json'));
  const sessionMemory = loadSessionMemory(cwd, forgeSession);

  const capabilities = buildCapabilities(bootStatus, health);
  const overallHealth = deriveOverall(capabilities, bootStatus);
  const uptime = computeUptime(bootStatus);

  // Optional transcript enrichment (AD-6). Gated on freshness.
  let transcript = null;
  try {
    const { findTranscriptPath, loadTranscriptActivity } = require('./hud-transcript-source.cjs');
    const sessionId = meta.session_id || (bootStatus && bootStatus.session_id) || '';
    if (sessionId) {
      const transcriptPath = findTranscriptPath(cwd, sessionId);
      if (transcriptPath && isFreshTranscriptPath(transcriptPath)) {
        const result = loadTranscriptActivity({ cwd, sessionId, transcriptPath });
        // Keep the final eligibility check: a transcript can cross the cutoff
        // while a large file is being read and parsed.
        if (result && result.transcriptPath && isFreshTranscriptPath(result.transcriptPath)) {
          transcript = result;
        }
      }
    }
  } catch { /* best-effort — transcript unavailable */ }

  const raw = {
    projectRoot: cwd,
    // stdout is a pipe under the statusLine slot, so .columns is undefined there;
    // CC (>=2.1.153) exports COLUMNS/LINES to statusline commands instead.
    terminal: {
      cols: process.stdout.columns || readEnvDimension('COLUMNS') || 80,
      rows: process.stdout.rows || readEnvDimension('LINES') || 24,
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
      bootFailed: deriveBootFailed(bootStatus),
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
    rigContext,
    board: readBoard(stateDir),
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

function finiteNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Used context tokens from a stdin `context_window`, or null when it carries none.
 * `current_usage` input + cache creation + cache read is the resident context
 * (the sum scripts/context-now.cjs measures). Without it, `used_percentage` x
 * window size is a rounded estimate (`approx`). `total_input_tokens` is left out:
 * it is not proven to be the resident context.
 * @param {object} cw - stdin context_window
 * @param {number|null} windowSize
 * @returns {{ tokens: number, approx: boolean }|null}
 */
function deriveContextTokens(cw, windowSize) {
  const usage = cw.current_usage;
  if (usage && typeof usage === 'object') {
    const parts = [usage.input_tokens, usage.cache_creation_input_tokens, usage.cache_read_input_tokens]
      .map(finiteNonNegative);
    if (parts.some((n) => n !== null)) {
      return { tokens: parts.reduce((sum, n) => sum + (n || 0), 0), approx: false };
    }
  }
  const pct = finiteNonNegative(cw.used_percentage);
  if (pct !== null && windowSize !== null && windowSize > 0) {
    return { tokens: Math.round(pct * windowSize / 100), approx: true };
  }
  return null;
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
    // CC sends `context_window_size`; `total_tokens` is the pre-2.1.280 name
    // this loader was written against, kept so older payloads still label.
    const windowSize = typeof cw.context_window_size === 'number' ? cw.context_window_size
      : typeof cw.total_tokens === 'number' ? cw.total_tokens
      : null;
    if (windowSize !== null && windowSize > 0) {
      // Express as "of 1M", "of 200K", etc.
      const label =
        windowSize >= 900000
          ? `of ${Math.round(windowSize / 1000000)}M`
          : windowSize >= 1000
          ? `of ${Math.round(windowSize / 1000)}K`
          : `of ${windowSize}`;
      state.session.contextLabel = label;
      state.session.contextWindowSize = windowSize;
    }
    // Row 1's `◈` reads against the rig's manual compact line (hud-engine), so the
    // used-token figure is kept beside the percent; the input/cache token fields
    // stay unmapped (see below).
    const derivedContext = deriveContextTokens(cw, windowSize);
    if (derivedContext) {
      state.session.contextTokens = derivedContext.tokens;
      state.session.contextTokensApprox = derivedContext.approx;
    }
    // The current-context split (`current_usage`, `total_input_tokens`) is not
    // mapped into the input/cache token fields: row 3 of the statusline shows
    // the last response's output tokens only, and the context size is read once,
    // as row 1's `◈ %` (operator report 2026-09-28; HUD-STANDARDS 1.6.3).
    // `total_input_tokens` still drives `remainingTokens` below.
    if (typeof cw.remaining_tokens === 'number') {
      state.session.remainingTokens = cw.remaining_tokens;
    } else if (windowSize !== null && windowSize > 0) {
      if (typeof cw.total_input_tokens === 'number') {
        state.session.remainingTokens = Math.max(0, windowSize - cw.total_input_tokens);
      } else if (typeof cw.remaining_percentage === 'number') {
        state.session.remainingTokens = Math.max(0, Math.round(windowSize * cw.remaining_percentage / 100));
      }
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
  // CC sends `output_style: {name}` and an optional `vim: {mode}` (the 2.1.280
  // schema marks `vim?` optional, so its presence means vim mode is on); the
  // bare string/boolean forms are the older shapes.
  if (typeof harness.output_style === 'string') state.session.outputStyle = harness.output_style;
  else if (harness.output_style && typeof harness.output_style.name === 'string') {
    state.session.outputStyle = harness.output_style.name;
  }
  if (typeof harness.vim === 'boolean') state.session.vimMode = harness.vim;
  else if (harness.vim && typeof harness.vim.mode === 'string') state.session.vimMode = true;

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

  // 200K degradation flag (remaining tokens are derived in the context block above)
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

// --- Session isolation (operator-ruled; contract: docs/reference/hud-vocabulary.md entry 33)
// A statusline speaks ONLY for its own session. The `_runs/os` singletons
// (boot-status.json, session-meta.json, rig-context.json) are shared by every
// session rendering this repo, so whichever session wrote last would bleed into
// every other session's statusline (live repro: foreign boot-pulse, foreign
// S-label, foreign coherence banner, foreign active-sessions nag). Policy is
// SUPPRESSION, not labeling — foreign state simply does not render — and
// multi-instance is NORMAL, never a warning surface. Fleet/full-HUD modes keep
// foreign visibility deliberately by never calling this.
//
// Boot-slice semantics come from boot-coherence (the same module behind the
// statusline coherence row): `self_fork` (boot stamped by the pre-fork ancestor
// id within ±60s of this session's start — the `claude --continue` gap) is OUR
// boot; `d1_foreign` / `d2_cold_boot` are not. Meta and rig slices key on their
// own ownership stamps, with self-fork extending ownership the same way.
let _isoCoherenceMod;
function loadIsolationCoherence() {
  if (_isoCoherenceMod !== undefined) return _isoCoherenceMod;
  const candidates = [
    '../vendor/lib/os/services/boot-coherence.cjs', // installed plugin tree
    '../../../lib/os/services/boot-coherence.cjs',  // dev checkout
  ];
  _isoCoherenceMod = null;
  for (const rel of candidates) {
    try { _isoCoherenceMod = require(rel); break; } catch { /* try next */ }
  }
  return _isoCoherenceMod;
}

function applySessionIsolation(rawState, { stateDir, liveSessionId, stdin = null, now = Date.now() } = {}) {
  if (!rawState || typeof rawState !== 'object') return rawState;
  const iso = {
    liveSessionId: (typeof liveSessionId === 'string' && liveSessionId) ? liveSessionId : null,
    bootOwn: true,
    metaOwn: true,
    rigOwn: true,
    selfFork: false,
  };
  rawState.sessionIsolation = iso;
  // No live identity (no harness stdin session_id) → ownership is undecidable;
  // render as before. Disk-only entries (TTY runs, boot dashboard) land here.
  if (!iso.liveSessionId || !stateDir) return rawState;

  // --- boot slice --------------------------------------------------------------
  let checks = null;
  try {
    const bc = loadIsolationCoherence();
    if (bc && typeof bc.formatBootCoherenceLine === 'function') {
      const coh = bc.formatBootCoherenceLine({ stateDir, liveSessionId: iso.liveSessionId, now });
      checks = (coh && coh.checks) || null;
    }
  } catch { /* fall through to the raw stamp compare */ }
  if (checks && checks.present === false) {
    iso.bootOwn = true; // no boot-status at all — nothing foreign to suppress
  } else if (checks && !checks.corrupt) {
    iso.selfFork = !!checks.self_fork;
    iso.bootOwn = !(checks.d1_foreign || checks.d2_cold_boot);
  } else {
    const bs = readJsonSafe(path.join(stateDir, 'boot-status.json'));
    const owner = (bs && bs.written_by && typeof bs.written_by.session_id === 'string' && bs.written_by.session_id)
      || (bs && typeof bs.session_id === 'string' ? bs.session_id : '');
    iso.bootOwn = !owner || owner === iso.liveSessionId;
  }

  // --- meta slice (S-label, meta-cumulative counters, estimated ctx) ------------
  const meta = readJsonSafe(path.join(stateDir, 'session-meta.json'));
  const metaOwner = meta && typeof meta.session_id === 'string' ? meta.session_id : '';
  iso.metaOwn = !metaOwner || metaOwner === iso.liveSessionId || iso.selfFork;
  if (!iso.metaOwn && rawState.session && typeof rawState.session === 'object') {
    rawState.session.sessionNumber = 0; // foreign S-label never renders
    rawState.session.toolCount = 0;     // foreign session's cumulative counter
    const stdinCtx = stdin && stdin.context_window
      && typeof stdin.context_window.used_percentage === 'number';
    if (!stdinCtx) {
      rawState.session.contextPct = 0;  // foreign estimate; live value arrives via stdin only
      rawState.session.contextLabel = 'est.';
    }
  }

  // --- rig slice -----------------------------------------------------------------
  const rig = rawState.rigContext;
  if (rig && typeof rig === 'object') {
    const rigOwner = typeof rig.sessionId === 'string' ? rig.sessionId : '';
    iso.rigOwn = !!rigOwner && (rigOwner === iso.liveSessionId || iso.selfFork);
    if (!iso.rigOwn) {
      rawState.rigContext = null; // foreign (or unattributed) rig state: suppress whole
    } else if (Array.isArray(rig.issues)) {
      // Own rig state: concurrent sessions are NORMAL — the active_sessions
      // check never renders on a statusline (operator-ruled: multi-instance
      // is a normal operating mode, not a warning).
      const kept = rig.issues.filter((issue) => !(issue && issue.name === 'active_sessions'));
      if (kept.length !== rig.issues.length) {
        rig.issues = kept;
        rig.issueCount = kept.length;
        rig.status = kept.reduce(
          (current, issue) => (rigStatusRank(issue.status) > rigStatusRank(current) ? issue.status : current),
          'ok'
        );
        rig.headline = kept.length === 0
          ? 'rig context ok'
          : `${kept.length} rig ${kept.length === 1 ? 'check needs' : 'checks need'} attention`;
      }
    }
  }

  return rawState;
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
  readRigContext,
  normalizeRigContext,
  REACTIVE_EVENT_TTL_MS,
  ANOMALY_TTL_MS,
  VRAM_CACHE_TTL_MS,
  REAPER_LOG_TTL_MS,
  HUD_HISTORY_TTL_MS,
  HUD_HISTORY_MAX_SAMPLES,
  RIG_CONTEXT_DEFAULT_TTL_MS,
  appendHudHistorySample,
  mergeHarnessStdin,
  applySessionIsolation,
};
