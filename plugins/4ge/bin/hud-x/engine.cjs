#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// HUD-X GLANCE — a dark-cockpit statusline. Design: docs/hud/hud-x-design.md
//
// Drop-in for the statusline command (same stdin contract as hud-engine.cjs):
//   node plugins/4ge/bin/hud-x/engine.cjs --mode=statusline --max-rows=8
// Swap-in (operator-gated, .claude/settings.json statusLine.command):
//   "command": "node plugins/4ge/bin/hud-x/engine.cjs --mode=statusline --max-rows=8"
// Also supports --mode=full (on-demand panel) and --cols=N (width override).
//
// SINGLE RUNTIME FILE by design: on this rig's DrvFS mount each require()
// costs 15-45ms of stat/IO; a six-module tree burned ~155ms before any work.
// The <150ms p95 budget forces one file. Sections below keep the logical
// architecture legible: §1 theme · §2 fmt · §3 gather · §4 view-model ·
// §5 arbiter · §6 render · §7 CLI. hud-data-loader.cjs is NOT on the hot
// path (measured 594ms) — §3 reimplements thin readers against the same
// state-file contracts and TTL discipline.
//
// Contracts this file honors (design doc §9):
//   - fixed 4-row geometry, constant slot budgets per breakpoint
//   - byte-stable idle: nothing finer than minute/5-minute quanta
//   - state-file absence tolerance: every source degrades to a placeholder
//   - multi-session-safe uptime: per-session anchor files, never a shared slot
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('node:fs');
const path = require('node:path');

// ─────────────────────────────────────────────────────────────────────── §1
// THEME — palette, glyphs, ANSI + width utilities.
// BMP-only glyph set (Termius-safe): block elements, box-drawing, braille,
// arrows. No SMP bases, no combining marks, no emoji.

const ESC = '\x1b';
const CSI = `${ESC}[`;
const RESET = `${CSI}0m`;

// U+2800 braille blank — survives CC trailing-whitespace trim (anti-ghost pad).
const PAD = '⠀';

function colorEnabled() {
  if (process.env.HUDX_NO_COLOR === '1') return false;
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '') return false;
  return true;
}

// Saturated xterm-256 indices only — muted mid-brightness indices blend to
// grayscale on mobile Termius (substrate-canvas verified list).
const C = {
  blue: 39,     // #00afff — Anvil eyes, nominal gauge fill
  purple: 63,   // #5f5fff — Anvil brackets, speech ramp
  green: 46,    // sparing: quiet-line check, happy commit
  amber: 214,   // warn threshold
  red: 196,     // alert threshold
};

function sgr(codes, text) {
  if (!colorEnabled()) return text;
  return `${CSI}${codes}m${text}${RESET}`;
}

const paint = {
  fg: (n, text) => sgr(`38;5;${n}`, text),
  bold: (text) => sgr('1', text),
  dim: (text) => sgr('2', text),
  italic: (text) => sgr('3', text),
  boldFg: (n, text) => sgr(`1;38;5;${n}`, text),
  italicFg: (n, text) => sgr(`3;38;5;${n}`, text),
  dimFg: (n, text) => sgr(`2;38;5;${n}`, text),
};

const ANSI_RE = /\x1b\[[0-9;]*m/g;

function stripAnsi(text) {
  return String(text).replace(ANSI_RE, '');
}

function visibleWidth(text) {
  return stripAnsi(text).length;
}

/**
 * Fit styled text into an exact visible-width slot: truncate (with ellipsis)
 * or pad. Truncation appends RESET so an open SGR never bleeds across slots.
 */
function fit(text, width, { padChar = ' ', align = 'left' } = {}) {
  if (width <= 0) return '';
  const str = String(text);
  const vis = visibleWidth(str);
  if (vis === width) return str;
  if (vis < width) {
    const padding = padChar.repeat(width - vis);
    return align === 'right' ? padding + str : str + padding;
  }
  let out = '';
  let seen = 0;
  const budget = width > 1 ? width - 1 : width; // reserve 1 cell for ellipsis
  let i = 0;
  while (i < str.length && seen < budget) {
    if (str[i] === ESC) {
      const m = /^\x1b\[[0-9;]*m/.exec(str.slice(i));
      if (m) { out += m[0]; i += m[0].length; continue; }
    }
    out += str[i];
    seen += 1;
    i += 1;
  }
  if (width > 1) out += '…';
  return out + (colorEnabled() ? RESET : '');
}

const G = {
  annunciator: '▲',
  dirty: '●',
  ahead: '↑',
  behind: '↓',
  reset: '↺',
  trendUp: '↗',
  trendFlat: '→',
  trendDown: '↘',
  tools: '⚒',
  dot: '·',
  check: '✓',
  speechRamp: '⠶',
  speechClose: '⠲',
};

// Lid-model eye apertures: the eye is a constant column;
// expression is how much of it the lids leave visible. One cell per eye.
// Basic emotions symmetric; nuanced ones (concern, thinking) asymmetric.
const EYES = {
  alert:    ['█', '█'],  // wide open
  concern:  ['▄', '▆'],  // asymmetric
  working:  ['▄', '▄'],  // narrowed, engaged
  happy:    ['▀', '▀'],  // bottom lid pushed up (Duchenne)
  thinking: ['▆', '▄'],  // asymmetric
  calm:     ['▆', '▆'],  // nominal
  resting:  ['▂', '▂'],  // heavy lids
  asleep:   ['─', '─'],  // closed
};

/** Anvil eye-pair: purple brackets, blue eyes. Red brackets on alert
 *  (the eyes stay blue — the companion palette holds). */
function renderEyes(expression) {
  const pair = EYES[expression] || EYES.calm;
  const bracketColor = expression === 'alert' ? C.red : C.purple;
  return (
    paint.fg(bracketColor, '[') +
    paint.fg(C.blue, `${pair[0]} ${pair[1]}`) +
    paint.fg(bracketColor, ']')
  );
}

/** Threshold color for burn-style gauges: <70 blue, 70–84 amber, ≥85 red. */
function gaugeColor(pct) {
  const n = Number(pct) || 0;
  if (n >= 85) return C.red;
  if (n >= 70) return C.amber;
  return C.blue;
}

// ─────────────────────────────────────────────────────────────────────── §2
// FMT — byte-stability contract: nothing here emits a value finer than
// minute granularity (commit age uses 5-minute quanta under an hour), so
// idle frames stay byte-identical between 2s refreshes.

function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}h${String(m).padStart(2, '0')}m`;
}

function fmtCountdown(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const dayMs = 24 * 60 * 60 * 1000;
  if (ms >= dayMs) return `${(ms / dayMs).toFixed(1)}d`;
  const mins = Math.floor(ms / 60000);
  if (mins >= 60) return `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, '0')}`;
  return `${mins}m`;
}

function fmtAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const mins = Math.floor(ms / 60000);
  if (mins < 5) return 'now';
  if (mins < 60) return `${Math.floor(mins / 5) * 5}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function fmtTokens(n) {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

function fmtMoney(n) {
  if (!Number.isFinite(n) || n < 0) return '—';
  return `$${n.toFixed(2)}`;
}

function fmtPct(n) {
  if (!Number.isFinite(n)) return '—';
  return `${Math.round(n)}%`;
}

// ─────────────────────────────────────────────────────────────────────── §3
// GATHER — thin readers against the same state-file contracts (and TTL
// discipline) as hud-data-loader.cjs, without its require/IO cost. Every
// reader tolerates absence and malformation by returning null.

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function tsMs(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : NaN;
  }
  return NaN;
}

