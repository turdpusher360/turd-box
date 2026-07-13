'use strict';

const { resolvePalette, getTheme } = require('./hud-palette.cjs');

// --- Defaults ---
const MAX_BASH_COLS = 79;
const DEFAULT_TERMINAL = { cols: Math.min(process.stdout.columns || 79, MAX_BASH_COLS), rows: process.stdout.rows || 24 };
const DEFAULT_SESSION = {
  id: '',
  model: 'unknown',
  contextPct: 0,
  rateLimits: { fiveHour: 0, sevenDay: 0 },
  uptime: 0,
  toolCount: 0,
  contextLabel: '',
  contextPctHistory: [],
  rateLimitHistory: [],
  branch: '',
  worktreePath: '',
  workspace: '',
  harnessVersion: '',
  outputStyle: '',
  vimMode: false,
  durationMs: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  modelId: '',
  modelProvider: '',
  remainingTokens: 0,
  cost: 0,
};
const DEFAULT_OS = { overallHealth: 'unknown', bootTime: 0, capabilities: {}, vram: null, processes: null };
const DEFAULT_FORGE = { active: false, phase: null, teammates: [], scope: null };
const DEFAULT_CONTEXT = { trigger: 'unknown', event: null, zone: null, agentId: '', agentType: '', agentName: '' };
const DEFAULT_REACTIVE = null;
const DEFAULT_ANOMALY = null;
const DEFAULT_RIG_CONTEXT = null;

// --- Clamp ---
function clamp(val, min, max) {
  if (typeof val !== 'number' || isNaN(val)) return min;
  return Math.min(max, Math.max(min, val));
}

function clampPercentValue(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return clamp(n, 0, 100);
}

function coercePercentHistory(values) {
  if (!Array.isArray(values)) return [];
  return values
    .map(clampPercentValue)
    .filter((value) => value !== null);
}

function coerceRateLimitHistory(values) {
  if (!Array.isArray(values)) return [];
  return values
    .map((sample) => {
      if (!sample || typeof sample !== 'object') return null;
      const fiveHour = clampPercentValue(sample.fiveHour);
      const sevenDay = clampPercentValue(sample.sevenDay);
      if (fiveHour === null && sevenDay === null) return null;
      return {
        ts: typeof sample.ts === 'string' ? sample.ts : '',
        fiveHour: fiveHour === null ? 0 : fiveHour,
        sevenDay: sevenDay === null ? 0 : sevenDay,
      };
    })
    .filter(Boolean);
}

function normalizeAnomalyState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return DEFAULT_ANOMALY;
  const type = typeof raw.type === 'string' ? raw.type.trim() : '';
  const reason = typeof raw.reason === 'string' ? raw.reason.replace(/\s+/g, ' ').trim() : '';
  if (!type || !reason) return DEFAULT_ANOMALY;
  const severity = raw.severity === 'critical' || raw.severity === 'flash'
    ? raw.severity
    : 'signal';
  return {
    type,
    severity,
    reason,
    metrics: (raw.metrics && typeof raw.metrics === 'object' && !Array.isArray(raw.metrics)) ? raw.metrics : {},
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
  };
}

function nonNegativeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function normalizeVramState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const freeMiB = nonNegativeNumber(raw.freeMiB);
  if (freeMiB === null) return null;
  const totalMiB = nonNegativeNumber(raw.totalMiB);
  const out = {
    freeMiB: Math.round(freeMiB),
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
  };
  if (totalMiB !== null) out.totalMiB = Math.round(totalMiB);
  return out;
}

function normalizeProcessState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const totalProcs = nonNegativeNumber(raw.totalProcs);
  if (totalProcs === null) return null;
  const mcpProcs = nonNegativeNumber(raw.mcpProcs);
  const killed = nonNegativeNumber(raw.killed);
  return {
    event: typeof raw.event === 'string' ? raw.event : '',
    sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : '',
    totalProcs: Math.round(totalProcs),
    mcpProcs: mcpProcs === null ? 0 : Math.round(mcpProcs),
    killed: killed === null ? 0 : Math.round(killed),
    kills: Array.isArray(raw.kills) ? raw.kills : [],
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
  };
}

