'use strict';

const { colorize, stripAnsi } = require('./hud-palette.cjs');
const { countDegraded } = require('./hud-state.cjs');
const { buildExpression, selectExpression, getExpressionName, EXPRESSIONS } = require('./hud-expressions.cjs');
const { renderCompanionEyes } = require('./companion-face.cjs');
const { renderColoredOrb } = require('./hud-braille-orb.cjs');
const { computeHealthScore } = require('./hud-zone-health.cjs');

// --- Constants ---
const SIDE_BY_SIDE_THRESHOLD = 60; // cols needed for side-by-side layout
const FACE_COL_WIDTH = 8;          // companion eyes (CompactFace) — tight gap to header/ledger

// --- Half-Block Pixel Art Eyes ---
// Uses ▀ (upper half) and ▄ (lower half) with fg/bg color tricks.
// Each character cell = 2 vertical pixels. 3 cells wide per eye = 6 pixel-rows
// across 3 terminal rows. Dense like ▅ ▆ but scaled up.
//
// The eye shape uses these building blocks:
//   ▄ = bottom-half filled (eye opening from top)
//   █ = full block (solid eye)
//   ▀ = top-half filled (eye closing from bottom)
//   ' ' = empty (canvas fill shows through)
//
// Healthy eyes: 3 wide x 3 tall, full rounded shape
//   Row 0:  ▄██▄    ▄██▄     (top curve: half-block entry, full middle)
//   Row 1:  ████    ████     (full open middle)
//   Row 2:  ▀██▀    ▀██▀     (bottom curve: half-block exit)

function buildFaceLines(leftEye, rightEye) {
  const lines = [];
  const rows = Math.max(leftEye.length, rightEye.length);
  for (let i = 0; i < rows; i++) {
    const l = leftEye[i] || '         ';
    const r = rightEye[i] || '         ';
    lines.push(` ${l}  ${r} `);
  }
  // Pad to 6 rows
  while (lines.length < 6) lines.push('                          ');
  return lines;
}

// Invader Zim inspired — big, round, solid color, expressive through shape.
// 5 wide, 4 tall. Oval with smooth half-block curves.
const EYE_HEALTHY = [
  '  \u2584\u2588\u2588\u2588\u2584  ',
  '  \u2588\u2588\u2588\u2588\u2588  ',
  '  \u2588\u2588\u2588\u2588\u2588  ',
  '  \u2580\u2588\u2588\u2588\u2580  ',
];

const EYE_MILD = [
  '  \u2584\u2588\u2588\u2584   ',
  '  \u2588\u2588\u2588\u2588\u2588  ',
  '  \u2588\u2588\u2588\u2588\u2588  ',
  '  \u2580\u2588\u2588\u2580   ',
];

const EYE_MEDIUM = [
  '         ',
  '  \u2584\u2588\u2588\u2588\u2584  ',
  '  \u2580\u2588\u2588\u2588\u2580  ',
  '         ',
];

const EYE_SEVERE = [
  '         ',
  '  \u2584\u2588\u2588\u2588\u2584  ',
  '  \u2580\u2580\u2580\u2580\u2580  ',
  '         ',
];

// Healthy: both eyes full open, big round
const FACE_HEALTHY = buildFaceLines(EYE_HEALTHY, EYE_HEALTHY);

// Mild: left eye slightly different shape (asymmetric, curious)
const FACE_DEGRADED = {
  mild: buildFaceLines(EYE_MILD, EYE_HEALTHY),
  medium: buildFaceLines(EYE_MEDIUM, EYE_MEDIUM),
  severe: buildFaceLines(EYE_SEVERE, EYE_SEVERE),
};