const FORGE_TTL_MS = 10 * 60 * 1000;        // matches loader FORGE_*_TTL_MS
const ANOMALY_TTL_MS = 10 * 60 * 1000;      // matches loader ANOMALY_TTL_MS
const USAGE_TTL_MS = 30 * 60 * 1000;
const SENTINEL_TTL_MS = 48 * 60 * 60 * 1000;
const UPTIME_ANCHOR_MAX_AGE_MS = 48 * 60 * 60 * 1000;
const MOMENTUM_WINDOW_MS = 10 * 60 * 1000;
const INSIGHT_REFRESH_MS = 60 * 1000;
const HISTORY_MIN_SAMPLE_MS = 30000;        // matches loader HUD_HISTORY_MIN_SAMPLE_MS
const HISTORY_MAX_SAMPLES = 120;            // matches loader HUD_HISTORY_MAX_SAMPLES

// GLANCE attention TTLs for reactive events (how long a past event may own
// the voice slot). Failing events linger longer than celebrations.
const REACTIVE_TTL_MS = {
  'error-state': 120000,
  'test-fail': 90000,
  commit: 90000,
  'test-pass': 60000,
};
const REACTIVE_DEFAULT_TTL_MS = 30000;

function readFreshReactive(stateDir, now) {
  const raw = readJsonSafe(path.join(stateDir, 'hud-last-reactive.json'));
  if (!raw || typeof raw !== 'object') return null;
  let event = '';
  let ts = 0;
  if (raw.lastEvent && typeof raw.lastEvent === 'object') {
    event = typeof raw.lastEvent.event === 'string' ? raw.lastEvent.event : '';
    ts = tsMs(raw.lastEvent.triggeredAt || raw.lastEvent.triggered_at || raw.lastEvent.ts);
  }
  if (!event && raw.events && typeof raw.events === 'object') {
    for (const [name, value] of Object.entries(raw.events)) {
      if (!name || name.startsWith('anomaly:')) continue;
      const candidate = tsMs(value);
      if (Number.isFinite(candidate) && candidate > ts) {
        event = name;
        ts = candidate;
      }
    }
  }
  if (!event || !Number.isFinite(ts) || ts <= 0) return null;
  const ageMs = Math.max(0, now - ts);
  if (ageMs > (REACTIVE_TTL_MS[event] || REACTIVE_DEFAULT_TTL_MS)) return null;
  return { event, ageMs };
}

function readFreshAnomaly(stateDir, now) {
  const raw = readJsonSafe(path.join(stateDir, 'hud-last-anomaly.json'));
  if (!raw || typeof raw !== 'object') return null;
  const ts = tsMs(raw.updatedAt || raw.updated_at || raw.ts);
  if (!Number.isFinite(ts) || now - ts > ANOMALY_TTL_MS) return null;
  const type = typeof raw.type === 'string' ? raw.type.trim() : '';
  const reason = typeof raw.reason === 'string' ? raw.reason.replace(/\s+/g, ' ').trim() : '';
  if (!type || !reason) return null;
  return {
    type,
    reason,
    severity: raw.severity === 'critical' || raw.severity === 'flash' ? raw.severity : 'signal',
  };
}

function readUsageState(stateDir, now) {
  const raw = readJsonSafe(path.join(stateDir, 'usage-state.json'));
  if (!raw || typeof raw !== 'object' || raw.available === false) return null;
  const ts = tsMs(raw.updated_at);
  if (Number.isFinite(ts) && now - ts > USAGE_TTL_MS) return null;
  return {
    plan: typeof raw.plan === 'string' ? raw.plan : '',
    posture: typeof raw.posture === 'string' ? raw.posture : '',
    projected: Number.isFinite(raw.projected_weekly) ? raw.projected_weekly : null,
    sevenDayPct: raw.seven_day && Number.isFinite(raw.seven_day.pct) ? raw.seven_day.pct : null,
    fiveHourPct: raw.five_hour && Number.isFinite(raw.five_hour.pct) ? raw.five_hour.pct : null,
    sevenDayResetsAt: (raw.seven_day && raw.seven_day.resets_at) || null,
    fiveHourResetsAt: (raw.five_hour && raw.five_hour.resets_at) || null,
  };
}

function readSentinelState(stateDir, now) {
  const raw = readJsonSafe(path.join(stateDir, 'sentinel-status.json'));
  if (!raw || typeof raw !== 'object' || !raw.summary) return null;
  const ts = tsMs(raw.ran_at);
  if (Number.isFinite(ts) && now - ts > SENTINEL_TTL_MS) return null;
  const s = raw.summary;
  return {
    red: Array.isArray(s.red) ? s.red.map(String) : [],
    overdue: (Array.isArray(s.doctrine_only_overdue) ? s.doctrine_only_overdue.length : 0)
      + (Array.isArray(s.retiring_overdue) ? s.retiring_overdue.length : 0),
    ok: Number.isFinite(s.enforced_ok) ? s.enforced_ok : 0,
    total: Number.isFinite(s.enforced_total) ? s.enforced_total : 0,
  };
}

/** rig-context.json → {status, issueCount, headline} (loader-compatible). */
function readRigContext(stateDir, now) {
  const raw = readJsonSafe(path.join(stateDir, 'rig-context.json'));
  if (!raw || typeof raw !== 'object') return null;
  const checks = raw.checks && typeof raw.checks === 'object' ? raw.checks : {};
  const rank = { error: 3, failed: 3, warn: 2, unknown: 1, ok: 0 };
  let status = Object.keys(checks).length > 0 ? 'ok' : 'unknown';
  let issues = 0;
  for (const check of Object.values(checks)) {
    const s = check && rank[check.status] !== undefined ? check.status : 'unknown';
    const norm = s === 'failed' ? 'error' : s;
    if (norm !== 'ok') issues += 1;
    if (rank[norm] > rank[status]) status = norm;
  }
  const generatedMs = tsMs(raw.generated_at || raw.produced_at);
  const ttlMs = Number.isFinite(raw.ttl_seconds) && raw.ttl_seconds > 0 ? raw.ttl_seconds * 1000 : 60 * 60 * 1000;
  const isStale = !Number.isFinite(generatedMs) || now - generatedMs > ttlMs;
  return {
    status,
    issueCount: issues,
    headline: issues === 0 ? 'rig context ok' : `${issues} rig ${issues === 1 ? 'check needs' : 'checks need'} attention`,
    isStale,
  };
}

