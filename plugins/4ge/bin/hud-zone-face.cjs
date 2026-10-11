'use strict';

const { colorize } = require('./hud-palette.cjs');
const { countDegraded, classifyCapabilityHealth } = require('./hud-state.cjs');
const { getExpressionName } = require('./hud-expressions.cjs');
const { renderCompanionEyes } = require('./companion-face.cjs');
const { renderColoredOrb } = require('./hud-braille-orb.cjs');
const {
  computeHealthScore, formatIncompleteHealth, isHealthFailed, formatFailedHealth,
} = require('./hud-zone-health.cjs');
const { loadCompanionConfig } = require('./companion-config.cjs');
const { isActive: isSessionActive, getFreezeTime } = require('../lib/hud-active-flag.cjs');

// --- Constants ---
const SIDE_BY_SIDE_THRESHOLD = 60; // cols needed for side-by-side layout

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
  const classification = classifyCapabilityHealth(caps);
  const degradedCount = countDegraded(caps);
  const degradedNames = classification.failed;
  const readyCount = Object.keys(caps).length - degradedCount;
  const tier = degradedTier(degradedCount);
  const bootTime = (state.os && state.os.bootTime) || 0;
  const healthFailed = isHealthFailed(state, classification);
  const failedLabel = formatFailedHealth(classification);
  // Empty or non-boolean observations are not evidence of health. A mixed map
  // retains its observed counts, but never gets healthy copy or a healthy quip.
  const healthUnknown = !healthFailed
    && (classification.total === 0 || classification.unknown.length > 0);
  const incompleteLabel = formatIncompleteHealth(classification);

  // Narrow terminal: 1-line inline
  if (cols < SIDE_BY_SIDE_THRESHOLD) {
    const face = healthFailed
      ? FACE_DEGRADED_INLINE.severe
      : degradedCount === 0 ? FACE_HEALTHY_INLINE : FACE_DEGRADED_INLINE[tier];
    const faceRole = healthFailed ? 'error' : healthUnknown ? 'muted' : degradedCount === 0 ? 'accent' : 'error';
    const faceColored = colorize(palette, faceRole, face);
    const label = healthFailed
      ? colorize(palette, 'error', failedLabel)
      : healthUnknown
        ? colorize(palette, 'warn', incompleteLabel)
        : degradedCount === 0
          ? colorize(palette, 'text', 'Agentic OS up')
          : colorize(palette, 'warn', `${degradedCount} degraded`);
    return [`  ${faceColored} ${label}`];
  }

  // Wide terminal: companion eyes (CompactFace, cross-colored).
  // Reuses the same eyes the statusline renders, driven by the existing
  // expression resolution (getExpressionName). Eye styling + behavior are
  // operator-locked and preserved.
  let companionState = null;
  try {
    const companion = require('./companion-state.cjs');
    companionState = companion.resolveExpression(state);
  } catch { /* companion-state unavailable */ }

  const exprNameForFace = (companionState && companionState.expression) || getExpressionName(state);
  const eyesLine = renderCompanionEyes(exprNameForFace, palette);
  // The braille body (orb) always rides with the eyes — the companion creature.
  // Eyes on row 0, breathing health-gated orb (2 rows) centered beneath.
  // Use the same companion/freeze inputs as the live statusline path so full
  // HUD renders do not silently bypass companion state or the mobile freeze gate.
  const score = computeHealthScore(caps);
  const projectRoot = state.projectRoot || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const animate = loadCompanionConfig(projectRoot).animate;
  const outerActive = animate ? isSessionActive(projectRoot) : false;
  const freezeTimeMs = outerActive ? null : getFreezeTime(projectRoot);
  const orbLines = renderColoredOrb(score, { companionState, outerActive, freezeTimeMs });

  // Header info (right of face) — calm, informative
  const statusText = colorize(palette, 'text', 'Agentic OS');
  const bootText = colorize(palette, 'muted', humanizeMs(bootTime));

  const countText = healthFailed
    ? colorize(palette, 'error', failedLabel)
    : healthUnknown
      ? colorize(palette, 'warn', incompleteLabel)
      : degradedCount === 0
        ? colorize(palette, 'ok', `${readyCount} ready`)
        : colorize(palette, 'ok', `${readyCount} ready`) + colorize(palette, 'muted', ' \u00B7 ') + colorize(palette, 'warn', `${degradedCount} degraded`);

  // Expression-aware quips
  const exprName = exprNameForFace;
  let quipText = '';
  if (!healthFailed && !healthUnknown && degradedCount > 0) {
    const quip = pickQuip(degradedNames);
    quipText = colorize(palette, 'warn', quip);
  } else if (!healthFailed && !healthUnknown) {
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
  FACE_HEALTHY_INLINE,
  FACE_DEGRADED_INLINE,
  DEGRADED_QUIPS,
  MULTI_CAP_QUIPS,
  degradedTier,
  pickQuip,
  humanizeMs,
};
