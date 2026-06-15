#!/usr/bin/env node
'use strict';

const { colorize, stripAnsi } = require('./hud-palette.cjs');
const { buildCanonicalState, countDegraded } = require('./hud-state.cjs');
const { createCanvas, paintRows, allocateVerticalZones, render } = require('./hud-canvas.cjs');
const { renderFaceZone, ZONE_META: FACE_META } = require('./hud-zone-face.cjs');
const { renderHealthZone, ZONE_META: HEALTH_META, computeHealthScore } = require('./hud-zone-health.cjs');
const { renderColoredOrb } = require('./hud-braille-orb.cjs');
const path = require('node:path');
const { isActive: isSessionActive, getFreezeTime } = require('../lib/hud-active-flag.cjs');
const { renderContextZone, renderContextCompact, ZONE_META: CONTEXT_META } = require('./hud-zone-context.cjs');
const { renderForgeZone, ZONE_META: FORGE_META } = require('./hud-zone-forge.cjs');
const { renderCapsZone, ZONE_META: CAPS_META } = require('./hud-zone-caps.cjs');
const { renderBadgesZone, ZONE_META: BADGES_META } = require('./hud-zone-badges.cjs');
const { renderSessionZone, ZONE_META: SESSION_META } = require('./hud-zone-session.cjs');
const { renderCommandCards, ZONE_META: CARDS_META } = require('./hud-zone-cards.cjs');
const { renderRateLimitZone, renderRateLimitCompact, RATE_META, rateVisible } = require('./hud-zone-rate-limit.cjs');
const { renderActivityZone, ZONE_META: ACTIVITY_META, activityVisible } = require('./hud-zone-activity.cjs');
const { renderForgeProgressZone, ZONE_META: FORGE_PROGRESS_META, forgeProgressVisible } = require('./hud-zone-forge-progress.cjs');
const { renderGitStatusZone, ZONE_META: GIT_STATUS_META, gitStatusVisible } = require('./hud-zone-git-status.cjs');
const { renderMoonphaseZone, ZONE_META: MOONPHASE_META, moonphaseVisible } = require('./hud-zone-moonphase.cjs');
const { renderWeasleyZone, ZONE_META: WEASLEY_META, weasleyVisible } = require('./hud-zone-weasley.cjs');
const { loadHudData, mergeHarnessStdin } = require('./hud-data-loader.cjs');
const { renderSubstrateZone } = require('./hud-zone-substrate.cjs');
const { composeScene } = require('./scene-compositor.cjs');
const {
  statuslineZoneMap,
  statuslineRoleMap,
  zoneBoostMap,
  compactCompanionHintMap,
  compactMessageMap,
} = require('../lib/hud-events.cjs');