function readForgeFresh(filePath, tsKey, now) {
  const raw = readJsonSafe(filePath);
  if (!raw || typeof raw !== 'object') return null;
  let ts = tsMs(raw[tsKey]);
  if (!Number.isFinite(ts)) {
    try {
      ts = fs.statSync(filePath).mtimeMs;
    } catch {
      return null;
    }
  }
  if (now - ts > FORGE_TTL_MS) return null;
  return raw;
}

/** Capabilities: boot-status init state merged with live health probes —
 *  the probe result wins (same rule as loader buildCapabilities). */
function readCapabilities(stateDir) {
  const boot = readJsonSafe(path.join(stateDir, 'boot-status.json')) || {};
  const health = readJsonSafe(path.join(stateDir, 'health.json')) || {};
  const caps = {};
  if (boot.capabilities && typeof boot.capabilities === 'object') {
    for (const [name, info] of Object.entries(boot.capabilities)) {
      caps[name] = { ready: info.status === 'ready', initMs: info.init_ms || 0 };
    }
  }
  if (health && typeof health === 'object') {
    for (const [name, h] of Object.entries(health)) {
      if (!caps[name]) caps[name] = { ready: !!(h && h.ok), initMs: 0 };
      else if (h && typeof h === 'object' && h.ok !== undefined) caps[name].ready = !!h.ok;
    }
  }
  return { caps, bootMs: boot.total_boot_ms || 0 };
}

// Multi-session-safe uptime anchor: one file PER session id under
// _runs/os/hud-x/ — concurrent sessions never share a slot (the shared
// session-uptime.json clobber bug cannot reproduce here). Pruning happens
// only when a new anchor is created, never on the render hot path.

function sanitizeSessionId(sessionId) {
  return String(sessionId).replace(/[^a-zA-Z0-9-]/g, '').slice(0, 64) || 'unknown';
}

function pruneOldAnchors(dir, now) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith('uptime-') || !name.endsWith('.json')) continue;
    const p = path.join(dir, name);
    try {
      if (now - fs.statSync(p).mtimeMs > UPTIME_ANCHOR_MAX_AGE_MS) fs.unlinkSync(p);
    } catch { /* best-effort */ }
  }
}

function resolveUptime({ dir, sessionId, now = Date.now(), toolCountRunning = null }) {
  if (!sessionId) return { uptimeMs: 0, toolCount: null };
  const hasRunning = typeof toolCountRunning === 'number' && toolCountRunning >= 0;
  const anchorPath = path.join(dir, `uptime-${sanitizeSessionId(sessionId)}.json`);
  let anchor = readJsonSafe(anchorPath);
  if (!anchor || anchor.session_id !== sessionId || typeof anchor.started_at_ms !== 'number') {
    anchor = {
      session_id: sessionId,
      started_at_ms: now,
      tool_count_base: hasRunning ? toolCountRunning : 0,
    };
    try {
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${anchorPath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(anchor, null, 2), 'utf8');
      fs.renameSync(tmp, anchorPath);
      pruneOldAnchors(dir, now);
    } catch { /* best-effort — keep the in-memory anchor */ }
  }
  const uptimeMs = Math.max(0, now - anchor.started_at_ms);
  const toolCount = hasRunning && typeof anchor.tool_count_base === 'number'
    ? Math.max(0, toolCountRunning - anchor.tool_count_base)
    : null;
  return { uptimeMs, toolCount };
}

// Context/rate history: same file + schema + dedupe rule as the loader, so
// either engine's samples remain readable by the other. Appends at most one
// sample per 30s when values changed.
function appendHistorySample(stateDir, { contextPct, sevenDayPct, fiveHourPct }, now) {
  const sample = { ts: new Date(now).toISOString() };
  if (Number.isFinite(contextPct)) sample.contextPct = Math.max(0, Math.min(100, contextPct));
  if (Number.isFinite(fiveHourPct)) sample.rateFiveHour = Math.max(0, Math.min(100, fiveHourPct));
  if (Number.isFinite(sevenDayPct)) sample.rateSevenDay = Math.max(0, Math.min(100, sevenDayPct));
  if (sample.contextPct === undefined && sample.rateFiveHour === undefined && sample.rateSevenDay === undefined) return;

  const historyPath = path.join(stateDir, 'hud-history.json');
  const raw = readJsonSafe(historyPath);
  const samples = raw && Array.isArray(raw.samples) ? raw.samples : [];
  const last = samples[samples.length - 1];
  if (last) {
    const lastMs = tsMs(last.ts);
    const same = last.contextPct === sample.contextPct
      && last.rateFiveHour === sample.rateFiveHour
      && last.rateSevenDay === sample.rateSevenDay;
    if (same && Number.isFinite(lastMs) && now - lastMs < HISTORY_MIN_SAMPLE_MS) return;
  }
  try {
    fs.writeFileSync(historyPath, `${JSON.stringify({ v: 1, samples: [...samples, sample].slice(-HISTORY_MAX_SAMPLES) }, null, 2)}\n`);
  } catch { /* best-effort — history must never break a render */ }
}

/** Companion message — direct read of the same file companion-state.cjs
 *  activeMessage() serves (require()ing that module costs ~110ms). */
function readCompanionMessage(stateDir, now) {
  const raw = readJsonSafe(path.join(stateDir, '.companion-state.json'));
  if (!raw || !raw.message || !raw.message.text) return null;
  const age = now - (raw.message.at || 0);
  if (age > (raw.message.ttl || 15000)) return null;
  return { text: raw.message.text, tier: raw.message.tier || 'flash' };
}

// Insight bridge: companion-insights.getInsight costs ~50ms (require + rules
// + memory cache), too hot for every 2s tick. GLANCE keeps a 60s cache file
// and pays the expensive call on at most ~3% of ticks — p95 stays in budget.
function readInsightCached(stateDir, vmish, now) {
  if (process.env.HUDX_NO_INSIGHT === '1') return null;
  const cachePath = path.join(stateDir, 'hud-x', 'insight-cache.json');
  const cached = readJsonSafe(cachePath);
  if (cached && Number.isFinite(cached.at) && now - cached.at < INSIGHT_REFRESH_MS) {
    return typeof cached.text === 'string' && cached.text ? cached.text : null;
  }
  let text = null;
  try {
    const { getInsight } = require('../companion-insights.cjs');
    const insight = getInsight(vmish);
    if (typeof insight === 'string') text = insight;
    else if (insight && typeof insight.text === 'string') text = insight.text;
  } catch { /* optional */ }
  try {
    fs.mkdirSync(path.join(stateDir, 'hud-x'), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify({ at: now, text: text || '' }));
  } catch { /* best-effort */ }
  return text;
}

