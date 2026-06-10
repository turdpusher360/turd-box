'use strict';
/**
 * message-composer.cjs — Composes observability messages from HUD state.
 *
 * Replaces static string pools with state-aware templates. Each event has
 * multiple template functions; templates that can't interpolate (missing
 * required state) return null and are skipped. Selection is deterministic
 * based on current tool count, giving variety that rotates with work.
 *
 * Pure module: no I/O, no side effects. Unit-testable.
 */

// ── Formatters ──

function fmtTokens(n) {
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return Math.round(n / 1_000) + 'k';
  return String(n);
}

function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h${String(mins % 60).padStart(2, '0')}m`;
}

function fmtPct(n) {
  if (!Number.isFinite(n)) return '';
  return `${Math.round(n)}%`;
}

function fmtCountdown(resetsAt) {
  if (resetsAt == null) return '';
  const t = typeof resetsAt === 'number' ? resetsAt * 1000 : new Date(resetsAt).getTime();
  if (!Number.isFinite(t)) return '';
  const ms = t - Date.now();
  if (ms <= 0) return '';
  const mins = Math.ceil(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h${String(mins % 60).padStart(2, '0')}m`;
}

// ── State Accessors (safe) ──

function getBranch(s) { return (s && s.git && s.git.branch) || ''; }
function getDirty(s)  { return (s && s.git && s.git.uncommittedFiles) || 0; }
function getCommits(s) {
  return (s && s.git && Array.isArray(s.git.recentCommits)) ? s.git.recentCommits.length : 0;
}
function getUptime(s)   { return (s && s.session && s.session.uptime) || 0; }
function getTools(s)    { return (s && s.session && s.session.toolCount) || 0; }
function getCtx(s)      { return (s && s.session && s.session.contextPct) || 0; }
function getModel(s) {
  const id = (s && s.session && s.session.modelId) || '';
  if (id.includes('opus')) return 'opus';
  if (id.includes('sonnet')) return 'sonnet';
  if (id.includes('haiku')) return 'haiku';
  return '';
}
function getForgePhase(s) { return (s && s.forge && s.forge.phase) || null; }
function getTeammates(s)  {
  const t = s && s.forge && s.forge.teammates;
  return Array.isArray(t) ? t.length : 0;
}
function getRl(s) { return (s && s.session && typeof s.session.rateLimits === 'object') ? s.session.rateLimits : null; }

// ── Intent / Arc / Anomaly Helpers ──

function getIntent(ctx) {
  return (ctx && ctx.intent && ctx.intent.intent) || null;
}
function getIntentConfidence(ctx) {
  return (ctx && ctx.intent && ctx.intent.confidence) || 0;
}
function getArcPhase(ctx) {
  return (ctx && ctx.arc && ctx.arc.phase) || null;
}
function getSignalAnomalyReason(ctx) {
  // Returns the first signal-severity anomaly reason string (or null).
  // Critical anomalies are handled via dedicated signalMessage escalation —
  // templates only reference signal-level for in-message callouts.
  if (!ctx || !ctx.anomalies || !Array.isArray(ctx.anomalies.anomalies)) return null;
  const sig = ctx.anomalies.anomalies.find(a => a.severity === 'signal');
  return sig ? sig.reason : null;
}

// ── Event Templates ──
// Each template receives (state, context) and returns string|null.
// null means "this template needs state I don't have" — skip and try next.
//
// Intent-aware templates (first in each list) fire when ctx.intent is strong.
// They add workflow mode to the message ("debugging: reread 3× + fix").