// --- Clawd mascot sprite (canonical) ---
// Source: harness-intel/source/src/components/LogoV2/Clawd.tsx
// 4 poses × 3 rows. Each row padded to 9 cols for terminal monospace alignment.
const CLAWD_POSES = {
  default: [
    ' \u2590\u259B\u2588\u2588\u2588\u259C\u258C ',  //  ▐▛███▜▌
    '\u259D\u259C\u2588\u2588\u2588\u2588\u2588\u259B\u2598',  // ▝▜█████▛▘
    '  \u2598\u2598 \u259D\u259D  ',  //   ▘▘ ▝▝
  ],
  'look-left': [
    ' \u2590\u259F\u2588\u2588\u2588\u259F\u258C ',  //  ▐▟███▟▌ (both pupils left)
    '\u259D\u259C\u2588\u2588\u2588\u2588\u2588\u259B\u2598',
    '  \u2598\u2598 \u259D\u259D  ',
  ],
  'look-right': [
    ' \u2590\u2599\u2588\u2588\u2588\u2599\u258C ',  //  ▐▙███▙▌ (both pupils right)
    '\u259D\u259C\u2588\u2588\u2588\u2588\u2588\u259B\u2598',
    '  \u2598\u2598 \u259D\u259D  ',
  ],
  'arms-up': [
    '\u2597\u259F\u259B\u2588\u2588\u2588\u259C\u2599\u2596',  // ▗▟▛███▜▙▖ (arms raised)
    ' \u259C\u2588\u2588\u2588\u2588\u2588\u259B ',  //  ▜█████▛
    '  \u2598\u2598 \u259D\u259D  ',
  ],
};

/** Pick a Clawd pose based on expression name + time-mod idle cycle. */
function pickClawdPose(expressionName) {
  // Expression-driven poses override idle cycle.
  if (expressionName === 'excited' || expressionName === 'proud joy') return 'arms-up';
  if (expressionName === 'curious' || expressionName === 'intrigued') return 'look-left';
  if (expressionName === 'thinking' || expressionName === 'suspicious') return 'look-right';

  // Idle cycle: mostly default, brief glances every few ticks. 30-second cycle.
  const tick = Math.floor(Date.now() / 1000);
  const slot = tick % 30;
  if (slot >= 5  && slot < 7)  return 'look-left';
  if (slot >= 12 && slot < 14) return 'look-right';
  if (slot >= 20 && slot < 22) return 'arms-up';
  return 'default';
}

/**
 * Build Clawd face rows padded to idealRows (6).
 * Sprite sits in rows 2-4, centered vertically with blank padding above/below.
 */
function buildClawdLines(poseName) {
  const pose = CLAWD_POSES[poseName] || CLAWD_POSES.default;
  const blank = '         ';  // 9 spaces to match sprite width
  return [
    blank,       // padding top
    blank,       // padding top
    pose[0],     // sprite row 1: head + eyes
    pose[1],     // sprite row 2: body + arms
    pose[2],     // sprite row 3: feet
    blank,       // padding bottom
  ];
}

// Inline (1-row) faces — matches statusline ▅ ▆ style
const FACE_HEALTHY_INLINE = '\u2585\u2586 \u2585\u2586';
const FACE_DEGRADED_INLINE = {
  mild: '\u2584\u2585 \u2585\u2586',
  medium: '\u2583\u2584 \u2583\u2584',
  severe: '\u2582\u2583 \u2582\u2583',
};

// --- Quips ---
const DEGRADED_QUIPS = {
  memory:            ['what were we talking about?', 'memory? what memory?'],
  aisle:             ['security left the building', 'running unprotected'],
  llm:               ['the brain is offline', 'thinking with our gut'],
  infra:             ['docker just ragequit', 'containers have opinions'],
  git:               ['git is having a crisis', 'version control? never heard of it'],
  forge:             ['forge dropped the hammer', 'the blacksmith went home'],
  audit:             ['nobody is watching', 'audit looked the other way'],
  autoresearch:      ['research on strike'],
  'file-integrity':  ['files doing their own thing'],
  'process-health':  ['processes running wild'],
  'workflow-engine': ['workflow took a detour'],
};

const MULTI_CAP_QUIPS = [
  'working through it',
  'few things to sort out',
  'nothing we can not handle',
  'getting there',
];

// --- Helpers ---
function degradedTier(count) {
  if (count <= 1) return 'mild';
  if (count <= 3) return 'medium';
  return 'severe';
}

function pickQuip(degradedCaps) {
  const seed = Math.floor(Date.now() / 1000);
  if (degradedCaps.length >= 3) {
    return MULTI_CAP_QUIPS[seed % MULTI_CAP_QUIPS.length];
  }
  const target = degradedCaps[0];
  const quips = DEGRADED_QUIPS[target];
  if (quips) return quips[seed % quips.length];
  return MULTI_CAP_QUIPS[seed % MULTI_CAP_QUIPS.length];
}