/** First non-heading line of the cartridge momentum — session-start voice. */
function readMomentum(cwd) {
  const cartridge = readJsonSafe(path.join(cwd, '_runs', 'session-cartridge.json'));
  if (!cartridge || typeof cartridge !== 'object') return '';
  const momentum = cartridge.momentum && typeof cartridge.momentum === 'object' ? cartridge.momentum : {};
  const text = typeof momentum.summary === 'string' ? momentum.summary.replace(/\s+/g, ' ').trim() : '';
  return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}

// ─────────────────────────────────────────────────────────────────────── §4
// VIEW-MODEL — plain object; all rendering decisions live in §5/§6.

function shortModel(name) {
  const cleaned = String(name || '').replace(/claude[-_ ]?/i, '').trim();
  const token = cleaned.split(/[\s\-_]+/)[0] || '?';
  return token.toLowerCase();
}

function contextTrend(history) {
  if (!Array.isArray(history) || history.length < 3) return null;
  const values = history.filter((v) => Number.isFinite(v));
  if (values.length < 3) return null;
  const last = values[values.length - 1];
  const prior = values[Math.max(0, values.length - 6)];
  const delta = last - prior;
  if (delta >= 3) return 'up';
  if (delta <= -3) return 'down';
  return 'flat';
}

function msUntil(iso, now) {
  if (!iso) return null;
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return null;
  return Math.max(0, ts - now);
}

/**
 * Gather all state and build the view-model. `stdin` is the CC harness
 * payload (may be null); harness values are authoritative over disk.
 */
function buildViewModel({ cwd = process.cwd(), stateDir = null, stdin = null, now = Date.now() } = {}) {
  const dir = stateDir || path.join(cwd, '_runs', 'os');
  const meta = readJsonSafe(path.join(dir, 'session-meta.json')) || {};
  const { caps, bootMs } = readCapabilities(dir);
  const git = readJsonSafe(path.join(dir, 'git-state.json')) || {};
  const usage = readUsageState(dir, now);
  const sentinel = readSentinelState(dir, now);
  const rig = readRigContext(dir, now);
  const reactive = readFreshReactive(dir, now);
  const anomaly = readFreshAnomaly(dir, now);
  const historyRaw = readJsonSafe(path.join(dir, 'hud-history.json'));
  const forgeSession = readForgeFresh(path.join(cwd, '.forge-session.json'), 'started', now);
  const forgeProgress = readForgeFresh(path.join(dir, 'forge-progress.json'), 'startedAt', now);
  const activeFlag = readJsonSafe(path.join(dir, 'hud-active.json'));
  const message = readCompanionMessage(dir, now);

  // Harness stdin (authoritative) with disk fallbacks.
  const sessionId = (stdin && stdin.session_id) || meta.session_id || '';
  const modelName = (stdin && stdin.model && (stdin.model.display_name || stdin.model.id))
    || meta.model || '?';
  const cw = stdin && stdin.context_window;
  const contextPct = cw && Number.isFinite(cw.used_percentage)
    ? cw.used_percentage
    : (Number.isFinite(meta.est_context_pct) ? meta.est_context_pct : null);
  let totalLabel = '';
  if (cw && Number.isFinite(cw.total_tokens)) {
    const total = cw.total_tokens;
    totalLabel = total >= 900000 ? `${Math.round(total / 1000000)}M`
      : total >= 1000 ? `${Math.round(total / 1000)}K` : String(total);
  } else if (!cw && contextPct !== null) {
    totalLabel = 'est.';
  }
  const rl = stdin && stdin.rate_limits;
  const sevenDayPct = rl && rl.seven_day && Number.isFinite(rl.seven_day.used_percentage)
    ? rl.seven_day.used_percentage
    : (usage ? usage.sevenDayPct : null);
  const fiveHourPct = rl && rl.five_hour && Number.isFinite(rl.five_hour.used_percentage)
    ? rl.five_hour.used_percentage
    : (usage ? usage.fiveHourPct : null);
  const sevenDayResetMs = msUntil((rl && rl.seven_day && rl.seven_day.resets_at) || (usage && usage.sevenDayResetsAt), now);
  const fiveHourResetMs = msUntil((rl && rl.five_hour && rl.five_hour.resets_at) || (usage && usage.fiveHourResetsAt), now);
  const cost = stdin && stdin.cost;

  // History: mirror the live engine's sampling so trend survives a swap.
  if (stdin && (cw || rl)) {
    appendHistorySample(dir, {
      contextPct: cw ? contextPct : null,
      sevenDayPct: rl ? sevenDayPct : null,
      fiveHourPct: rl ? fiveHourPct : null,
    }, now);
  }
  const historySamples = historyRaw && Array.isArray(historyRaw.samples) ? historyRaw.samples : [];
  const ctxHistory = historySamples.map((s) => s.contextPct).filter((v) => Number.isFinite(v));

  const uptime = resolveUptime({
    dir: path.join(dir, 'hud-x'),
    sessionId,
    now,
    toolCountRunning: Number.isFinite(meta.tool_count_running) ? meta.tool_count_running : null,
  });

  const capNames = Object.keys(caps).sort();
  const degraded = capNames.filter((n) => !caps[n].ready);

  const lastCommit = Array.isArray(git.recentCommits) && git.recentCommits.length > 0 ? git.recentCommits[0] : null;
  const lastCommitTs = lastCommit ? tsMs(lastCommit.ts) : NaN;

  let idleMs = 0;
  if (activeFlag && activeFlag.active === false && activeFlag.at) {
    const at = tsMs(activeFlag.at);
    if (Number.isFinite(at)) idleMs = Math.max(0, now - at);
  }

  const vm = {
    now,
    repo: path.basename(cwd),
    sessionNumber: Number(meta.session_number) || 0,
    model: modelName,
    modelShort: shortModel(modelName),
    context: {
      pct: contextPct !== null ? Math.max(0, Math.min(100, contextPct)) : null,
      totalLabel,
      trend: contextTrend(ctxHistory),
      history: ctxHistory.slice(-24),
    },
    usage: {
      sevenDayPct,
      fiveHourPct,
      sevenDayResetMs,
      fiveHourResetMs,
      posture: (usage && usage.posture) || '',
      plan: (usage && usage.plan) || '',
      projected: usage ? usage.projected : null,
    },
    os: {
      ready: capNames.length - degraded.length,
      total: capNames.length,
      degraded,
      bootMs,
      detail: capNames.map((n) => ({ name: n, ready: caps[n].ready, initMs: caps[n].initMs })),
    },
    git: {
      branch: typeof git.branch === 'string' ? git.branch : '',
      dirty: Number.isFinite(git.uncommittedFiles) ? git.uncommittedFiles : null,
      ahead: Number.isFinite(git.ahead) ? git.ahead : null,
      behind: Number.isFinite(git.behind) ? git.behind : null,
      sha: lastCommit && typeof lastCommit.sha === 'string' ? lastCommit.sha.slice(0, 7) : '',
      subject: lastCommit && typeof lastCommit.subject === 'string' ? lastCommit.subject : '',
      commitAgeMs: Number.isFinite(lastCommitTs) ? Math.max(0, now - lastCommitTs) : null,
    },
    session: {
      uptimeMs: uptime.uptimeMs,
      toolCount: uptime.toolCount !== null ? uptime.toolCount : (meta.tool_count_running || 0),
      costUsd: cost && Number.isFinite(cost.total_cost_usd) ? cost.total_cost_usd : null,
      inTok: cost && Number.isFinite(cost.input_tokens) ? cost.input_tokens : null,
      outTok: cost && Number.isFinite(cost.output_tokens) ? cost.output_tokens : null,
      active: !!(activeFlag && activeFlag.active === true),
      idleMs,
    },
    forge: {
      active: !!forgeSession,
      phase: (forgeSession && (forgeSession.phase || forgeSession.current_phase)) || '',
      scope: (forgeSession && (forgeSession.scope || forgeSession.slug)) || '',
      teammates: forgeSession && Array.isArray(forgeSession.teammates) ? forgeSession.teammates.length : 0,
      progressPct: forgeProgress && Number.isFinite(forgeProgress.pct) ? forgeProgress.pct
        : forgeProgress && Number.isFinite(forgeProgress.percent) ? forgeProgress.percent
        : forgeProgress && Number.isFinite(forgeProgress.completed) && Number.isFinite(forgeProgress.total) && forgeProgress.total > 0
          ? Math.round((forgeProgress.completed / forgeProgress.total) * 100)
          : null,
    },
    reactive,
    anomaly,
    rig,
    sentinel,
    companion: { message, insight: null },
    memory: { lastSession: '' },
  };

  // Voice-slot lazy loads — only when they could actually win arbitration.
  const urgent = (sentinel && sentinel.red.length > 0)
    || (rig && rig.status === 'error')
    || degraded.length > 0
    || !!anomaly
    || (reactive && (reactive.event === 'test-fail' || reactive.event === 'error-state'))
    || (Number.isFinite(sevenDayPct) && sevenDayPct >= 80)
    || (Number.isFinite(fiveHourPct) && fiveHourPct >= 80)
    || (vm.context.pct !== null && vm.context.pct >= 85);
  if (!urgent) {
    if (uptime.uptimeMs < MOMENTUM_WINDOW_MS) vm.memory.lastSession = readMomentum(cwd);
    if (!message && !vm.forge.active && !reactive) {
      vm.companion.insight = readInsightCached(dir, vm, now);
    }
  }

  return vm;
}