function firstNonEmptyPath(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

function resolveProjectRoot({
  envProjectDir = process.env.CLAUDE_PROJECT_DIR,
  workspaceProjectDir = '',
  stdinCwd = '',
  fallbackRoot = process.cwd(),
} = {}) {
  return firstNonEmptyPath(envProjectDir, workspaceProjectDir, stdinCwd, fallbackRoot, process.cwd());
}

const ZONE_CATALOG = [
  { key: 'face', meta: FACE_META, render: renderFaceZone },
  { key: 'context', meta: CONTEXT_META, render: renderContextZone, compact: renderContextCompact },
  {
    key: 'health',
    meta: HEALTH_META,
    render: renderHealthZone,
    renderZone: (state, palette) => renderHealthZone(state, palette, { detailed: true }),
  },
  { key: 'caps', aliases: ['capabilities'], meta: CAPS_META, render: renderCapsZone, composite: false },
  { key: 'forge', meta: FORGE_META, render: renderForgeZone, visible: (state) => !!(state.forge && state.forge.active) },
  { key: 'badges', meta: BADGES_META, render: renderBadgesZone, composite: false },
  {
    key: 'cards',
    meta: CARDS_META,
    render: (state) => renderCommandCards(state, (state.terminal && state.terminal.cols) || 80),
    composite: false,
  },
  { key: 'session', meta: SESSION_META, render: renderSessionZone, composite: false },
  { key: 'rate', meta: RATE_META, render: renderRateLimitZone, compact: renderRateLimitCompact, visible: rateVisible },
  { key: 'activity', meta: ACTIVITY_META, render: renderActivityZone, visible: activityVisible, composite: false },
  {
    key: 'forgeProgress',
    aliases: ['forge-progress'],
    meta: FORGE_PROGRESS_META,
    render: renderForgeProgressZone,
    visible: forgeProgressVisible,
    composite: false,
  },
  { key: 'gitStatus', aliases: ['git-status', 'git'], meta: GIT_STATUS_META, render: renderGitStatusZone, visible: gitStatusVisible },
  { key: 'moonphase', meta: MOONPHASE_META, render: renderMoonphaseZone, visible: moonphaseVisible },
  { key: 'weasley', meta: WEASLEY_META, render: renderWeasleyZone, visible: weasleyVisible },
];

const REACTIVE_STATUSLINE_ZONES = statuslineZoneMap();
const REACTIVE_STATUSLINE_ROLE = statuslineRoleMap();
const REACTIVE_ZONE_BOOST = zoneBoostMap();
const COMPACT_EVENT_MESSAGES = compactMessageMap();

function getZoneEntry(zoneName) {
  const wanted = zoneName || 'face';
  return ZONE_CATALOG.find((entry) => (
    entry.key === wanted ||
    (Array.isArray(entry.aliases) && entry.aliases.includes(wanted))
  )) || ZONE_CATALOG[0];
}

function getCompositeZoneEntries(state) {
  return ZONE_CATALOG.filter((entry) => (
    entry.composite !== false && (!entry.visible || entry.visible(state))
  ));
}

function renderCatalogEntry(entry, state, palette, options = {}) {
  if (options.zoneMode && typeof entry.renderZone === 'function') {
    return entry.renderZone(state, palette);
  }
  return entry.render(state, palette);
}

function getReactiveStatuslineZoneEntries(state) {
  const reactive = state && state.reactive;
  if (!reactive || !reactive.event) return [];
  const zoneKeys = REACTIVE_STATUSLINE_ZONES[reactive.event] || ['context'];
  const seen = new Set();
  const entries = [];
  for (const zoneKey of zoneKeys) {
    const entry = getZoneEntry(zoneKey);
    if (!entry || seen.has(entry.key)) continue;
    seen.add(entry.key);
    if (entry.visible && !entry.visible(state)) continue;
    entries.push(entry);
  }
  return entries;
}

function formatReactiveAge(ageMs) {
  const age = Math.max(0, Number(ageMs) || 0);
  if (age < 1000) return 'now';
  const seconds = Math.floor(age / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m`;
}

// Feed rows (anomaly / reactive / compact) align under the header BODY text,
// which sits past the creature sprite gutter (face + orb). The statusline
// assembler passes the live gutter width (prefixWidth); standalone / test
// callers default to a 2-space indent. Single source of truth for feed-row
// left-alignment — keeps the ctx-trend row lined up with the header text feed.
const DEFAULT_FEED_GUTTER = '  ';
function reindentFeedRow(line, gutter) {
  return (gutter || DEFAULT_FEED_GUTTER) + String(line).replace(/^\s+/, '');
}

function renderReactiveStatuslineRows(state, palette, maxRows, gutter = DEFAULT_FEED_GUTTER) {
  if (!state || !state.reactive || !state.reactive.event || maxRows <= 0) return [];
  const event = state.reactive.event;
  const role = REACTIVE_STATUSLINE_ROLE[event] || 'accent';
  const rows = [
    gutter +
      colorize(palette, 'muted', 'reactive ') +
      colorize(palette, role, event) +
      colorize(palette, 'muted', ` ${formatReactiveAge(state.reactive.ageMs)} ago`),
  ];

  for (const entry of getReactiveStatuslineZoneEntries(state)) {
    if (rows.length >= maxRows) break;
    let lines = [];
    try {
      lines = renderCatalogEntry(entry, state, palette, { zoneMode: true });
    } catch {
      lines = [];
    }
    for (const line of lines) {
      if (rows.length >= maxRows) break;
      if (!stripAnsi(line).trim()) continue;
      rows.push(reindentFeedRow(line, gutter));
    }
  }

  return rows.slice(0, maxRows);
}

function clipStatusText(value, max = 96) {
  if (typeof value !== 'string') return '';
  const text = value.replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return text.slice(0, max - 3).trimEnd() + '...';
}

function renderAnomalyStatuslineRows(state, palette, maxRows, gutter = DEFAULT_FEED_GUTTER) {
  if (maxRows <= 0) return [];
  const anomaly = state && state.anomaly;
  if (!anomaly || !anomaly.type || !anomaly.reason) return [];
  const severity = anomaly.severity === 'critical' || anomaly.severity === 'flash'
    ? anomaly.severity
    : 'signal';
  const role = severity === 'critical' ? 'error' : severity === 'flash' ? 'muted' : 'warn';
  const type = clipStatusText(anomaly.type, 48);
  const reason = clipStatusText(anomaly.reason, 96);
  return [
    gutter +
      colorize(palette, 'muted', 'anomaly ') +
      colorize(palette, role, severity) +
      colorize(palette, 'muted', ' ') +
      colorize(palette, role, type) +
      colorize(palette, 'muted', ': ') +
      colorize(palette, 'text', reason),
  ].slice(0, maxRows);
}

function renderCompactStatuslineRows(state, palette, maxRows, gutter = DEFAULT_FEED_GUTTER) {
  if (maxRows <= 0) return [];
  const rows = [];
  for (const entry of ZONE_CATALOG) {
    if (rows.length >= maxRows) break;
    if (typeof entry.compact !== 'function') continue;
    if (entry.visible && !entry.visible(state)) continue;
    let lines = [];
    try {
      lines = entry.compact(state, palette);
    } catch {
      lines = [];
    }
    if (!Array.isArray(lines)) continue;
    for (const line of lines) {
      if (rows.length >= maxRows) break;
      if (typeof line !== 'string' || !stripAnsi(line).trim()) continue;
      rows.push(reindentFeedRow(line, gutter));
    }
  }
  return rows;
}

// Breathing block: single character that cycles height based on health + time.
// Healthy = slow deep breaths (full range). Degraded = fast shallow. Critical = flatline.
const BREATH_FRAMES = ['\u2581', '\u2582', '\u2583', '\u2584', '\u2585', '\u2586', '\u2587', '\u2588', '\u2587', '\u2586', '\u2585', '\u2584', '\u2583', '\u2582'];
function breathingBlock(healthPct) {
  if (healthPct < 10) return '\u2581'; // flatline
  // Cycle period: healthy=3s, degraded=1.5s, critical=0.8s
  const period = healthPct >= 75 ? 3000 : healthPct >= 35 ? 1500 : 800;
  // Amplitude: healthy=full range, degraded=half, critical=bottom quarter
  const maxIdx = healthPct >= 75 ? BREATH_FRAMES.length - 1
               : healthPct >= 35 ? 9
               : 5;
  const t = (Date.now() % period) / period;
  const idx = Math.round(t * maxIdx);
  return BREATH_FRAMES[Math.min(idx, BREATH_FRAMES.length - 1)];
}

// --- Full Mode Renderer ---
// Creates a filled canvas, allocates zones, paints face + health, outputs ANSI.
function renderFull(rawState) {
  const state = buildCanonicalState(rawState);
  const palette = state.palette;
  const cols = state.terminal.cols;
  const rows = state.terminal.rows;

  // Define active composite zones — allocator sorts by priority, drops low-priority when space is tight
  // S396 companion-led restraint: the full HUD is a clean glance — companion eyes +
  // a tight data ledger, not a 30-row carnival.
  // DROPPED from the COMPOSITE (still reachable on demand via `/4ge os <zone>`):
  //   caps grid/histogram, badge grid, command-card sprites (the banned yellow
  //   block-face), session history, and the activity zone (which leaked the render
  //   command into the boot HUD).
  // KEPT but self-hiding (visibility-gated alerts/status): forge, git, rate,
  // moonphase, and weasley. Non-composite zones stay callable through renderZone.
  const activeRenderers = getCompositeZoneEntries(state);
  const zones = activeRenderers.map(z => ({ ...z.meta, key: z.key }));

  // Context-aware zone priority boosting.
  // Adjust priority values based on the current event without mutating ZONE_META constants.
  const event = (state.context && state.context.event) || '';
  if (event) {
    const boost = REACTIVE_ZONE_BOOST[event];
    if (boost) {
      for (const zone of zones) {
        if (boost[zone.key] !== undefined) {
          zone.priority = boost[zone.key];
        }
      }
    }
  }

  // Allocate vertical space — determines which zones to drop
  const maxCanvasRows = Math.min(rows - 2, 30);
  const allocation = allocateVerticalZones(zones, maxCanvasRows);

  // Render all non-dropped zones, trim trailing blanks, pack tightly
  const renderedZones = [];
  for (const zr of activeRenderers) {
    const alloc = allocation.find(a => a.key === zr.key);
    if (alloc && !alloc.dropped) {
      const lines = zr.render(state, palette);
      while (lines.length > 0 && stripAnsi(lines[lines.length - 1]).trim() === '') {
        lines.pop();
      }
      if (lines.length > 0) {
        renderedZones.push({ key: zr.key, lines });
      }
    }
  }

  // Packed canvas: sum of actual content + 1 trailing bg row
  const totalRows = renderedZones.reduce((sum, z) => sum + z.lines.length, 0) + 1;
  const canvas = createCanvas(totalRows, cols, palette);

  let cursor = 0;
  for (const z of renderedZones) {
    if (cursor >= totalRows) break;
    paintRows(canvas, cursor, z.lines, palette);
    cursor += z.lines.length;
  }

  return render(canvas);
}

// --- Strip Mode Renderer ---
// Single-line output for StatusLine slot.
// Format: face + context% + health grade + forge state
// Face is driven by companion-state.cjs expression state machine (DIS-ARC-005).
// When healthy, a model-specific face is shown (W5 T5.1); when degraded, expression system takes over.

const MODEL_FACE = {
  'claude-opus-4-8':     { expr: 'determined', color: 'accent' },  // S398: explicit entry
  'claude-opus-4-7':     { expr: 'determined', color: 'accent' },  // S332: explicit entry
  'claude-opus-4-6':     { expr: 'determined', color: 'accent' },
  'claude-opus-4-6[1m]': { expr: 'determined', color: 'accent' },
  'claude-sonnet-4-6':   { expr: 'thinking',    color: 'accent' },
  'claude-haiku-4-5':    { expr: 'sleepy',     color: 'muted' },
};

// Prefix-match fallback so model ID version bumps still resolve
function resolveModelFace(modelId) {
  if (!modelId) return null;
  // Exact match first
  if (MODEL_FACE[modelId]) return MODEL_FACE[modelId];
  // Prefix match
  if (modelId.startsWith('claude-opus'))   return MODEL_FACE['claude-opus-4-6'];
  if (modelId.startsWith('claude-sonnet')) return MODEL_FACE['claude-sonnet-4-6'];
  if (modelId.startsWith('claude-haiku'))  return MODEL_FACE['claude-haiku-4-5'];
  return null;
}

const COMPACT_FACES = {
  neutral:        '[\u2585 \u2585]',  // ▅ ▅ — default open eyes
  'neutral alive': '[\u2585 \u2584]', // ▅ ▄ — slight asymmetry = alive
  happy:          '[\u02C7 \u02C7]',  // ˇ ˇ — cheek push (bottom-only)
  sad:            '[\u0327 \u0327]',  // eyes with soft droop
  angry:          '[\u2571 \u2572]',  // ╱ ╲ — inward furrowed
  surprised:      '[O O]',            // wide open
  fear:           '[O O]',            // wide open (same shape, different context)
  worried:        '[\u2571 \u2585]',  // ╱ ▅ — asymmetric
  curious:        '[\u2585 \u25E0]',  // ▅ ◠ — one narrowed
  thinking:       '[\u25E0 \u2585]',  // ◠ ▅ — other narrowed
  suspicious:     '[\u2571 \u2585]',  // ╱ ▅ — one squinted
  determined:     '[\u2501 \u2501]',  // ━ ━ — focused
  anxious:        '[\u2585 \u2571]',  // ▅ ╱ — unsettled
  alert:          '[\u25CF \u25CF]',  // ● ● — wide and attentive
  excited:        '[\u2605 \u2605]',  // ★ ★ — lit up
  'proud joy':    '[\u2588 \u2586]',  // █ ▆ — full open, sharper asymmetry
  sleepy:         '[\u2500 \u2500]',  // ─ ─ — drooping
  exhausted:      '[\u2583 \u2582]',  // ▃ ▂ — both eyes fighting to stay open, asymmetric dreamy
  blink:          '[\u2500 \u2500]',  // ─ ─ — closed
  dead:           '[x x]',            // closed slits
  wink:           '[\u2585 \u2500]',  // ▅ ─ — one open one closed
  intrigued:      '[\u2585 \u25E0]',  // same as curious
  patient:        '[\u25E0 \u25E0]',  // ◠ ◠ — relaxed half-lids
  guilt:          '[\u2571 \u2584]',  // ╱ ▄ — averted
  'nodding off':  '[\u2504 \u2500]',  // ┄ ─ — asymmetric drowsy
};

const COMPACT_FACE_ALIASES = {
  focused: 'determined',
  winking: 'wink',
  blinking: 'blink',
};

const COMPACT_COMPANION_EVENT_HINTS = compactCompanionHintMap();

function compactFaceForExpression(expression) {
  const key = COMPACT_FACES[expression]
    ? expression
    : (COMPACT_FACE_ALIASES[expression] || expression);
  return COMPACT_FACES[key] || COMPACT_FACES.neutral;
}

function resolveCompactExpressionName(rawState, state) {
  const event = (state.context && state.context.event) || '';
  const eventHint = COMPACT_COMPANION_EVENT_HINTS[event] || null;
  if (eventHint) {
    try {
      const companion = require('./companion-state.cjs');
      return companion.resolveExpression(rawState || state, eventHint).expression;
    } catch { /* fall through to legacy compact rules */ }
  }

  try {
    const { getExpressionName } = require('./hud-expressions.cjs');
    return getExpressionName(state);
  } catch {
    return 'neutral alive';
  }
}

// Gradient face: left eye purple (57), right eye blue (39)
const FACE_LEFT = '\x1b[38;5;63m';   // muted indigo (brackets + small eye)
const FACE_RIGHT = '\x1b[38;5;39m';  // sky blue (brackets + big eye)
const FACE_RESET = '\x1b[0m';

function renderGradientFace(leftGlyph, rightGlyph) {
  // Big eye (left) = blue, small eye (right) = purple
  // Brackets cross: [ = purple (on blue side), ] = blue (on purple side)
  return FACE_LEFT + '[' + FACE_RIGHT + leftGlyph + FACE_RESET + ' ' + FACE_LEFT + rightGlyph + FACE_RIGHT + ']' + FACE_RESET;
}

function applyGazeToGlyphs(expression, leftGlyph, rightGlyph, gaze) {
  if (gaze !== 'left' && gaze !== 'right') return [leftGlyph, rightGlyph];
  if (expression === 'thinking' || expression === 'exhausted') return [leftGlyph, rightGlyph];

  const gazeMap = gaze === 'left'
    ? {
        left: { '\u2588': '\u258C', '\u2586': '\u2586', '\u2585': '\u258C', '\u2584': '\u2582', '\u25CF': '\u25D0' },
        right: { '\u2588': '\u2588', '\u2586': '\u2586', '\u2585': '\u2585', '\u2584': '\u2582', '\u25CF': '\u25D0' },
      }
    : {
        left: { '\u2588': '\u2588', '\u2586': '\u2586', '\u2585': '\u2585', '\u2584': '\u2582', '\u25CF': '\u25D1' },
        right: { '\u2588': '\u2590', '\u2586': '\u2590', '\u2585': '\u2590', '\u2584': '\u2582', '\u25CF': '\u25D1' },
      };

  return [
    (gazeMap.left && gazeMap.left[leftGlyph]) || leftGlyph,
    (gazeMap.right && gazeMap.right[rightGlyph]) || rightGlyph,
  ];
}

function resolveCompanionFace(rawState, palette, modelFace, options = {}) {
  try {
    const companion = require('./companion-state.cjs');
    const stdinJson = rawState || {};

    // Read companion config once: animate (master freeze) + faceMotion (eye-swap).
    let animate = true;
    let faceMotion = false;
    try {
      const cc = require('./companion-config.cjs').loadCompanionConfig();
      animate = cc.animate !== false;
      faceMotion = (cc.faceMotion === true && cc.zen !== true);
    } catch { animate = true; faceMotion = false; }

    // animate gate (S441 mobile freeze): when animate is OFF the face must be
    // byte-identical across renders. resolveExpression() evolves on wall-clock
    // dwell/decay timers — it oscillates between expressions (e.g. idle↔context-warn)
    // on identical input and applies gaze drift. That was the residual mobile
    // scroll-bounce source after the orb color-wave + breath/shimmer were frozen.
    // Render a STATIC model-identity face and skip the time-evolving state machine.
    if (!animate) {
      const face = (modelFace && COMPACT_FACES[modelFace.expr]) || COMPACT_FACES.neutral;
      const glyphs = face.match(/^\[(.+) (.+)\]$/);
      if (glyphs) return renderGradientFace(glyphs[1], glyphs[2]);
      return colorize(palette, (modelFace && modelFace.color) || 'accent', face);
    }

    const resolved = companion.resolveExpression(stdinJson);

    // faceMotion gate (Wave 1): the per-tool eye SWAP for thinking/exhausted is
    // the e4d905d2 regression. It is OFF by default — calm steady eyes. The swap
    // only runs when the operator opts in (companion.faceMotion === true) AND zen
    // is not engaged. When OFF we restore the PRE-e4d905d2 STEADY behavior:
    //   thinking  → a stable model-specific face (or COMPACT_FACES.thinking)
    //   exhausted → steady base glyph (falls through to compactFaceForExpression)

    if (faceMotion) {
      // When actively thinking (tool-running), eyes swap on each tool call — not a clock.
      if (resolved.expression === 'thinking') {
        const tc = (resolved.toolCount || resolved.lastToolAt || 0);
        const even = tc % 2 === 0;
        const leftGlyph = even ? '\u2585' : '\u2583';   // ▅ or ▃
        const rightGlyph = even ? '\u2583' : '\u2585';   // ▃ or ▅
        return renderGradientFace(leftGlyph, rightGlyph);
      }

      // Exhausted: eyes drift on each action. Too tired to hold a face.
      if (resolved.expression === 'exhausted') {
        const tc = (resolved.toolCount || resolved.lastToolAt || 0);
        const even = tc % 2 === 0;
        const leftGlyph = even ? '\u2583' : '\u2582';   // ▃ or ▂
        const rightGlyph = even ? '\u2582' : '\u2583';   // ▂ or ▃
        return renderGradientFace(leftGlyph, rightGlyph);
      }
    } else if (resolved.expression === 'thinking') {
      // STEADY thinking face (pre-e4d905d2): stable model-specific eyes, no swap.
      const face = (modelFace && COMPACT_FACES[modelFace.expr]) || COMPACT_FACES.thinking;
      const glyphs = face.match(/^\[(.+) (.+)\]$/);
      if (glyphs) return renderGradientFace(glyphs[1], glyphs[2]);
      return colorize(palette, (modelFace && modelFace.color) || 'accent', face);
    }
    // exhausted (faceMotion off) intentionally falls through to the generic
    // compactFaceForExpression path below → steady COMPACT_FACES.exhausted.

    const face = compactFaceForExpression(resolved.expression);
    const glyphs = face.match(/^\[(.+) (.+)\]$/);
    if (glyphs) {
      const [leftGlyph, rightGlyph] = options.projectGaze === true
        ? applyGazeToGlyphs(
            resolved.expression,
            glyphs[1],
            glyphs[2],
            resolved.gaze,
          )
        : [glyphs[1], glyphs[2]];
      return renderGradientFace(leftGlyph, rightGlyph);
    }
    return colorize(palette, 'accent', face);
  } catch {
    // Failure fallback shows the companion's true idle face (asymmetric), not
    // the symmetric reset face.
    return renderGradientFace('\u2585', '\u2584');
  }
}

function renderStrip(rawState) {
  const state = buildCanonicalState(rawState);
  const palette = state.palette;
  const caps = (state.os && state.os.capabilities) || {};

  // Face — always companion-driven. Idle shows neutral alive [▅ ▄].
  // Tool-running substitutes model-specific eyes (Opus: [━ ━], Sonnet: [◠ ▅]).
  // Events show reactive expressions (happy, worried, anxious, etc.).
  const modelFace = resolveModelFace(state.session.modelId);
  const faceStr = resolveCompanionFace(rawState, palette, modelFace);

  // Model (short label)
  const modelId = state.session.modelId || state.session.model || '';
  const modelLabel = modelId.includes('opus') ? 'opus' : modelId.includes('sonnet') ? 'sonnet' : modelId.includes('haiku') ? 'haiku' : '';
  const modelStr = modelLabel ? colorize(palette, 'accent', modelLabel) : '';

  // Context %
  const ctxPct = state.session.contextPct;
  const ctxColor = ctxPct < 60 ? 'ok' : ctxPct <= 80 ? 'warn' : 'error';
  const ctxStr = colorize(palette, ctxColor, `ctx ${ctxPct}%`);

  // Health pulse — breathing block replaces letter grade
  const score = computeHealthScore(caps);
  const gradeColor = score >= 75 ? 'ok' : score >= 35 ? 'warn' : 'error';
  const gradeStr = colorize(palette, gradeColor, breathingBlock(score));

  // Caps
  const capTotal = Object.keys(caps).length;
  const degradedCount = countDegraded(caps);
  const capsStr = `${capTotal - degradedCount}/${capTotal}`;

  // Git — branch, dirty count, ahead/behind remote
  const git = state.git || {};
  const branch = git.branch || '';
  const dirty = git.dirty ? (git.uncommittedFiles || 0) : 0;
  const ahead = Number(git.ahead) || 0;
  const behind = Number(git.behind) || 0;
  let gitStr = '';
  if (branch) {
    gitStr = colorize(palette, 'accent', branch);
    if (dirty > 0) gitStr += colorize(palette, 'warn', `+${dirty}`);
    if (ahead > 0) gitStr += colorize(palette, 'accent', `\u2009\u2191${ahead}`);
    if (behind > 0) gitStr += colorize(palette, 'warn', `\u2009\u2193${behind}`);
  }

  // Forge state
  const forgeActive = state.forge.active;
  const forgePhase = state.forge.phase;
  const forgeStr = forgeActive
    ? colorize(palette, 'accent', `forge:${forgePhase || '?'}`)
    : '';

  // Rate limits
  const rl = state.session.rateLimits;
  let rateStr = '';
  if (rl && typeof rl === 'object') {
    const fh = rl.fiveHour;
    const sd = rl.sevenDay;
    if (typeof fh === 'number' && fh > 0) {
      const rlColor = fh > 80 ? 'error' : fh > 50 ? 'warn' : 'muted';
      rateStr = colorize(palette, rlColor, `5h:${fh}%`);
    }
    if (typeof sd === 'number' && sd > 0) {
      const sdColor = sd > 80 ? 'error' : sd > 50 ? 'warn' : 'muted';
      rateStr += (rateStr ? ' ' : '') + colorize(palette, sdColor, `7d:${sd}%`);
    }
  }

  // Tools
  const toolCount = state.session.toolCount || 0;
  const toolStr = toolCount > 0 ? colorize(palette, 'muted', `${toolCount}t`) : '';

  // Cost
  const cost = state.session.cost || 0;
  const costStr = cost > 0 ? colorize(palette, cost > 5 ? 'warn' : 'text', `$${cost.toFixed(2)}`) : '';

  // Uptime
  const uptime = state.session.uptime || 0;
  const uptimeStr = colorize(palette, 'muted', `${Math.floor(uptime / 60000)}m`);

  // Assemble strip: face + key info only
  const sep = colorize(palette, 'muted', '\u00B7');
  const parts = [faceStr];
  if (modelStr) parts.push(modelStr);
  parts.push(ctxStr, gradeStr, capsStr);
  if (gitStr) parts.push(gitStr);
  if (forgeStr) parts.push(forgeStr);
  const effortLevelStrip = state.session.effortLevel || '';
  if (effortLevelStrip && effortLevelStrip !== 'high') {
    parts.push(colorize(palette, effortLevelStrip === 'max' ? 'ok' : 'accent', `effort:${effortLevelStrip}`));
  }
  if (state.session.thinkingEnabled === false) parts.push(colorize(palette, 'muted', 'think:off'));
  if (rateStr) parts.push(rateStr);
  if (toolStr) parts.push(toolStr);
  if (costStr) parts.push(costStr);
  parts.push(uptimeStr);

  return parts.join(` ${sep} `);
}

// --- Zone Mode Renderer ---
// Renders a single named zone. Used by /4ge os health, /4ge os caps, etc.
function renderZone(rawState) {
  const state = buildCanonicalState(rawState);
  const zone = (state.context && state.context.zone) || 'face';
  const p = state.palette;
  const entry = getZoneEntry(zone);
  return renderCatalogEntry(entry, state, p, { zoneMode: true }).join('\n');
}

// --- Compact Mode Renderer ---
// Single-block reactive card. Shows event-relevant info in 2-4 lines.
// Used by hud-reactive.cjs after commits, test runs, forge transitions.
function renderCompact(rawState) {
  const state = buildCanonicalState(rawState);
  const p = state.palette;
  const caps = (state.os && state.os.capabilities) || {};
  const score = computeHealthScore(caps);
  const pulse = breathingBlock(score);
  const event = (state.context && state.context.event) || '';
  const degradedCount = countDegraded(caps);

  // Face inline. Prefer the live companion-state resolver for companion-owned
  // events, with legacy compact rules kept only for compact-only events until
  // the larger expression-engine deletion lane lands.
  const expr = resolveCompactExpressionName(rawState, state);
  const face = compactFaceForExpression(expr);
  const faceColor = degradedCount > 0 ? 'warn' : 'accent';

  // Health bar (short)
  const barLen = 12;
  const filled = Math.round((score / 100) * barLen);
  const hColor = score >= 75 ? 'ok' : score >= 35 ? 'warn' : 'error';
  const bar = colorize(p, hColor, '\u2550'.repeat(filled)) + colorize(p, 'muted', '\u2500'.repeat(barLen - filled));

  const msg = COMPACT_EVENT_MESSAGES[event] || '';

  // Agent-type compact card emphasis (W5 T5.2)
  // Named-agent map drives color; substring fallback handles unknown agent types.
  const AGENT_EMPHASIS = {
    'master-auditor':         hColor,
    'master-auditor-46':      hColor,
    'opus-audit':             hColor,
    'opus-review':            hColor,
    'opus-planner':           'accent',
    'sonnet-execute':         'accent',
    'sonnet-research':        'muted',
    'DFE':                    hColor,
    'forge-brainstorm':       'accent',
    'forge-planner':          'accent',
    'forge-shipper':          'accent',
  };
  const agentType = (state.context && state.context.agentType) || '';
  const agentName = (state.context && state.context.agentName) || '';
  const agentLabel = agentName || agentType;
  let titleColor = 'muted';
  if (AGENT_EMPHASIS[agentName]) titleColor = AGENT_EMPHASIS[agentName];
  else if (AGENT_EMPHASIS[agentType]) titleColor = AGENT_EMPHASIS[agentType];
  else if (agentType === 'audit' || agentName.includes('audit')) titleColor = hColor;
  else if (agentType === 'implementation' || agentName.includes('implementation')) titleColor = 'accent';

  // Build compact card
  const titlePart = agentLabel ? ` ${colorize(p, titleColor, agentLabel)}` : '';
  const line1 = `  ${colorize(p, faceColor, face)} ${colorize(p, 'muted', 'Health:')} ${colorize(p, 'text', String(score))} ${colorize(p, hColor, pulse)} [${bar}]${titlePart}`;
  const line2 = msg ? `  ${colorize(p, 'muted', msg)}` : '';

  return line2 ? `${line1}\n${line2}` : line1;
}

// --- StatusLine Mode Renderer ---
// Face on row 1 (gradient eyes), dense info rows below.
// Designed for the statusLine slot with --max-rows=N.
function renderStatusLine(rawState, maxRows) {
  const state = buildCanonicalState(rawState);
  const projectRoot = resolveProjectRoot({
    envProjectDir: rawState && rawState.projectRoot,
    fallbackRoot: process.env.CLAUDE_PROJECT_DIR || path.resolve(__dirname, '..', '..', '..'),
  });
  const palette = state.palette;
  const caps = (state.os && state.os.capabilities) || {};
  const git = state.git || {};
  const session = state.session || {};
  const forge = state.forge || {};

  // Row 1: Face + model + caps + ctx (grade removed — orb replaces it)
  const modelFace = resolveModelFace(session.modelId);
  const faceStr = resolveCompanionFace(rawState, palette, modelFace, { projectGaze: true });
  const modelId = session.modelId || session.model || '';
  const modelFamily = modelId.includes('opus') ? 'opus' : modelId.includes('sonnet') ? 'sonnet' : modelId.includes('haiku') ? 'haiku' : '';
  // Per-model color for supported public model families.
  const modelColors = { opus: '\x1b[38;5;117m', sonnet: '\x1b[38;5;75m', haiku: '\x1b[38;5;110m' };  // brightest, bright, medium
  const modelColor = modelColors[modelFamily] || '\x1b[38;5;252m';
  // Extract version: two-part model IDs (opus-4-6 → 4.6).
  const verMatch = modelId.match(/(\d+)-(\d+)/);
  let modelVer = verMatch ? `${verMatch[1]}.${verMatch[2]}` : '';
  if (!modelVer) { const sv = modelId.match(/-(\d+)(?:\[|$)/); if (sv) modelVer = sv[1]; }
  // Session number from session-meta.json (set by os-boot.cjs)
  let sessionNumber = 0;
  try {
    const metaPath = require('node:path').join(projectRoot, '_runs', 'os', 'session-meta.json');
    const meta = JSON.parse(require('node:fs').readFileSync(metaPath, 'utf8'));
    sessionNumber = meta.session_number || 0;
  } catch { /* no session number */ }
  const sessionLabel = sessionNumber > 0 ? `\x1b[38;5;103mS${sessionNumber}\x1b[0m` : '';
  // Repo label from project-root basename \u2014 lets concurrent sessions across
  // repos and worktrees self-identify at a glance. Same root resolution as the
  // session-number block above; degrades to no-label if empty.
  let repoName = '';
  try {
    repoName = require('node:path').basename(projectRoot);
  } catch { /* no repo label */ }
  const repoLabel = repoName ? `\x1b[38;5;108m${repoName}\x1b[0m` : '';
  const modelText = `${modelFamily}${modelVer ? ` ${modelVer}` : ''}`;
  const modelRender = `${modelColor}${modelText}\x1b[0m`;
  const idCore = `${modelRender}${sessionLabel ? ` \x1b[38;5;237m\u00B7\x1b[0m ${sessionLabel}` : ''}`;
  const modelLabel = repoLabel ? `${repoLabel} \x1b[38;5;237m\u00B7\x1b[0m ${idCore}` : idCore;
  const ctxPct = session.contextPct || 0;
  const score = computeHealthScore(caps);

  // Companion spectrum — spread by brightness for hierarchy
  // Bright (primary): 117, 75, 39  Mid (data): 69, 111, 74  Dim (secondary): 60, 67  Accent: 63, 99, 105
  const HI = '\x1b[38;5;39m';   // sky blue — branch
  const LO = '\x1b[38;5;67m';   // steel — caps, 5h
  const DM = '\x1b[38;5;60m';   // dark slate — timers
  const WN = '\x1b[38;5;99m';   // deep purple — dirty (stands out at purple end)
  const SEP = '\x1b[38;5;237m'; // dark — separators
  const RST = '\x1b[0m';
  const dot = `${SEP}\u00B7${RST}`;

  // Health orb: 3 chars x 2 rows, sits under the face on rows 2-3.
  // Reads companion state for reactive spin speed.
  let companionState = null;
  try {
    const companion = require('./companion-state.cjs');
    companionState = companion.resolveExpression(rawState);
  } catch { /* no companion = default spin */ }
  // Gate time-based animations on session-active flag. When idle, pass the
  // freeze timestamp (captured when session went idle) so the orb holds the
  // frame it was last on rather than snapping to rest. Output bytes stay
  // stable across CC's 2s statusLine polls — mobile Termius bounce fix.
  const engineCwd = path.resolve(__dirname, '..', '..', '..');
  const animate = require('./companion-config.cjs').loadCompanionConfig(engineCwd).animate;
  // animate OFF → force the idle/frozen branch regardless of session activity
  const outerActive = animate ? isSessionActive(engineCwd) : false;
  // animate OFF (mobile escape hatch) → force a null freeze time so the orb uses
  // its REST pose (breathScale=min, shimmer disabled) and is fully byte-stable.
  // getFreezeTime() can return a moving value while the session is live, which
  // re-introduced breath/shimmer churn under animate:false (S441 mobile-bounce fix).
  const freezeTimeMs = !animate ? null : (outerActive ? null : getFreezeTime(engineCwd));
  const orbLines = renderColoredOrb(score, { companionState, outerActive, freezeTimeMs });

  // Shared data
  const capTotal = Object.keys(caps).length;
  const degradedCount = countDegraded(caps);
  const rl = (session.rateLimits && typeof session.rateLimits === 'object') ? session.rateLimits : null;
  const toolCount = session.toolCount || 0;
  const cost = session.cost || 0;
  const uptime = session.uptime || 0;

  // Countdown formatter: epoch seconds (number) or ISO string
  function countdown(resetsAt) {
    if (resetsAt == null) return '';
    const targetMs = typeof resetsAt === 'number'
      ? resetsAt * 1000
      : new Date(resetsAt).getTime();
    if (Number.isNaN(targetMs)) return '';
    const ms = targetMs - Date.now();
    if (ms <= 0) return '';
    const mins = Math.ceil(ms / 60000);
    const hrs = Math.floor(mins / 60);
    const days = Math.floor(hrs / 24);
    if (days > 0) return `${days}d${hrs % 24}h`;
    if (hrs > 0) return `${hrs}h${String(mins % 60).padStart(2, '0')}m`;
    return `${mins}m`;
  }

  // Token formatter (accurate decimals)
  const totalTokens = (session.inputTokens || 0) + (session.outputTokens || 0)
    + (session.cacheReadTokens || 0) + (session.cacheCreationTokens || 0);
  function fmtTok(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(2) + 'M';
    if (n >= 100000) return (n / 1000).toFixed(1) + 'K';
    if (n >= 1000) return (n / 1000).toFixed(2) + 'K';
    return String(n);
  }

  // Human-equivalent hours
  const linesChanged = (session.linesAdded || 0) + (session.linesRemoved || 0);
  const humanHours = linesChanged > 0
    ? Math.max(1, Math.round(linesChanged / 30))
    : (toolCount > 0 ? Math.max(1, Math.round(toolCount * 5 / 60)) : 0);

  // Rate limit color
  function rlColor(pct) {
    return pct > 80 ? '\x1b[38;5;167m' : pct > 50 ? WN : LO;
  }

  // Braille blank (survives harness trim, unlike normal spaces)
  const BB = '\u2800';
  const orbRow0 = `${BB}${orbLines[0]}   `;
  const orbRow1 = `${BB}${orbLines[1]}   `;
  const termCols = (state.terminal && state.terminal.cols) || 80;

  // Right-align with living Braille field in the gap.
  // pct (0-100) controls density gradient. Every cell has dots — denser in the
  // "filled" region, sparser in the "unfilled" region. Pattern shifts each
  // render cycle (2s refresh) so the field breathes.
  // --- Braille field: uniform density bar driven by a single metric ---
  // Not random — each cell's dots are deterministic from position + row + metric.
  // Higher pct = more dots lit. Pattern is stable between refreshes at the same pct.
  // --- All left-aligned, consistent dot separators, no right-align tricks ---
  const SEP2 = `  ${dot}  `;  // standard separator: space-dot-space

  const branch = git.branch || '';
  const dirty = git.dirty ? (git.uncommittedFiles || 0) : 0;
  const ahead = Number(git.ahead) || 0;
  const behind = Number(git.behind) || 0;
  const lastCommitSubj = (Array.isArray(git.recentCommits) && git.recentCommits[0] && git.recentCommits[0].subject) || '';
  const uptimeMins = Math.floor(uptime / 60000);
  const uptimeStr = `${uptimeMins}m`;

  // Align all 3 rows: face and orb prefixes padded to same visible width
  const faceWidth = stripAnsi(faceStr).length;
  const orbWidth = stripAnsi(orbRow0).length;
  const prefixWidth = Math.max(faceWidth + 3, orbWidth);  // +3 for face's trailing gap
  const facePad = ' '.repeat(Math.max(0, prefixWidth - faceWidth));
  const orbPad0 = orbRow0 + ' '.repeat(Math.max(0, prefixWidth - orbWidth));
  const orbPad1 = orbRow1 + ' '.repeat(Math.max(0, prefixWidth - orbWidth));
  // Feed rows (anomaly/reactive/compact) get a blank gutter the same width as the
  // creature sprite, so their text lines up under the header body column.
  const feedGutter = ' '.repeat(prefixWidth);

  // Row 1: face · model · caps · ctx% · 5h% ↻timer · effort · think:off
  const r1 = [
    `${faceStr}${facePad}${modelLabel}`,
    `${LO}${capTotal - degradedCount}/${capTotal}${RST}`,
    `\x1b[1m\x1b[38;5;75m\u25C8${RST} \x1b[38;5;75m${ctxPct}%${RST}`,
  ];
  if (rl && typeof rl.fiveHour === 'number') {
    const c5 = rlColor(rl.fiveHour);
    let l5 = `${c5}5h:${Math.round(rl.fiveHour)}%${RST}`;
    const cd5 = countdown(rl.fiveHourResetsAt);
    if (cd5) l5 += ` \x1b[38;5;68m\u21BB${cd5}${RST}`;
    r1.push(l5);
  }
  const effortLevel = session.effortLevel || '';
  if (effortLevel && effortLevel !== 'high') {
    const effortColor = effortLevel === 'max' ? '\x1b[38;5;51m' : effortLevel === 'xhigh' ? '\x1b[38;5;117m' : '\x1b[38;5;153m';
    r1.push(`${effortColor}effort:${effortLevel}${RST}`);
  }
  if (session.thinkingEnabled === false) r1.push(`${DM}think:off${RST}`);

  const row1 = r1.join(SEP2);

  // Row 2: orb · branch · Σ human · ↑commits · wallclock · ⚒tools · 7d% ↻timer
  const r2 = [];
  if (branch) { let g = HI + branch + RST; if (dirty > 0) g += WN + '+' + dirty + RST; r2.push(g); }
  if (humanHours > 0) r2.push(`\x1b[1m\x1b[38;5;63m\u03A3${RST} \x1b[38;5;63m~${humanHours}h${RST}`);
  if (ahead > 0) r2.push(`\x1b[1m\x1b[38;5;111m\u2191${RST} \x1b[38;5;111m${ahead}${RST}`);
  if (behind > 0) r2.push(`\x1b[1m\x1b[38;5;167m\u2193${RST} \x1b[38;5;167m${behind}${RST}`);
  r2.push(`\x1b[38;5;153m${uptimeStr}${RST}`);
  if (toolCount > 0) r2.push(`\x1b[1m\x1b[38;5;69m\u22A5${RST} \x1b[38;5;69m${toolCount}${RST}`);
  if (rl && typeof rl.sevenDay === 'number') {
    const c7 = rl.sevenDay > 80 ? '\x1b[38;5;63m' : '\x1b[38;5;104m';  // companion indigo when critical, light indigo normal
    let l7 = `${c7}7d:${Math.round(rl.sevenDay)}%${RST}`;
    const cd7 = countdown(rl.sevenDayResetsAt);
    if (cd7) l7 += ` \x1b[38;5;68m\u21BB${cd7}${RST}`;
    r2.push(l7);
  }
  if (forge.active) r2.push(`${HI}forge:${forge.phase || '?'}${RST}`);
  const row2 = `${orbPad0}${r2.join(SEP2)}`;

  // Row 3: orb · $cost · tokens · commit subject
  // Human hours moved to row 2 second slot; commit subject gets the breathing room.
  const r3 = [];
  if (cost > 0) r3.push(`\x1b[1m\x1b[38;5;39m$${RST} \x1b[38;5;39m${cost.toFixed(2)}${RST}`);
  if (totalTokens > 0) r3.push(`\x1b[38;5;67m${fmtTok(totalTokens)}${RST}`);
  if (lastCommitSubj) {
    const usedCols = stripAnsi(orbPad1 + r3.join(SEP2)).length + (r3.length > 0 ? 5 : 0);
    const remaining = Math.max(0, termCols - usedCols - 2);
    if (remaining >= 12) {
      const trunc = lastCommitSubj.length > remaining ? lastCommitSubj.slice(0, remaining - 1) + '\u2026' : lastCommitSubj;
      r3.push(`\x1b[38;5;241m${trunc}${RST}`);
    }
  }
  const row3 = `${orbPad1}${r3.join(SEP2)}`;

  // Companion message check. When active, REPLACE the data rows with a speech
  // bubble extending right of the companion (face + orb). Single source of voice:
  // when the companion has something to say, it speaks; data view returns when
  // the message TTL expires (flash 8s, signal 30s, critical 120s).
  const ceiling = maxRows || 8;
  let rows = [row1, row2, row3];

  let msg = null;
  try {
    const cs = require('./companion-state.cjs');
    const am = cs.activeMessage();
    if (am) msg = am;
  } catch { /* no companion */ }

  if (!msg) {
    try {
      const { getInsight } = require('./companion-insights.cjs');
      const insight = getInsight(state);
      if (insight) msg = { text: insight, tier: 'signal', age: 0 };
    } catch { /* no insights */ }
  }

  if (msg) {
    // Voice from the companion. No stamp glyph — the face IS the speaker, so
    // text appearing on the same row reads as its speech. Italic ANSI gives
    // the spoken-voice quality. Trail of braille dots fades into the orb's
    // own Unicode range (U+2800+), suggesting the voice cooling/dispersing
    // back into the companion's body.
    //
    // Palette is the companion's cool spectrum — same indigo/sky/steel/cyan
    // family as the face and orb. No new vocabulary introduced.
    const ITAL = '\x1b[3m';
    const TIER_BRIGHT = '\x1b[38;5;51m';    // critical — bright cyan
    const TIER_LIGHT  = '\x1b[38;5;117m';   // signal — light blue
    const TIER_STEEL  = '\x1b[38;5;67m';    // flash — steel
    const SPARK_HI    = '\x1b[38;5;75m';    // bright blue
    const SPARK_MID   = '\x1b[38;5;67m';    // steel
    const SPARK_LO    = '\x1b[38;5;240m';   // dim grey
    // Color stays constant for the message's full lifetime — no mid-life
    // fade. The TTL itself controls visibility; while visible, color is loud.
    const TIER = ({ critical: TIER_BRIGHT, signal: TIER_LIGHT, flash: TIER_STEEL }[msg.tier] || TIER_LIGHT);
    // Mirrored dot ramps bracket the message: dim → bright → TEXT → bright → dim.
    // Inner (bright) ends sit close to the text; outer (dim) ends fade away.
    // Same braille range (U+2800+) as the orb body — voice trailing in and out
    // of the companion.
    const rampIn  = `${SPARK_LO}\u2804${RST} ${SPARK_MID}\u2802${RST} ${SPARK_HI}\u2801${RST}`;
    const rampOut = `${SPARK_HI}\u2801${RST} ${SPARK_MID}\u2802${RST} ${SPARK_LO}\u2804${RST}`;
    const rampCols = 5; // "⠄ ⠂ ⠁"
    // Em dash prefix — literary dialogue convention ("— Yes," he said).
    const dashCols = 2; // "— "
    const headerLeft = `${faceStr}${facePad}`;
    const headerLeftCols = stripAnsi(headerLeft).length;
    // Spaces: ramp→text (1) + text→ramp (1)
    const remaining = Math.max(0, termCols - headerLeftCols - dashCols - rampCols * 2 - 2);
    let text = msg.text;
    if (text.length > remaining) text = text.slice(0, remaining - 1) + '\u2026';
    rows = [
      `${headerLeft}${TIER}\u2014${RST} ${rampIn} ${ITAL}${TIER}${text}${RST} ${rampOut}`,
      orbPad0,
      orbPad1,
    ];
  }

  const anomalyRows = renderAnomalyStatuslineRows(state, palette, Math.max(0, ceiling - rows.length), feedGutter);
  if (anomalyRows.length > 0) {
    rows = rows.concat(anomalyRows);
  }

  const reactiveRows = renderReactiveStatuslineRows(state, palette, Math.max(0, ceiling - rows.length), feedGutter);
  if (reactiveRows.length > 0) {
    rows = rows.concat(reactiveRows);
  }

  const compactRows = renderCompactStatuslineRows(state, palette, Math.max(0, ceiling - rows.length), feedGutter);
  if (compactRows.length > 0) {
    rows = rows.concat(compactRows);
  }

  // --- Boot-pulse: expanded layout within the first 12 s after OS boot ---
  // Stateless: reads boot-status.json; no flag/state file written.
  // Failsafe: missing / unreadable / malformed / old timestamp → skip (compact normal).
  try {
    const bootStatusPath = require('node:path').join(projectRoot, '_runs', 'os', 'boot-status.json');
    const bs = JSON.parse(require('node:fs').readFileSync(bootStatusPath, 'utf8'));
    const booted = Date.parse(bs && bs.booted_at);
    if (Number.isFinite(booted) && (Date.now() - booted) <= 12000) {
      // Fresh boot — expand to show capabilities + health + boot timing.
      const capsObj = (bs && bs.capabilities) || {};
      const capNames = Object.keys(capsObj);
      const capLines = capNames.slice(0, Math.max(0, ceiling - 2)).map(n => {
        const c = capsObj[n];
        const ok = c && (c.status === 'ready');
        const dot = ok ? `\x1b[38;5;77m●${RST}` : `\x1b[38;5;167m●${RST}`;
        const ms = (c && c.init_ms) ? ` \x1b[38;5;243m${c.init_ms}ms${RST}` : '';
        const reason = (!ok && c && c.reason) ? ` \x1b[38;5;167m${c.reason}${RST}` : '';
        return `  ${dot} \x1b[38;5;253m${n}${RST}${ms}${reason}`;
      });
      const totalMs = bs.total_boot_ms != null ? ` \x1b[38;5;240m(${bs.total_boot_ms}ms)${RST}` : '';
      const bootHeader = `\x1b[1m\x1b[38;5;75m⚡ OS BOOT${RST}${totalMs}  ${row1}`;
      rows = [bootHeader, ...capLines].slice(0, ceiling);
    }
  } catch { /* boot-pulse unavailable — render compact */ }

  // Trailing blank padding: claude-hud parity. CC's statusLine renderer treats
  // "content + N trailing blanks" as a self-contained pin region; without padding
  // the cursor lands on the last content row and mobile terminals (Termius) auto-
  // scroll content below the viewport, burying response text.
  return rows.slice(0, ceiling).join('\n') + '\n\n\n\n';
}

// --- Substrate Mode Renderer ---
// Produces a response-text-format scene using Unicode substrate techniques:
// math alphanumerics, combining marks, half marks, enclosing marks, block elements,
// box drawing, and colored emoji. No ANSI escape codes.
function renderSubstrate(rawState) {
  const state = buildCanonicalState(rawState);
  return renderSubstrateZone(state);
}

// --- Scene Mode Renderer ---
// Atmospheric scene composition (DIS-ARC-005 Section 8). Selects scene via
// companion-state (idle/focused/alert) and composes background + character
// overlay + info line through scene-compositor.
function renderScene(rawState, maxRows) {
  const state = buildCanonicalState(rawState);
  const lines = composeScene(state, { maxLines: maxRows || 10 });
  return lines.join('\n');
}

// --- Mode Router ---
function renderByMode(rawState, mode, maxRows) {
  switch (mode) {
    case 'strip':      return renderStrip(rawState);
    case 'full':       return renderFull(rawState);
    case 'zone':       return renderZone(rawState);
    case 'compact':    return renderCompact(rawState);
    case 'statusline': return renderStatusLine(rawState, maxRows);
    case 'substrate':  return renderSubstrate(rawState);
    case 'scene':      return renderScene(rawState, maxRows);
    default:           return renderFull(rawState);
  }
}

// --- CLI Entry ---
if (require.main === module) {
  const PLUGIN_ROOT = path.resolve(__dirname, '..', '..', '..');
  const PROJECT_ROOT = resolveProjectRoot({
    envProjectDir: process.env.CLAUDE_PROJECT_DIR,
    fallbackRoot: PLUGIN_ROOT,
  });

  // Parse --mode, --max-rows, and --zone args
  const args = process.argv.slice(2);
  let mode = 'full';
  let maxRows = 8;
  let zoneArg = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--mode=')) {
      mode = args[i].split('=')[1];
    } else if (args[i] === '--mode' && i + 1 < args.length) {
      mode = args[++i];
    } else if (args[i].startsWith('--max-rows=')) {
      maxRows = parseInt(args[i].split('=')[1], 10) || 8;
    } else if (args[i] === '--max-rows' && i + 1 < args.length) {
      maxRows = parseInt(args[++i], 10) || 8;
    } else if (args[i].startsWith('--zone=')) {
      zoneArg = args[i].split('=')[1];
    } else if (args[i] === '--zone' && i + 1 < args.length) {
      zoneArg = args[++i];
    }
  }

  // Read JSON from stdin
  let input = '';
  const chunks = [];
  process.stdin.setEncoding('utf8');

  // Handle piped input
  if (!process.stdin.isTTY) {
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => {
      input = chunks.join('');
      let stdinData = null;
      try {
        if (input && input.trim()) stdinData = JSON.parse(input);
      } catch {
        // Empty or invalid stdin — fall through with no data
      }

      // Prefer the harness-provided project dir (stdin cwd / workspace.project_dir)
      // over the __dirname fallback, which resolves into the plugin cache dir for
      // cache installs (yielding a 'turd-box' repo label + missing _runs/os state).
      // A real CLAUDE_PROJECT_DIR env var, if the harness sets one, still wins.
      const effectiveRoot = resolveProjectRoot({
        envProjectDir: process.env.CLAUDE_PROJECT_DIR,
        workspaceProjectDir: stdinData && stdinData.workspace && stdinData.workspace.project_dir,
        stdinCwd: stdinData && stdinData.cwd,
        fallbackRoot: PROJECT_ROOT,
      });

      let rawState;
      if (mode === 'statusline') {
        // Statusline mode: load disk state without override, then apply harness merge
        rawState = loadHudData({
          stateDir: require('node:path').join(effectiveRoot, '_runs', 'os'),
          cwd: effectiveRoot,
          runExpensiveProbes: false,
        });
        if (stdinData) mergeHarnessStdin(rawState, stdinData);
      } else {
        // Other modes: generic shallow merge (stdin as state override)
        rawState = loadHudData({
          stateDir: require('node:path').join(effectiveRoot, '_runs', 'os'),
          cwd: effectiveRoot,
          runExpensiveProbes: mode === 'full',
          stdinOverride: stdinData,
        });
      }

      if (zoneArg) {
        rawState.context = Object.assign({}, rawState.context, { zone: zoneArg });
      }
      const output = renderByMode(rawState, mode, maxRows);
      process.stdout.write(output);
    });
  } else {
    // No stdin — assemble raw state from disk
    const rawState = loadHudData({
      stateDir: require('node:path').join(PROJECT_ROOT, '_runs', 'os'),
      cwd: PROJECT_ROOT,
      runExpensiveProbes: mode === 'full',
    });
    if (zoneArg) {
      rawState.context = Object.assign({}, rawState.context, { zone: zoneArg });
    }
    const output = renderByMode(rawState, mode, maxRows);
    process.stdout.write(output);
  }
}

module.exports = {
  renderFull,
  renderStrip,
  renderZone,
  renderCompact,
  renderStatusLine,
  renderSubstrate,
  renderByMode,
  resolveProjectRoot,
  ZONE_CATALOG,
  getZoneEntry,
  getCompositeZoneEntries,
  getReactiveStatuslineZoneEntries,
  renderReactiveStatuslineRows,
  renderAnomalyStatuslineRows,
  renderCompactStatuslineRows,
  MODEL_FACE,
  resolveModelFace,
  resolveCompanionFace,
  COMPACT_FACES,
};
