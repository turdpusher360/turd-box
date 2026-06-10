#!/usr/bin/env node
'use strict';

const { resolvePalette, colorize, stripAnsi } = require('./hud-palette.cjs');
const { buildCanonicalState, countDegraded } = require('./hud-state.cjs');
const { createCanvas, paintRows, allocateVerticalZones, render } = require('./hud-canvas.cjs');
const { renderFaceZone, ZONE_META: FACE_META } = require('./hud-zone-face.cjs');
const { renderHealthZone, ZONE_META: HEALTH_META, computeHealthScore } = require('./hud-zone-health.cjs');
const { renderColoredOrb } = require('./hud-braille-orb.cjs');
const path = require('node:path');
const { isActive: isSessionActive, getFreezeTime } = require('../lib/hud-active-flag.cjs');
const { renderContextZone, ZONE_META: CONTEXT_META } = require('./hud-zone-context.cjs');
const { renderForgeZone, ZONE_META: FORGE_META } = require('./hud-zone-forge.cjs');
const { renderCapsZone } = require('./hud-zone-caps.cjs');
const { renderBadgesZone } = require('./hud-zone-badges.cjs');
const { renderSessionZone } = require('./hud-zone-session.cjs');
const { renderCommandCards } = require('./hud-zone-cards.cjs');
const { renderRateLimitZone, RATE_META, rateVisible } = require('./hud-zone-rate-limit.cjs');
const { renderActivityZone } = require('./hud-zone-activity.cjs');
const { renderForgeProgressZone, ZONE_META: FORGE_PROGRESS_META, forgeProgressVisible } = require('./hud-zone-forge-progress.cjs');
const { renderGitStatusZone, ZONE_META: GIT_STATUS_META, gitStatusVisible } = require('./hud-zone-git-status.cjs');
const { loadHudData, mergeHarnessStdin } = require('./hud-data-loader.cjs');
const { renderSubstrateZone } = require('./hud-zone-substrate.cjs');
const { composeScene } = require('./scene-compositor.cjs');

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

  // Define all zones — allocator sorts by priority, drops low-priority when space is tight
  // S396 companion-led restraint: the full HUD is a clean glance — companion eyes +
  // a tight data ledger, not a 30-row carnival.
  // DROPPED from the COMPOSITE (still reachable on demand via `/4ge os <zone>`):
  //   caps grid/histogram, badge grid, command-card sprites (the banned yellow
  //   block-face), session history, and the activity zone (which leaked the render
  //   command into the boot HUD).
  // KEPT but self-hiding (visibility-gated ALERTS — render only when relevant, so
  //   they cost nothing in the normal glance): rate-limit breach + live forge progress.
  const zoneRenderers = [
    { meta: FACE_META,    key: 'face',    render: renderFaceZone },
    { meta: CONTEXT_META, key: 'context', render: renderContextZone },
    { meta: HEALTH_META,  key: 'health',  render: renderHealthZone },
    { meta: FORGE_META,   key: 'forge',   render: renderForgeZone },
    { meta: GIT_STATUS_META, key: 'gitStatus', render: renderGitStatusZone, visible: gitStatusVisible },
    { meta: RATE_META, key: 'rate', render: renderRateLimitZone, visible: rateVisible },
    { meta: FORGE_PROGRESS_META, key: 'forgeProgress', render: renderForgeProgressZone, visible: forgeProgressVisible },
  ];

  // W3: Filter zones by visibility predicate before allocation.
  // Zones without a visible() function are always visible (backward compat).
  const activeRenderers = zoneRenderers.filter(z => !z.visible || z.visible(state));
  const zones = activeRenderers.map(z => ({ ...z.meta, key: z.key }));

  // Context-aware zone priority boosting.
  // Adjust priority values based on the current event without mutating ZONE_META constants.
  const event = (state.context && state.context.event) || '';
  if (event) {
    const boostMap = {
      'forge-phase': { forge: 9, cards: 8 },
      'badge-earned': { badges: 9, cards: 7 },
      'test-pass':   { session: 8, cards: 6 },
      'test-fail':   { session: 8, cards: 8 },
    };
    const boost = boostMap[event];
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
  'claude-fable-5':      { expr: 'determined', color: 'accent' },  // S398: Mythos-class flagship
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
  if (modelId.startsWith('claude-fable'))  return MODEL_FACE['claude-fable-5'];
  if (modelId.startsWith('claude-opus'))   return MODEL_FACE['claude-opus-4-6'];
  if (modelId.startsWith('claude-sonnet')) return MODEL_FACE['claude-sonnet-4-6'];
  if (modelId.startsWith('claude-haiku'))  return MODEL_FACE['claude-haiku-4-5'];
  return null;
}