// ─────────────────────────────────────────────────────────────────────── §5
// ARBITER — the voice slot shows exactly ONE line, chosen by strict
// descending severity (design doc §5). Warn+ losers light the annunciator.
// Pure function of the view-model; vm.now is the only time source.

const IDLE_RESTING_MS = 15 * 60 * 1000;
const IDLE_ASLEEP_MS = 45 * 60 * 1000;
const CELEBRATE_EVENTS = new Set(['commit', 'test-pass']);
const TROUBLE_EVENTS = new Set(['test-fail', 'error-state']);

function collectCandidates(vm) {
  const out = [];

  if (vm.sentinel && vm.sentinel.red.length > 0) {
    const first = vm.sentinel.red[0];
    const more = vm.sentinel.red.length > 1 ? ` (+${vm.sentinel.red.length - 1})` : '';
    out.push({ sev: 'red', kind: 'sentinel', text: `sentinel RED: ${first}${more}` });
  }
  if (vm.rig && vm.rig.status === 'error') {
    out.push({ sev: 'red', kind: 'rig-error', text: `rig: ${vm.rig.headline || 'rig check failed'}` });
  }
  if (vm.os.total > 0 && vm.os.degraded.length > 0) {
    out.push({ sev: 'red', kind: 'os-degraded', text: `OS degraded: ${vm.os.degraded.join(', ')}` });
  }
  if (vm.anomaly) {
    out.push({
      sev: vm.anomaly.severity === 'critical' ? 'red' : 'warn',
      kind: 'anomaly',
      text: `${vm.anomaly.type}: ${vm.anomaly.reason}`,
    });
  }
  if (vm.reactive && TROUBLE_EVENTS.has(vm.reactive.event)) {
    out.push({
      sev: 'warn',
      kind: vm.reactive.event,
      text: vm.reactive.event === 'test-fail' ? 'tests failing' : 'error state detected',
    });
  }
  if (Number.isFinite(vm.usage.sevenDayPct) && vm.usage.sevenDayPct >= 80) {
    out.push({
      sev: 'warn',
      kind: 'burn-7d',
      text: `7d usage ${Math.round(vm.usage.sevenDayPct)}% · resets ${fmtCountdown(vm.usage.sevenDayResetMs)} — ease the fan-out`,
    });
  }
  if (Number.isFinite(vm.usage.fiveHourPct) && vm.usage.fiveHourPct >= 80) {
    out.push({
      sev: 'warn',
      kind: 'burn-5h',
      text: `5h window ${Math.round(vm.usage.fiveHourPct)}% · resets ${fmtCountdown(vm.usage.fiveHourResetMs)}`,
    });
  }
  if (Number.isFinite(vm.context.pct) && vm.context.pct >= 85) {
    out.push({
      sev: 'warn',
      kind: 'context-high',
      text: `context ${Math.round(vm.context.pct)}% — land the lane or /respawn`,
    });
  }
  if (vm.rig && (vm.rig.status === 'warn' || vm.rig.status === 'unknown') && vm.rig.issueCount > 0) {
    out.push({ sev: 'warn', kind: 'rig-warn', text: `rig: ${vm.rig.headline}` });
  }
  if (vm.sentinel && vm.sentinel.overdue > 0) {
    out.push({
      sev: 'warn',
      kind: 'sentinel-overdue',
      text: `sentinel: ${vm.sentinel.overdue} review${vm.sentinel.overdue === 1 ? '' : 's'} overdue`,
    });
  }
  if (vm.forge.active) {
    const bits = ['forge'];
    if (vm.forge.phase) bits.push(vm.forge.phase);
    if (vm.forge.scope) bits.push(vm.forge.scope);
    let text = bits.join(' · ');
    if (Number.isFinite(vm.forge.progressPct)) text += ` — ${Math.round(vm.forge.progressPct)}%`;
    if (vm.forge.teammates > 0) text += ` · ${vm.forge.teammates} teammate${vm.forge.teammates === 1 ? '' : 's'}`;
    out.push({ sev: 'info', kind: 'forge', text });
  }
  if (vm.reactive && CELEBRATE_EVENTS.has(vm.reactive.event)) {
    const text = vm.reactive.event === 'commit'
      ? `commit landed${vm.git.sha ? ` ${vm.git.sha}` : ''}${vm.git.subject ? ` — ${vm.git.subject}` : ''}`
      : 'tests green';
    out.push({ sev: 'ok', kind: vm.reactive.event, text });
  }
  if (vm.companion.message && vm.companion.message.text) {
    out.push({ sev: 'speech', kind: 'message', text: vm.companion.message.text });
  }
  if (vm.companion.insight) {
    out.push({ sev: 'speech', kind: 'insight', text: vm.companion.insight });
  }
  if (vm.session.uptimeMs < MOMENTUM_WINDOW_MS && vm.memory.lastSession) {
    out.push({ sev: 'info', kind: 'momentum', text: `last session: ${vm.memory.lastSession}` });
  }

  const capsBit = vm.os.total > 0 ? `${vm.os.ready}/${vm.os.total} ready` : 'OS state unknown';
  const gitBit = vm.git.branch ? `${vm.git.branch}${vm.git.dirty === 0 ? ' clean' : ''}` : '';
  out.push({
    sev: 'quiet',
    kind: 'quiet',
    text: `all quiet — ${capsBit}${gitBit ? ` · ${gitBit}` : ''}`,
  });

  return out;
}