function normalizeRigContextState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return DEFAULT_RIG_CONTEXT;
  const status = ['ok', 'warn', 'unknown', 'error'].includes(raw.status) ? raw.status : 'unknown';
  const issueCount = nonNegativeNumber(raw.issueCount);
  const issues = Array.isArray(raw.issues)
    ? raw.issues
        .map((issue) => {
          if (!issue || typeof issue !== 'object') return null;
          const issueStatus = ['ok', 'warn', 'unknown', 'error'].includes(issue.status) ? issue.status : 'unknown';
          return {
            name: typeof issue.name === 'string' ? issue.name : '',
            status: issueStatus,
            summary: typeof issue.summary === 'string' ? issue.summary : '',
          };
        })
        .filter(Boolean)
    : [];
  return {
    path: typeof raw.path === 'string' ? raw.path : '',
    status,
    issueCount: issueCount === null ? issues.length : Math.round(issueCount),
    headline: typeof raw.headline === 'string' ? raw.headline : '',
    generatedAt: typeof raw.generatedAt === 'string' ? raw.generatedAt : '',
    ageMinutes: nonNegativeNumber(raw.ageMinutes),
    isStale: raw.isStale === true,
    sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : '',
    issues,
  };
}

// --- Count degraded capabilities ---
// Capabilities with shelved:true are intentionally degraded (e.g. AISLE
// fail-closed is the documented shelved posture per ADR-SEC-001), so we
// don't count them as actionable degradation in the HUD.
function countDegraded(caps) {
  if (!caps || typeof caps !== 'object') return 0;
  let count = 0;
  for (const c of Object.values(caps)) {
    if (c && c.ok === false && c.shelved !== true) count++;
  }
  return count;
}