const TEMPLATES = {
  commit: [
    // Arc-aware: winding-down session puts commit in "wrapping up" frame
    (s, c) => {
      if (getArcPhase(c) !== 'winding-down') return null;
      const commits = getCommits(s);
      const u = getUptime(s);
      if (!u) return null;
      return `wrapping · ${commits + 1} commits · ${fmtDuration(u)}`;
    },
    // Intent-aware: differentiate shipping flow vs mid-work commits
    (s, c) => {
      const intent = getIntent(c);
      if (intent !== 'shipping' || getIntentConfidence(c) < 0.7) return null;
      const b = getBranch(s);
      return b ? `shipped → ${b}` : `shipped`;
    },
    (s, c) => {
      const intent = getIntent(c);
      if (intent !== 'debugging') return null;
      const b = getBranch(s);
      return b ? `fix committed · ${b}` : `fix committed`;
    },
    // Anomaly-aware: if signal-level anomaly is active (e.g., stale-dirty-work),
    // surface it alongside the commit acknowledgement.
    (s, c) => {
      const anomalyReason = getSignalAnomalyReason(c);
      if (!anomalyReason) return null;
      const b = getBranch(s);
      return b ? `committed → ${b} · ${anomalyReason}` : `committed · ${anomalyReason}`;
    },
    (s) => {
      const b = getBranch(s), t = getTools(s);
      if (!b || !t) return null;
      return `${b} +1 · ${t} tools`;
    },
    (s) => {
      const b = getBranch(s), d = getDirty(s);
      if (!b) return null;
      return d > 0 ? `committed · ${d} still dirty` : `clean commit on ${b}`;
    },
    (s) => {
      const u = getUptime(s), c = getCommits(s);
      if (!u) return null;
      return `${c + 1} shipped · ${fmtDuration(u)} in`;
    },
    (s) => `shipped → ${getBranch(s) || 'main'}`,
  ],

  'test-pass': [
    (s) => {
      const t = getTools(s), u = getUptime(s);
      if (!t || !u) return null;
      return `green · ${t} tools · ${fmtDuration(u)}`;
    },
    (s) => {
      const ctx = getCtx(s);
      if (!ctx) return null;
      return `tests clean · ${fmtPct(ctx)} ctx`;
    },
    () => `all green`,
  ],

  'test-fail': [
    // Intent-aware: if user is already debugging, acknowledge the loop
    (s, c) => {
      if (getIntent(c) !== 'debugging') return null;
      const reason = (c && c.intent && c.intent.reason) || '';
      return reason ? `still red · ${reason}`.slice(0, 60) : `still red`;
    },
    (s) => {
      const b = getBranch(s), d = getDirty(s);
      if (!b) return null;
      return `red · ${b}${d > 0 ? ` +${d}` : ''}`;
    },
    () => `tests failing — check output`,
  ],

  'forge-phase': [
    (s) => {
      const p = getForgePhase(s), n = getTeammates(s);
      if (!p) return null;
      return n > 0 ? `forge ${p} · ${n} teammates` : `forge phase ${p}`;
    },
    (s) => {
      const n = getTeammates(s);
      if (!n) return null;
      return `${n} teammates working`;
    },
    () => `forge moving`,
  ],

  'badge-earned': [
    (s, c) => {
      const name = c && c.badgeName;
      if (!name) return null;
      return `earned: ${name}`;
    },
    () => `badge unlocked`,
  ],

  'context-high': [
    (s) => {
      const ctx = getCtx(s), t = getTools(s);
      if (!ctx) return null;
      return t > 0 ? `ctx ${fmtPct(ctx)} · ${t} tools in` : `context ${fmtPct(ctx)}`;
    },
    () => `context running warm`,
  ],

  'rate-limit-warn': [
    (s) => {
      const rl = getRl(s);
      if (!rl || typeof rl.fiveHour !== 'number') return null;
      const cd = fmtCountdown(rl.fiveHourResetsAt);
      return cd ? `5h ${fmtPct(rl.fiveHour)} · ${cd} to reset` : `5h at ${fmtPct(rl.fiveHour)}`;
    },
    (s) => {
      const rl = getRl(s);
      if (!rl || typeof rl.sevenDay !== 'number') return null;
      return `7d at ${fmtPct(rl.sevenDay)}`;
    },
    () => `throttling soon`,
  ],

  'error-state': [
    (s, c) => {
      const tool = c && c.toolName;
      if (!tool) return null;
      return `${tool} errored`;
    },
    () => `error caught`,
  ],

  'session-end': [
    (s) => {
      const u = getUptime(s), c = getCommits(s), t = getTools(s);
      if (!u) return null;
      return `${fmtDuration(u)} · ${c} commits · ${t} tools`;
    },
    (s) => {
      const u = getUptime(s);
      if (!u) return null;
      return `session ${fmtDuration(u)}`;
    },
    () => `session ending`,
  ],

  export: [
    (s, c) => {
      const ft = c && c.fileType;
      if (!ft) return null;
      return `exported ${ft}`;
    },
    () => `export ready`,
  ],

  // zone-change intentionally omitted — too noisy to message on.
};

// ── Selection ──
// Templates are listed richest → sparsest; first non-null template wins.
// This means state-rich templates always take priority over fallbacks.
// For variety across similar calls, individual templates can branch on toolCount
// or other state fields internally (e.g., alternating phrases by parity).

function composeMessage(event, state, context) {
  const templates = TEMPLATES[event];
  if (!templates || templates.length === 0) return null;

  for (let i = 0; i < templates.length; i++) {
    try {
      const out = templates[i](state || {}, context || {});
      if (out && typeof out === 'string') return out.slice(0, 60);
    } catch { /* template threw — try next */ }
  }
  return null;
}

module.exports = {
  composeMessage,
  fmtTokens,
  fmtDuration,
  fmtPct,
  fmtCountdown,
  TEMPLATES,
};