function resolveEyes(vm, voice, anyRed, anyWarn) {
  if (anyRed) return 'alert';
  if (anyWarn) return 'concern';
  if (voice.sev === 'ok') return 'happy';
  if (voice.sev === 'speech') return 'thinking';
  if (vm.forge.active || vm.session.active) return 'working';
  if (vm.session.idleMs >= IDLE_ASLEEP_MS) return 'asleep';
  if (vm.session.idleMs >= IDLE_RESTING_MS) return 'resting';
  return 'calm';
}

function arbitrate(vm) {
  const candidates = collectCandidates(vm);
  const voice = candidates[0];
  const suppressedAlerts = candidates.slice(1).filter((c) => c.sev === 'red' || c.sev === 'warn');
  const anyRed = candidates.some((c) => c.sev === 'red');
  const anyWarn = candidates.some((c) => c.sev === 'warn');
  return {
    voice,
    suppressed: suppressedAlerts.length,
    suppressedRed: suppressedAlerts.some((c) => c.sev === 'red'),
    eyes: resolveEyes(vm, voice, anyRed, anyWarn),
  };
}

// ─────────────────────────────────────────────────────────────────────── §6
// RENDER — pure. Fixed 4-row geometry at every breakpoint; slot budgets are
// constant per breakpoint so row width never moves with content. Row tails
// pad with U+2800 (CC trims trailing spaces but not braille blanks).

const BAR_RAMP = ['⣀', '⡀', '⣀', '⣄', '⣤', '⣦', '⣶', '⣷', '⣿'];
// index 0 = track glyph (rendered dim); 1..8 = fill eighths.

function breakpoint(cols) {
  if (cols < 64) return 'narrow';
  if (cols < 104) return 'standard';
  return 'wide';
}

function frameWidth(cols, bp) {
  if (bp === 'narrow') return Math.max(40, Math.min(cols, 63));
  if (bp === 'standard') return Math.min(cols, 100);
  return Math.min(cols, 132);
}

/** Braille gauge: threshold-colored fill over a dim track. */
function gauge(pct, cells) {
  if (!Number.isFinite(pct)) return paint.dim('⣀'.repeat(cells));
  const clamped = Math.max(0, Math.min(100, pct));
  const eighthsTotal = Math.round((clamped / 100) * cells * 8);
  let fill = '';
  let track = '';
  for (let i = 0; i < cells; i += 1) {
    const cellEighths = Math.max(0, Math.min(8, eighthsTotal - i * 8));
    if (cellEighths > 0) fill += BAR_RAMP[cellEighths];
    else track += '⣀';
  }
  return (fill ? paint.fg(gaugeColor(clamped), fill) : '') + (track ? paint.dim(track) : '');
}

function trendGlyph(trend) {
  if (trend === 'up') return G.trendUp;
  if (trend === 'down') return G.trendDown;
  if (trend === 'flat') return G.trendFlat;
  return ' ';
}

const SEV_TICK = {
  red: () => paint.fg(C.red, G.annunciator),
  warn: () => paint.fg(C.amber, G.annunciator),
  ok: () => paint.fg(C.green, G.check),
  speech: () => paint.fg(C.purple, G.speechRamp),
  info: () => paint.dim(G.dot),
  quiet: () => paint.dim(G.dot),
};

function styleVoiceText(voice) {
  switch (voice.sev) {
    case 'red': return paint.boldFg(C.red, voice.text);
    case 'warn': return paint.fg(C.amber, voice.text);
    case 'ok': return paint.fg(C.green, voice.text);
    case 'speech': return paint.italic(`${voice.text} ${paint.fg(C.purple, G.speechClose)}`);
    case 'quiet': return paint.dim(voice.text);
    default: return voice.text;
  }
}

function rowVoice(vm, verdict, width) {
  const eyes = renderEyes(verdict.eyes); // 5 cells: [ x y ]
  const tick = (SEV_TICK[verdict.voice.sev] || SEV_TICK.info)();
  const annun = verdict.suppressed > 0
    ? paint.fg(verdict.suppressedRed ? C.red : C.amber, `${G.annunciator}${Math.min(verdict.suppressed, 9)}`)
    : PAD + PAD;
  const textWidth = width - 5 - 1 - 1 - 1 - 2; // eyes, sp, tick, sp, annunciator
  const text = fit(styleVoiceText(verdict.voice), textWidth, { padChar: PAD });
  return `${eyes} ${tick} ${text}${annun}`;
}

function ctxGauge(vm, bp) {
  const cells = bp === 'narrow' ? 3 : 5;
  const label = bp === 'narrow' ? 'C' : 'CTX';
  const pctBit = `${fmtPct(vm.context.pct)}${trendGlyph(vm.context.trend)}`;
  const totalBit = bp === 'wide' && vm.context.totalLabel ? ` ${paint.dim(vm.context.totalLabel)}` : '';
  return `${paint.dim(label)} ${gauge(vm.context.pct, cells)} ${pctBit}${totalBit}`;
}