// --- Build canonical state from raw input ---
function buildCanonicalState(raw) {
  const r = (raw && typeof raw === 'object') ? raw : {};

  const terminal = {
    cols: Math.min((r.terminal && typeof r.terminal.cols === 'number' && r.terminal.cols > 0) ? r.terminal.cols : DEFAULT_TERMINAL.cols, MAX_BASH_COLS),
    rows: (r.terminal && typeof r.terminal.rows === 'number' && r.terminal.rows > 0) ? r.terminal.rows : DEFAULT_TERMINAL.rows,
  };

  const rawSession = r.session || {};
  const rawRate = rawSession.rateLimits;
  const rateLimits = (rawRate === 'N/A')
    ? 'N/A'
    : {
        fiveHour: clamp((rawRate && rawRate.fiveHour) || 0, 0, 100),
        sevenDay: clamp((rawRate && rawRate.sevenDay) || 0, 0, 100),
        fiveHourResetsAt: (rawRate && rawRate.fiveHourResetsAt != null) ? rawRate.fiveHourResetsAt : null,
        sevenDayResetsAt: (rawRate && rawRate.sevenDayResetsAt != null) ? rawRate.sevenDayResetsAt : null,
      };
  const session = {
    id: rawSession.id || DEFAULT_SESSION.id,
    model: rawSession.model || DEFAULT_SESSION.model,
    contextPct: clamp(rawSession.contextPct, 0, 100),
    rateLimits,
    uptime: (typeof rawSession.uptime === 'number' && rawSession.uptime >= 0) ? rawSession.uptime : 0,
    toolCount: (typeof rawSession.toolCount === 'number' && rawSession.toolCount >= 0) ? rawSession.toolCount : 0,
    contextLabel: typeof rawSession.contextLabel === 'string' ? rawSession.contextLabel : '',
    contextPctHistory: coercePercentHistory(rawSession.contextPctHistory),
    rateLimitHistory: coerceRateLimitHistory(rawSession.rateLimitHistory),
    branch: typeof rawSession.branch === 'string' ? rawSession.branch : '',
    worktreePath: typeof rawSession.worktreePath === 'string' ? rawSession.worktreePath : '',
    workspace: typeof rawSession.workspace === 'string' ? rawSession.workspace : '',
    harnessVersion: typeof rawSession.harnessVersion === 'string' ? rawSession.harnessVersion : '',
    outputStyle: typeof rawSession.outputStyle === 'string' ? rawSession.outputStyle : '',
    vimMode: typeof rawSession.vimMode === 'boolean' ? rawSession.vimMode : false,
    durationMs: typeof rawSession.durationMs === 'number' ? rawSession.durationMs : 0,
    inputTokens: typeof rawSession.inputTokens === 'number' ? rawSession.inputTokens : 0,
    outputTokens: typeof rawSession.outputTokens === 'number' ? rawSession.outputTokens : 0,
    cacheReadTokens: typeof rawSession.cacheReadTokens === 'number' ? rawSession.cacheReadTokens : 0,
    cacheCreationTokens: typeof rawSession.cacheCreationTokens === 'number' ? rawSession.cacheCreationTokens : 0,
    modelId: typeof rawSession.modelId === 'string' ? rawSession.modelId : '',
    modelProvider: typeof rawSession.modelProvider === 'string' ? rawSession.modelProvider : '',
    remainingTokens: typeof rawSession.remainingTokens === 'number' ? rawSession.remainingTokens : 0,
    cost: typeof rawSession.cost === 'number' ? rawSession.cost : 0,
    linesAdded: typeof rawSession.linesAdded === 'number' ? rawSession.linesAdded : 0,
    linesRemoved: typeof rawSession.linesRemoved === 'number' ? rawSession.linesRemoved : 0,
  };

  const rawOs = r.os || {};
  const os = {
    overallHealth: rawOs.overallHealth || DEFAULT_OS.overallHealth,
    bootTime: (typeof rawOs.bootTime === 'number') ? rawOs.bootTime : 0,
    capabilities: (rawOs.capabilities && typeof rawOs.capabilities === 'object') ? rawOs.capabilities : {},
    vram: normalizeVramState(rawOs.vram),
    processes: normalizeProcessState(rawOs.processes),
  };

  const rawForge = r.forge || {};
  const forge = {
    active: !!rawForge.active,
    phase: rawForge.phase || null,
    teammates: Array.isArray(rawForge.teammates) ? rawForge.teammates : [],
    scope: rawForge.scope || null,
  };

  const rawContext = r.context || {};
  const context = {
    trigger: rawContext.trigger || DEFAULT_CONTEXT.trigger,
    event: rawContext.event || null,
    zone: rawContext.zone || null,
    agentId: typeof rawContext.agentId === 'string' ? rawContext.agentId : '',
    agentType: typeof rawContext.agentType === 'string' ? rawContext.agentType : '',
    agentName: typeof rawContext.agentName === 'string' ? rawContext.agentName : '',
  };

  // Badges — passthrough with defaults
  const rawBadges = r.badges || {};
  const badges = {
    earned: (rawBadges.earned && typeof rawBadges.earned === 'object') ? rawBadges.earned : {},
    newThisSession: Array.isArray(rawBadges.newThisSession) ? rawBadges.newThisSession : [],
  };

  // Memory / session history — passthrough with defaults
  const rawMemory = r.memory || {};
  const memory = {
    lastSession: rawMemory.lastSession || null,
    parked: rawMemory.parked || null,
    next: rawMemory.next || null,
  };

  const themeConfig = r.theme || { name: getTheme() };
  const mode = ['strip', 'full', 'zone', 'compact'].includes(r.mode) ? r.mode : 'full';
  const palette = resolvePalette(themeConfig);

  const transcript = r.transcript || null;

  // Forge progress — passthrough (validated by zone renderer)
  const forgeProgress = r.forgeProgress || null;

  // Git state — passthrough (validated by zone renderer)
  const git = r.git || null;

  const rawReactive = r.reactive || null;
  const reactive = (rawReactive && typeof rawReactive === 'object' && typeof rawReactive.event === 'string' && rawReactive.event)
    ? {
        event: rawReactive.event,
        triggeredAt: typeof rawReactive.triggeredAt === 'string' ? rawReactive.triggeredAt : '',
        ageMs: typeof rawReactive.ageMs === 'number' ? rawReactive.ageMs : 0,
      }
    : DEFAULT_REACTIVE;

  const anomaly = normalizeAnomalyState(r.anomaly);
  const rigContext = normalizeRigContextState(r.rigContext);

  // Board — passthrough (validated + freshness-filtered by hud-board-store on load).
  const board = (r.board && typeof r.board === 'object') ? r.board : null;

  return { terminal, session, os, forge, context, badges, memory, transcript, forgeProgress, git, reactive, anomaly, rigContext, board, theme: themeConfig, mode, palette };
}

module.exports = {
  buildCanonicalState,
  countDegraded,
  clamp,
  clampPercentValue,
  coercePercentHistory,
  coerceRateLimitHistory,
  normalizeAnomalyState,
  normalizeVramState,
  normalizeProcessState,
  normalizeRigContextState,
  MAX_BASH_COLS,
  DEFAULT_TERMINAL,
  DEFAULT_SESSION,
  DEFAULT_OS,
  DEFAULT_FORGE,
  DEFAULT_CONTEXT,
  DEFAULT_REACTIVE,
  DEFAULT_ANOMALY,
  DEFAULT_RIG_CONTEXT,
};