function humanizeMs(ms) {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

function padRight(str, width) {
  const visible = stripAnsi(str).length;
  const pad = Math.max(0, width - visible);
  return str + ' '.repeat(pad);
}

// --- Zone Renderer ---

/**
 * Renders the face + header zone.
 * @param {object} state - Canonical render state
 * @param {object} palette - Resolved palette
 * @returns {string[]} Array of lines (1 for narrow, 3 for wide)
 */
function renderFaceZone(state, palette) {
  const cols = state.terminal.cols;
  const caps = (state.os && state.os.capabilities) || {};
  const degradedCount = countDegraded(caps);
  const degradedNames = Object.entries(caps).filter(([, c]) => !c.ok).map(([n]) => n);
  const readyCount = Object.keys(caps).length - degradedCount;
  const tier = degradedTier(degradedCount);
  const bootTime = (state.os && state.os.bootTime) || 0;

  // Narrow terminal: 1-line inline
  if (cols < SIDE_BY_SIDE_THRESHOLD) {
    const face = degradedCount === 0 ? FACE_HEALTHY_INLINE : FACE_DEGRADED_INLINE[tier];
    const faceColored = colorize(palette, degradedCount === 0 ? 'accent' : 'error', face);
    const label = degradedCount === 0
      ? colorize(palette, 'text', 'Agentic OS up')
      : colorize(palette, 'warn', `${degradedCount} degraded`);
    return [`  ${faceColored} ${label}`];
  }

  // Wide terminal: 6-line side-by-side — companion eyes (CompactFace, cross-colored).
  // Retires the CLAWD blob; reuses the SAME eyes the statusline renders, driven by
  // the existing expression resolution (getExpressionName). Eye styling + behavior are
  // operator-locked and preserved — this only changes WHICH face the full HUD shows.
  const exprNameForFace = getExpressionName(state);
  const eyesLine = renderCompanionEyes(exprNameForFace, palette);
  // The braille body (orb) always rides with the eyes — the companion creature.
  // Eyes on row 0, breathing health-gated orb (2 rows) centered beneath. The orb's
  // animation/health-gating behavior is operator-locked and reused as-is.
  const score = computeHealthScore(caps);
  const orbLines = renderColoredOrb(score, {});

  // Header info (right of face) — calm, informative
  const statusText = colorize(palette, 'text', 'Agentic OS');
  const bootText = colorize(palette, 'muted', humanizeMs(bootTime));

  const countText = degradedCount === 0
    ? colorize(palette, 'ok', `${readyCount} ready`)
    : colorize(palette, 'ok', `${readyCount} ready`) + colorize(palette, 'muted', ' \u00B7 ') + colorize(palette, 'warn', `${degradedCount} degraded`);

  // Expression-aware quips
  const exprName = getExpressionName(state);
  let quipText = '';
  if (degradedCount > 0) {
    const quip = pickQuip(degradedNames);
    quipText = colorize(palette, 'warn', quip);
  } else {
    const exprQuips = {
      neutral: 'everything is where it should be',
      'neutral alive': 'everything is where it should be',
      happy: 'all systems green',
      focused: 'locked in',
      curious: 'exploring',
      sleepy: 'context getting heavy',
      thinking: 'working through it',
      determined: 'on it',
      excited: 'shipped',
      winking: 'packaging',
      surprised: 'good morning',
      blinking: '',
    };
    const quip = exprQuips[exprName] || '';
    if (quip) quipText = colorize(palette, 'muted', quip);
  }

  // Stacked single column: the companion creature (eyes + braille body) on top, then a
  // status line \u2014 left-aligned at the same margin as the zones below, so the full HUD
  // reads as one clean column instead of a ragged creature-beside-ledger step.
  const sep = colorize(palette, 'muted', '\u00B7');
  const statusLine = `${statusText} ${sep} ${countText} ${sep} ${bootText}${quipText ? ` ${sep} ${quipText}` : ''}`;
  return [
    `  ${eyesLine}`,
    `   ${orbLines[0]}`,
    `   ${orbLines[1]}`,
    `  ${statusLine}`,
  ];
}

// --- Zone Metadata (for allocator) ---
const ZONE_META = {
  key: 'face',
  priority: 10,
  minRows: 1,
  idealRows: 6,
};

module.exports = {
  renderFaceZone,
  ZONE_META,
  FACE_HEALTHY,
  FACE_DEGRADED,
  FACE_HEALTHY_INLINE,
  FACE_DEGRADED_INLINE,
  DEGRADED_QUIPS,
  MULTI_CAP_QUIPS,
  CLAWD_POSES,
  degradedTier,
  pickQuip,
  humanizeMs,
  pickClawdPose,
  buildClawdLines,
};