function usageGauge(vm, kind, bp) {
  const pct = kind === '7d' ? vm.usage.sevenDayPct : vm.usage.fiveHourPct;
  const resetMs = kind === '7d' ? vm.usage.sevenDayResetMs : vm.usage.fiveHourResetMs;
  const label = bp === 'narrow' ? (kind === '7d' ? 'W' : 'H') : (kind === '7d' ? '7D' : '5H');
  const barBit = bp === 'narrow' ? '' : `${gauge(pct, 5)} `;
  const resetBit = resetMs !== null ? ` ${paint.dim(`${G.reset}${fmtCountdown(resetMs)}`)}` : '';
  return `${paint.dim(label)} ${barBit}${fmtPct(pct)}${resetBit}`;
}

function rowGauges(vm, bp, width) {
  const sep = ` ${paint.dim(G.dot)} `;
  let row = [ctxGauge(vm, bp), usageGauge(vm, '7d', bp), usageGauge(vm, '5h', bp)].join(sep);
  if (bp === 'wide' && vm.usage.posture) {
    const posture = vm.usage.posture === 'ABUNDANT'
      ? paint.dimFg(C.green, vm.usage.posture)
      : paint.fg(C.amber, vm.usage.posture);
    row += `${sep}${posture}`;
  }
  return fit(row, width, { padChar: PAD });
}

function rowShip(vm, bp, width) {
  const parts = [];
  const branch = vm.git.branch || '?';
  parts.push(vm.git.dirty > 0 ? branch : paint.dim(branch));
  if (vm.git.dirty !== null && vm.git.dirty > 0) {
    parts.push(paint.fg(C.amber, `${G.dirty}${vm.git.dirty}`));
  }
  if (vm.git.ahead !== null || vm.git.behind !== null) {
    const ahead = `${G.ahead}${vm.git.ahead ?? '?'}`;
    const behind = vm.git.behind > 0 || bp !== 'narrow' ? `${G.behind}${vm.git.behind ?? '?'}` : '';
    const styled = (vm.git.ahead > 0 || vm.git.behind > 0)
      ? paint.fg(C.blue, `${ahead}${behind}`)
      : paint.dim(`${ahead}${behind}`);
    parts.push(styled);
  }
  let row = parts.join(' ');
  if (vm.git.sha) {
    const age = vm.git.commitAgeMs !== null ? ` ${paint.dim(fmtAge(vm.git.commitAgeMs))}` : '';
    row += ` ${paint.dim(G.dot)} ${paint.fg(C.purple, vm.git.sha)}${age}`;
  }
  // The tail slot is "what is the repo doing": a live forge lane owns it;
  // otherwise the last commit subject (standard/wide only).
  if (bp !== 'narrow') {
    if (vm.forge.active) {
      const lane = ['forge', vm.forge.phase, vm.forge.scope].filter(Boolean).join(' · ');
      const pct = Number.isFinite(vm.forge.progressPct) ? ` ${Math.round(vm.forge.progressPct)}%` : '';
      row += ` ${paint.dim(G.dot)} ${paint.fg(C.blue, `${lane}${pct}`)}`;
    } else if (vm.git.subject) {
      row += ` ${paint.dim(G.dot)} ${paint.dim(vm.git.subject)}`;
    }
  }
  return fit(row, width, { padChar: PAD });
}

function rowIdentity(vm, bp, width) {
  const sep = ` ${paint.dim(G.dot)} `;
  const parts = [];

  const sBit = vm.sessionNumber > 0 ? `S${vm.sessionNumber}` : '';
  if (bp === 'narrow') {
    parts.push([sBit, vm.modelShort].filter(Boolean).join(' ') || vm.modelShort);
  } else {
    const repo = vm.repo.length > 14 ? `${vm.repo.slice(0, 13)}…` : vm.repo;
    parts.push(`${paint.bold(repo)}${sBit ? ` ${sBit}` : ''}`);
    parts.push(paint.fg(C.purple, vm.modelShort));
  }

  // OS caps: dark cockpit — dim when healthy, loud when not. Narrow drops it
  // entirely when healthy (the quiet line already carries "9/9 ready").
  if (vm.os.total > 0) {
    const healthy = vm.os.degraded.length === 0;
    if (!healthy) parts.push(paint.fg(C.red, `OS ${vm.os.ready}/${vm.os.total}`));
    else if (bp !== 'narrow') parts.push(paint.dim(`OS ${vm.os.ready}/${vm.os.total}`));
  }

  parts.push(`${fmtDuration(vm.session.uptimeMs)} ${paint.dim(G.tools)}${vm.session.toolCount ?? 0}`);
  if (vm.session.costUsd !== null) parts.push(fmtMoney(vm.session.costUsd));
  if (bp !== 'narrow' && vm.session.inTok !== null) {
    parts.push(paint.dim(`${fmtTokens(vm.session.inTok)}→${fmtTokens(vm.session.outTok)}`));
  }

  return fit(parts.join(sep), width, { padChar: PAD });
}

/**
 * The 4-row GLANCE statusline. Row order V/G/S/I; --max-rows below 4 drops
 * rows from the bottom, never reflows survivors.
 */
function renderStatusline(vm, { cols = 80, maxRows = 8 } = {}) {
  const bp = breakpoint(cols);
  const width = frameWidth(cols, bp);
  const verdict = arbitrate(vm);
  const rows = [
    rowVoice(vm, verdict, width),
    rowGauges(vm, bp, width),
    rowShip(vm, bp, width),
    rowIdentity(vm, bp, width),
  ];
  return rows.slice(0, Math.max(1, Math.min(4, maxRows))).join('\n');
}

// Full panel (on-demand, not the 2s surface).

const SPARK_RAMP = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

function sparkline(values, widthCells) {
  if (!Array.isArray(values) || values.length < 2) return '';
  return values.slice(-widthCells).map((v) => {
    const idx = Math.max(0, Math.min(7, Math.floor((v / 100) * 8)));
    return SPARK_RAMP[idx];
  }).join('');
}