// S398: the Fable flagship gets a rainbow model label — a STATIC ROYGBIV gradient
// across each visible glyph. Declared in docs/reference/hud-vocabulary.md §10/§32.
// Static (not animated) by design: idle renders stay byte-identical so the mobile
// Termius freeze invariant (§5) holds. Spaces keep no hue. Fable-only — the cyan
// trio (opus/sonnet/haiku) keep their solid spectrum colors.
const FABLE_RAINBOW = [196, 208, 226, 46, 51, 27, 129];  // red→orange→yellow→green→cyan→blue→violet
function rainbowize(text) {
  let out = '';
  let i = 0;
  for (const ch of text) {
    if (ch === ' ') { out += ch; continue; }
    out += `\x1b[38;5;${FABLE_RAINBOW[i % FABLE_RAINBOW.length]}m${ch}`;
    i++;
  }
  return out + '\x1b[0m';
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

// Gradient face: left eye purple (57), right eye blue (39)
const FACE_LEFT = '\x1b[38;5;63m';   // muted indigo (brackets + small eye)
const FACE_RIGHT = '\x1b[38;5;39m';  // sky blue (brackets + big eye)
const FACE_RESET = '\x1b[0m';

function renderGradientFace(leftGlyph, rightGlyph) {
  // Big eye (left) = blue, small eye (right) = purple
  // Brackets cross: [ = purple (on blue side), ] = blue (on purple side)
  return FACE_LEFT + '[' + FACE_RIGHT + leftGlyph + FACE_RESET + ' ' + FACE_LEFT + rightGlyph + FACE_RIGHT + ']' + FACE_RESET;
}

function resolveCompanionFace(rawState, palette, modelFace) {
  try {
    const companion = require('./companion-state.cjs');
    const stdinJson = rawState || {};
    const resolved = companion.resolveExpression(stdinJson);

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

    const face = COMPACT_FACES[resolved.expression] || COMPACT_FACES.neutral;
    const glyphs = face.match(/^\[(.+) (.+)\]$/);
    if (glyphs) return renderGradientFace(glyphs[1], glyphs[2]);
    return colorize(palette, 'accent', face);
  } catch {
    return renderGradientFace('\u2585', '\u2585');
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
  const modelLabel = modelId.includes('fable') ? 'fable' : modelId.includes('opus') ? 'opus' : modelId.includes('sonnet') ? 'sonnet' : modelId.includes('haiku') ? 'haiku' : '';
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

  // Session ID (short)
  const sid = state.session.id || '';
  const sidStr = sid ? colorize(palette, 'muted', sid.slice(0, 8)) : '';

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

  const zoneMap = {
    face:     () => renderFaceZone(state, p),
    context:  () => renderContextZone(state, p),
    health:   () => renderHealthZone(state, p, { detailed: true }),
    caps:     () => renderCapsZone(state, p),
    capabilities: () => renderCapsZone(state, p),
    forge:    () => renderForgeZone(state, p),
    badges:   () => renderBadgesZone(state, p),
    cards:    () => renderCommandCards(state, (state.terminal && state.terminal.cols) || 80),
    session:  () => renderSessionZone(state, p),
    activity: () => renderActivityZone(state, p),
    forgeProgress: () => renderForgeProgressZone(state, p),
    'forge-progress': () => renderForgeProgressZone(state, p),
    gitStatus: () => renderGitStatusZone(state, p),
    'git-status': () => renderGitStatusZone(state, p),
    git: () => renderGitStatusZone(state, p),
  };

  const renderer = zoneMap[zone] || zoneMap.face;
  return renderer().join('\n');
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

  // Face inline
  const { getExpressionName } = require('./hud-expressions.cjs');
  const expr = getExpressionName(state);
  const face = COMPACT_FACES[expr] || COMPACT_FACES.neutral;
  const faceColor = degradedCount > 0 ? 'warn' : 'accent';

  // Health bar (short)
  const barLen = 12;
  const filled = Math.round((score / 100) * barLen);
  const hColor = score >= 75 ? 'ok' : score >= 35 ? 'warn' : 'error';
  const bar = colorize(p, hColor, '\u2550'.repeat(filled)) + colorize(p, 'muted', '\u2500'.repeat(barLen - filled));

  // Event-specific message
  const eventMsg = {
    'commit': 'committed',
    'test-pass': 'all tests green',
    'test-fail': 'tests failed',
    'forge-phase': 'forge phase transition',
    'zone-change': 'zone updated',
    'badge-earned': 'badge earned',
  };
  const msg = eventMsg[event] || '';

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
  const faceStr = resolveCompanionFace(rawState, palette, modelFace);
  const modelId = session.modelId || session.model || '';
  const modelFamily = modelId.includes('fable') ? 'fable' : modelId.includes('opus') ? 'opus' : modelId.includes('sonnet') ? 'sonnet' : modelId.includes('haiku') ? 'haiku' : '';
  // Per-model color (fable bypasses this — it renders via rainbowize below)
  const modelColors = { opus: '\x1b[38;5;117m', sonnet: '\x1b[38;5;75m', haiku: '\x1b[38;5;110m' };  // brightest, bright, medium
  const modelColor = modelColors[modelFamily] || '\x1b[38;5;252m';
  // Extract version: two-part (opus-4-6 → 4.6) or single-part (fable-5 → 5)
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
  // fable → rainbow (flagship signature); all others → their solid spectrum color
  const modelRender = modelFamily === 'fable' ? rainbowize(modelText) : `${modelColor}${modelText}\x1b[0m`;
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
  const outerActive = isSessionActive(engineCwd);
  const freezeTimeMs = outerActive ? null : getFreezeTime(engineCwd);
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
  MODEL_FACE,
  resolveModelFace,
  COMPACT_FACES,
};
