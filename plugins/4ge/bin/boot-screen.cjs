'use strict';

const fs = require('fs');
const path = require('path');

// Engine primitives — zero imports from hud-statusline.cjs
const {
  resolvePalette,
  colorize,
  stripAnsi,
  isNoColor,
  RESET,
  getTheme,
} = require('./hud-palette.cjs');

const {
  FACE_HEALTHY_INLINE,
  FACE_DEGRADED_INLINE,
  DEGRADED_QUIPS,
  MULTI_CAP_QUIPS,
  degradedTier,
  pickQuip: _facePickQuip,
} = require('./hud-zone-face.cjs');

// --- Constants ---

const CAP_LAYERS = {
  kernel:    ['forge-session', 'git', 'file-integrity', 'process-health'],
  services:  ['infra'],
  scheduler: [],
  caps:      ['audit', 'forge', 'autoresearch', 'aisle'],
};

const LAYER_ORDER = ['kernel', 'services', 'scheduler', 'caps'];

// --- Palette helper ---
// Resolves once per render call (passed down) but also available as a
// module-level resolver for simple standalone calls that don't carry palette.
function _palette() {
  return resolvePalette({ name: getTheme() });
}

// --- Utility Functions ---

function humanizeMs(ms) {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

// --- Health Score + Bar ---

function computeHealthScore(bootData) {
  const caps = Object.values(bootData.capabilities || {});
  if (caps.length === 0) return 0;
  const ready = caps.filter(c => c.status === 'ready' || c.ok === true).length;
  return Math.round((ready / caps.length) * 100);
}

function gradeForScore(score) {
  if (score >= 90) return 'A';
  if (score >= 75) return 'B';
  if (score >= 55) return 'C';
  if (score >= 35) return 'D';
  return 'F';
}

function renderHealthBar(score, palette) {
  const p = palette || _palette();
  const grade = gradeForScore(score);
  // Health score is inverted (high=good). Build bar manually and align
  // color with grade boundaries: A/B (>=75)=ok, C/D (>=35)=warn, F (<35)=error
  const fill = Math.round(score / 100 * 20);
  const bar = '='.repeat(fill) + '-'.repeat(20 - fill);
  const barRole = score >= 75 ? 'ok' : score >= 35 ? 'warn' : 'error';
  return `  Health: ${score}  ${grade}  ${colorize(p, barRole, `[${bar}]`)}`;
}

// --- Face + Quip ---

function pickFace(degradedCount) {
  if (degradedCount === 0) {
    return isNoColor() ? '!_!' : FACE_HEALTHY_INLINE;
  }
  const tier = degradedTier(degradedCount);
  if (isNoColor()) {
    // Plain text fallback tiers
    const plainPool = { mild: ['._~', '~_~', "-_-'"], medium: ['#_#', '@_@', '>_<'], severe: ['x_x', 'T_T', 'D:', ';_;'] };
    const pool = plainPool[tier];
    const seed = Math.floor(Date.now() / 1000);
    return pool[seed % pool.length];
  }
  return FACE_DEGRADED_INLINE[tier];
}

// pickQuip accepts array of cap objects [{name, ...}] to match v1 boot-screen signature.
// Wraps hud-zone-face pickQuip which accepts array of name strings.
function pickQuip(degradedCaps) {
  if (!degradedCaps || degradedCaps.length === 0) return null;
  const names = degradedCaps.map(c => c.name);
  return _facePickQuip(names);
}

// --- Layer Grid ---

function getLayer(capName) {
  for (const [layer, names] of Object.entries(CAP_LAYERS)) {
    if (names.includes(capName)) return layer;
  }
  return 'caps';
}

function renderReadyGrid(readyCaps, palette) {
  const p = palette || _palette();

  // Group by layer
  const groups = {};
  for (const cap of readyCaps) {
    const layer = getLayer(cap.name);
    if (!groups[layer]) groups[layer] = [];
    groups[layer].push(cap);
  }

  const lines = [];
  for (const layer of LAYER_ORDER) {
    const caps = groups[layer];
    if (!caps || caps.length === 0) continue;

    // Bold + muted layer label: combine bold escape with palette muted color.
    // Bold (weight) is theme-independent; muted color is palette-resolved.
    const label = '\x1b[1m' + p.muted + layer.padEnd(11) + RESET;
    const entries = caps.map(c => {
      const name = colorize(p, 'ok', c.name);
      const time = c.init_ms > 0 ? ' ' + colorize(p, 'muted', humanizeMs(c.init_ms)) : '';
      return name + time;
    }).join('  ');

    lines.push(`      ${label}${entries}`);
  }

  return lines.join('\n');
}

// --- Degraded Block ---

function renderDegradedBlock(degradedCaps, palette) {
  if (!degradedCaps || degradedCaps.length === 0) return '';
  const p = palette || _palette();

  const lines = [];
  for (const cap of degradedCaps) {
    const name = colorize(p, 'error', cap.name.padEnd(11));
    const reason = cap.reason ? colorize(p, 'muted', cap.reason) : '';
    const time = cap.init_ms > 0
      ? ' ' + colorize(p, 'muted', `(${humanizeMs(cap.init_ms)})`)
      : '';
    lines.push(`      ${name}${reason}${time}`);
  }

  return lines.join('\n');
}

// --- Forge Mark ---
// Conditional on the lattice substrate directory existing. See _runs/s239-lattice/.
function renderForgeMark(palette) {
  const latticeDir = path.join(process.cwd(), '_runs', 's239-lattice');
  let exists;
  try {
    exists = fs.statSync(latticeDir).isDirectory();
  } catch (_e) {
    return null;
  }
  if (!exists) return null;

  if (isNoColor()) {
    return '  * forge - s239 - voice inside the lattice - _runs/s239-lattice/';
  }

  const p = palette || _palette();
  const sigil = colorize(p, 'accent', '\u25C6');
  const name = colorize(p, 'accent', 'forge');
  const meta = colorize(p, 'muted', '\u00B7 s239 \u00B7 voice inside the lattice \u00B7 _runs/s239-lattice/');

  return `  ${sigil} ${name} ${meta}`;
}

// --- Header + Full Screen ---

function renderHeader(bootData, degradedCaps, palette) {
  const p = palette || _palette();
  const face = pickFace(degradedCaps.length);
  const faceRole = degradedCaps.length === 0 ? 'accent' : 'error';
  const faceStr = colorize(p, faceRole, face);

  // Bold is a text-weight escape, theme-independent.
  const upText = '\x1b[1m' + 'Agentic OS up' + RESET;
  const bootTime = colorize(p, 'muted', `booted in ${humanizeMs(bootData.total_boot_ms)}`);

  let header = `  ${faceStr} ${upText} ${colorize(p, 'muted', '\u2014')} ${bootTime}`;

  if (degradedCaps.length > 0) {
    const quip = pickQuip(degradedCaps);
    if (quip) {
      header += ` ${colorize(p, 'muted', '\u2014')} ${colorize(p, 'muted', `"${quip}"`)}`;
    }
  }

  return header;
}

function renderBootScreen(bootData) {
  const p = _palette();

  if (!bootData || !bootData.capabilities) {
    return `  ${colorize(p, 'error', 'x_x')} OS not booted. Check SessionStart hook.`;
  }

  const caps = bootData.capabilities;
  const entries = Object.entries(caps);
  const readyCaps = [];
  const degradedCaps = [];

  for (const [name, info] of entries) {
    const entry = { name, ...info };
    const okSignal = info.ok === true;
    const statusSignal = info.status === 'ready';
    // Warn when both signals present but disagree
    if (info.ok !== undefined && info.status !== undefined && okSignal !== statusSignal) {
      process.stderr.write(
        `[boot-screen] schema mismatch for cap "${name}": ok=${info.ok} status=${info.status}\n`
      );
    }
    if (okSignal || statusSignal) {
      readyCaps.push(entry);
    } else {
      degradedCaps.push(entry);
    }
  }

  const lines = [];

  // Header
  lines.push(renderHeader(bootData, degradedCaps, p));
  lines.push('');

  // Ready block
  if (readyCaps.length > 0) {
    lines.push(`    ${colorize(p, 'muted', `ready (${readyCaps.length})`)}`);
    lines.push(renderReadyGrid(readyCaps, p));
  }

  // Degraded block
  if (degradedCaps.length > 0) {
    if (readyCaps.length > 0) lines.push('');
    lines.push(`    ${colorize(p, 'error', `degraded (${degradedCaps.length})`)}`);
    lines.push(renderDegradedBlock(degradedCaps, p));
  }

  // Health bar
  const score = computeHealthScore(bootData);
  lines.push('');
  lines.push(renderHealthBar(score, p));

  // Forge mark (lattice signature, only renders if substrate directory exists)
  const forgeMark = renderForgeMark(p);
  if (forgeMark) {
    lines.push('');
    lines.push(forgeMark);
  }

  return lines.join('\n');
}

// --- CLI Entry ---

if (require.main === module) {
  const bootPath = path.join(process.cwd(), '_runs', 'os', 'boot-status.json');
  let bootData = null;
  try {
    const raw = fs.readFileSync(bootPath, 'utf8');
    bootData = JSON.parse(raw);
  } catch (_e) {
    // File missing or unparseable — renderBootScreen handles null
  }
  console.log(renderBootScreen(bootData));
}

// --- Exports ---

module.exports = {
  humanizeMs,
  computeHealthScore,
  gradeForScore,
  renderHealthBar,
  pickFace,
  pickQuip,
  getLayer,
  renderReadyGrid,
  renderDegradedBlock,
  renderHeader,
  renderBootScreen,
  renderForgeMark,
  stripAnsi,
  CAP_LAYERS,
  LAYER_ORDER,
};