function renderFull(vm, { cols = 100 } = {}) {
  const width = Math.min(Math.max(cols, 60), 132);
  const verdict = arbitrate(vm);
  const rule = paint.dim('─'.repeat(width));
  const label = (text) => paint.dim(fit(text, 5));
  const rows = [];

  rows.push(rowVoice(vm, verdict, width));
  rows.push(rule);

  const spark = sparkline(vm.context.history, 16);
  rows.push(`${label('CTX')}${gauge(vm.context.pct, 12)} ${fmtPct(vm.context.pct)}${trendGlyph(vm.context.trend)}${vm.context.totalLabel ? ` ${paint.dim(`of ${vm.context.totalLabel}`)}` : ''}${spark ? `  ${paint.dimFg(C.blue, spark)}` : ''}`);
  const postureBit = vm.usage.posture
    ? `  ${paint.dim('posture')} ${vm.usage.posture === 'ABUNDANT' ? paint.fg(C.green, vm.usage.posture) : paint.fg(C.amber, vm.usage.posture)}${Number.isFinite(vm.usage.projected) ? paint.dim(` → ${vm.usage.projected}%`) : ''}`
    : '';
  rows.push(`${label('7D')}${gauge(vm.usage.sevenDayPct, 12)} ${fmtPct(vm.usage.sevenDayPct)}${vm.usage.sevenDayResetMs !== null ? ` ${paint.dim(`resets ${fmtCountdown(vm.usage.sevenDayResetMs)}`)}` : ''}${postureBit}`);
  rows.push(`${label('5H')}${gauge(vm.usage.fiveHourPct, 12)} ${fmtPct(vm.usage.fiveHourPct)}${vm.usage.fiveHourResetMs !== null ? ` ${paint.dim(`resets ${fmtCountdown(vm.usage.fiveHourResetMs)}`)}` : ''}`);
  rows.push(rule);

  rows.push(`${label('OS')}${vm.os.degraded.length === 0 ? paint.fg(C.green, `${vm.os.ready}/${vm.os.total} ready`) : paint.fg(C.red, `${vm.os.ready}/${vm.os.total} — ${vm.os.degraded.join(', ')}`)}${vm.os.bootMs ? ` ${paint.dim(`boot ${vm.os.bootMs}ms`)}` : ''}`);
  if (vm.os.detail.length > 0) {
    const capsBits = vm.os.detail.map((c) => `${c.name}${c.ready ? paint.fg(C.green, G.check) : paint.fg(C.red, '✗')}`);
    rows.push(`${label('')}${fit(capsBits.join(' '), width - 5, { padChar: PAD })}`);
  }

  rows.push(`${label('GIT')}${vm.git.branch || '?'}${vm.git.dirty > 0 ? ` ${paint.fg(C.amber, `${G.dirty}${vm.git.dirty}`)}` : ` ${paint.dim('clean')}`} ${paint.dim(`${G.ahead}${vm.git.ahead ?? '?'}${G.behind}${vm.git.behind ?? '?'}`)}`);
  if (vm.git.sha) {
    rows.push(`${label('')}${paint.fg(C.purple, vm.git.sha)} ${paint.dim(fmtAge(vm.git.commitAgeMs))} ${fit(vm.git.subject, width - 18, { padChar: PAD })}`);
  }

  if (vm.forge.active) {
    const lane = [vm.forge.phase, vm.forge.scope].filter(Boolean).join(' · ');
    rows.push(`${label('LANE')}${paint.fg(C.blue, lane || 'active')}${Number.isFinite(vm.forge.progressPct) ? ` ${gauge(vm.forge.progressPct, 8)} ${fmtPct(vm.forge.progressPct)}` : ''}${vm.forge.teammates > 0 ? paint.dim(` · ${vm.forge.teammates} teammates`) : ''}`);
  }

  if (vm.sentinel) {
    const sev = vm.sentinel.red.length > 0 ? C.red : (vm.sentinel.overdue > 0 ? C.amber : null);
    const body = `${vm.sentinel.ok}/${vm.sentinel.total} enforced · ${vm.sentinel.red.length} red · ${vm.sentinel.overdue} overdue`;
    rows.push(`${label('SENT')}${sev ? paint.fg(sev, body) : paint.dim(body)}`);
  }

  rows.push(rule);
  rows.push(rowIdentity(vm, 'wide', width));

  return rows.join('\n');
}

// ─────────────────────────────────────────────────────────────────────── §7
// CLI — argv, capped stdin read, gather, render, explicit exit (stray async
// work must never hold a statusline render open).

const STDIN_TIMEOUT_MS = 400;

function parseArgs(argv) {
  const args = { mode: 'statusline', maxRows: 8, cols: null };
  for (const arg of argv) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (!m) continue;
    const [, key, value] = m;
    if (key === 'mode' && value) args.mode = value;
    else if (key === 'max-rows' && value) args.maxRows = Number(value) || 8;
    else if (key === 'cols' && value) args.cols = Number(value) || null;
  }
  return args;
}

function safeParse(text) {
  if (!text || !text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function readStdin(cb) {
  if (process.stdin.isTTY) return cb(null);
  let data = '';
  let done = false;
  const finish = (payload) => {
    if (done) return;
    done = true;
    cb(payload);
  };
  const timer = setTimeout(() => finish(safeParse(data)), STDIN_TIMEOUT_MS);
  timer.unref();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { data += chunk; });
  process.stdin.on('end', () => { clearTimeout(timer); finish(safeParse(data)); });
  process.stdin.on('error', () => { clearTimeout(timer); finish(null); });
}

function detectCols(args, stdin) {
  if (args.cols) return args.cols;
  const env = Number(process.env.HUDX_COLS);
  if (Number.isFinite(env) && env > 0) return env;
  if (stdin && Number.isFinite(stdin.terminal_width) && stdin.terminal_width > 0) {
    return stdin.terminal_width;
  }
  return process.stdout.columns || 80;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  readStdin((stdin) => {
    let out;
    try {
      const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
      const vm = buildViewModel({ cwd, stdin });
      const cols = detectCols(args, stdin);
      out = args.mode === 'full'
        ? renderFull(vm, { cols })
        : renderStatusline(vm, { cols, maxRows: args.maxRows });
    } catch (err) {
      // A statusline must never explode in the harness — render the failure.
      out = `[▂ ▂] hud-x render error: ${String(err && err.message).slice(0, 80)}`;
    }
    process.stdout.write(`${out}\n`, () => process.exit(0));
  });
}

if (require.main === module) main();

module.exports = {
  // §1 theme
  C, G, EYES, PAD, paint, colorEnabled, stripAnsi, visibleWidth, fit, gaugeColor, renderEyes,
  // §2 fmt
  fmtDuration, fmtCountdown, fmtAge, fmtTokens, fmtMoney, fmtPct,
  // §3 gather
  readJsonSafe, readFreshReactive, readFreshAnomaly, readUsageState, readSentinelState,
  readRigContext, readCapabilities, resolveUptime, appendHistorySample, readCompanionMessage,
  readMomentum, UPTIME_ANCHOR_MAX_AGE_MS,
  // §4 view-model
  buildViewModel, shortModel, contextTrend,
  // §5 arbiter
  arbitrate, collectCandidates, resolveEyes, IDLE_RESTING_MS, IDLE_ASLEEP_MS, MOMENTUM_WINDOW_MS,
  // §6 render
  renderStatusline, renderFull, breakpoint, frameWidth, gauge, sparkline,
  rowVoice, rowGauges, rowShip, rowIdentity,
  // §7 cli
  parseArgs, detectCols, safeParse, STDIN_TIMEOUT_MS,
};
