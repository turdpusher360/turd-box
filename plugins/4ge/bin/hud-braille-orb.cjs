'use strict';

// 3D braille body renderer for HUD statusline.
// Wireframe globe projected at fixed angle, breathing via radius scale.
// Range of motion: contracted/spikey (breathed in) ↔ slightly wider (breathed out).
// 3 chars wide × 2 rows tall (6×8 pixels).

const { loadCompanionConfig } = require('./companion-config.cjs');
function _cc() { return loadCompanionConfig(); }

const TWO_PI = 2 * Math.PI;

const DOT_BITS = [
  [0x01, 0x02, 0x04, 0x40],
  [0x08, 0x10, 0x20, 0x80],
];

function generateWireframe(nMeridians, nParallels, pointsPerLine) {
  const points = [];
  const tags = [];

  for (let m = 0; m < nMeridians; m++) {
    const lon = (m / nMeridians) * TWO_PI;
    for (let i = 0; i <= pointsPerLine; i++) {
      const lat = (i / pointsPerLine) * Math.PI;
      points.push([
        Math.sin(lat) * Math.cos(lon),
        Math.cos(lat),
        Math.sin(lat) * Math.sin(lon),
      ]);
      tags.push('meridian');
    }
  }

  for (let p = 1; p <= nParallels; p++) {
    const lat = (p / (nParallels + 1)) * Math.PI;
    for (let i = 0; i <= pointsPerLine; i++) {
      const lon = (i / pointsPerLine) * TWO_PI;
      points.push([
        Math.sin(lat) * Math.cos(lon),
        Math.cos(lat),
        Math.sin(lat) * Math.sin(lon),
      ]);
      tags.push('parallel');
    }
  }

  for (let i = 0; i <= pointsPerLine * 2; i++) {
    const t = (i / (pointsPerLine * 2)) * TWO_PI;
    points.push([Math.cos(t), Math.sin(t), 0]);
    tags.push('outline');
  }

  return { points, tags };
}

const WIREFRAME = generateWireframe(7, 3, 20);

function rotateY(p, a) {
  const c = Math.cos(a), s = Math.sin(a);
  return [p[0] * c + p[2] * s, p[1], -p[0] * s + p[2] * c];
}

function easeInOutSine(t) {
  return -(Math.cos(Math.PI * t) - 1) / 2;
}

const BREATH_PERIODS = {
  'tool-running': 2000,
  'thinking':     2000,
  'idle':         4000,
  'long-idle':    6000,
  'context-warn': 8000,
  'error':        1000,
  'tests-fail':   1000,
};

function getBreathPeriod(companionState) {
  if (!companionState) return 4000;
  const key = companionState.stateKey || 'idle';
  return BREATH_PERIODS[key] || 4000;
}

function plotPixel(cells, px, py, gridW, gridH) {
  if (px < 0 || px >= gridW || py < 0 || py >= gridH) return;
  const cellCol = Math.floor(px / 2);
  const cellRow = Math.floor(py / 4);
  const dotCol = px % 2;
  const dotRow = py % 4;
  cells[cellRow * 3 + cellCol] |= DOT_BITS[dotCol][dotRow];
}

// Breath range: contracted (spikey, breathed in) ↔ body form (breathed out).
// Maps to breathScale 0.65 (spikey/contracted) to 0.85 (body/filled).
// Eased sine for smooth motion. More frames in the cycle for fluidity.
function renderOrb(healthPct, opts) {
  opts = opts || {};
  const period = opts.period || getBreathPeriod(opts.companionState);

  // Compute active state at function scope — used by breathing AND shimmer.
  const stateKey = (opts.companionState && opts.companionState.stateKey) || 'idle';
  const isActive = stateKey === 'tool-running' || stateKey === 'thinking'
                || stateKey === 'error' || stateKey === 'tests-fail';

  // Time reference for animations: live Date.now() when session-active;
  // freeze timestamp when session-idle (captured by Stop hook → orb holds the
  // pose it was on); null when idle-without-freeze (pre-first-hook session
  // start) → falls back to rest scale for stability.
  const timeMs = (opts.outerActive === false)
    ? (opts.freezeTimeMs ?? null)
    : Date.now();

  let breathScale;
  if (opts.breathScale != null) {
    breathScale = opts.breathScale;
  } else if (isActive) {
    // Active: breathed in — big, spikey. Holds at contracted scale.
    breathScale = 0.65;
  } else if (timeMs == null) {
    // Idle with no freeze time — rest pose for stable output
    breathScale = _cc().breathScaleMin;
  } else {
    // Breath curve sampled at timeMs. Active → animates (Date.now());
    // idle → stable (timeMs is a fixed past moment, phase is deterministic).
    const breathPeriod = period === -1 ? 1500 : Math.max(period * 0.6, 2000);
    const t = (timeMs % breathPeriod) / breathPeriod;
    const eased = easeInOutSine(t);
    breathScale = _cc().breathScaleMin + eased * (_cc().breathScaleMax - _cc().breathScaleMin);
  }

  const a = opts.angle != null ? opts.angle : 0;
  const gridW = 6;
  const gridH = 8;
  const cells = new Uint8Array(6);

  const { points, tags } = WIREFRAME;
  const hp = healthPct / 100;

  for (let i = 0; i < points.length; i++) {
    const tag = tags[i];
    if (tag === 'parallel' && hp < 0.75) continue;
    if (tag === 'meridian' && hp < 0.35) continue;
    // hp===0 means no OS data (not "0% health") — render outline as dormant silhouette
    if (tag === 'outline' && hp < 0.1 && hp > 0) continue;

    if (hp < 0.5 && tag === 'meridian') {
      const pointHash = ((i * 2654435761) >>> 0) / 4294967296;
      if (pointHash > hp * 2) continue;
    }

    const rotated = rotateY(points[i], a);

    if (tag !== 'outline' && rotated[2] < -0.05) continue;

    // Enhanced spikes at contraction: scale Y more than X when contracted.
    const spikeEnhance = breathScale < 0.75 ? 1.0 + (0.75 - breathScale) * 1.5 : 1.0;
    const sx = rotated[0] * breathScale;
    const sy = rotated[1] * breathScale * spikeEnhance;
    let px = Math.round((sx + 1) / 2 * (gridW - 1));
    const py = Math.round((1 - (sy + 1) / 2) * (gridH - 1));

    // At idle scale (>0.75): clamp bottom-row X inward to kill "gun hands".
    // Bottom row = py >= 4. Pull edge pixels toward center.
    if (breathScale >= 0.75 && py >= 4) {
      if (px <= 0) px = 1;
      if (px >= 5) px = 4;
    }

    plotPixel(cells, px, py, gridW, gridH);
  }

  if (isActive) {
    // No shape changes during active — color cycling handles the motion.
    // See renderColoredOrb for the color wave.
  } else if (timeMs != null) {
    // Shimmer: randomly toggle 1-2 dots per frame for a digital/wispy feel.
    // Seeded by timeMs — active uses Date.now() (animated); idle uses freeze
    // time (stable, preserves pose from moment of going idle).
    // Configurable: companion.shimmer (default true)
    if (_cc().shimmer) {
      const shimmerSeed = timeMs;
      for (let c = 0; c < 6; c++) {
        if (cells[c] === 0) continue;
        const dotBit = 1 << ((shimmerSeed + c * 7) % 8);
        if ((shimmerSeed >> (c + 3)) & 1) {
          cells[c] ^= dotBit;
        }
      }
    }
  }

  let row0 = '';
  for (let i = 0; i < 3; i++) row0 += String.fromCharCode(0x2800 + cells[i]);
  let row1 = '';
  for (let i = 3; i < 6; i++) row1 += String.fromCharCode(0x2800 + cells[i]);

  return [row0, row1];
}

function renderColoredOrb(healthPct, opts) {
  const lines = renderOrb(healthPct, opts);
  const rst = '\x1b[0m';
  const stateKey = (opts && opts.companionState && opts.companionState.stateKey) || 'idle';
  const isActive = stateKey === 'tool-running' || stateKey === 'thinking'
                || stateKey === 'error' || stateKey === 'tests-fail';

  if (healthPct >= 75) {
    const cfg = _cc();
    const topChars = [...lines[0]];
    const botChars = [...lines[1]];

    // During active: color wave sweeps through all 6 cells using only B(39) and P(63).
    // 12-frame cycle: cells flip B↔P one at a time (6 frames to flip all, 6 to flip back).
    // Creates a visible diagonal cascade, not a simultaneous swap.
    // Freeze gate (mobile-freeze): the color wave is a live Date.now() animation. When the
    // statusline is frozen (animate:false or idle-freeze → opts.outerActive===false),
    // skip the wave and fall through to the static idle palette so two consecutive
    // renders are byte-identical (mobile Termius freeze invariant, vocabulary Entry 5).
    // renderOrb already freezes shape+shimmer via freezeTimeMs; the color layer
    // previously bypassed the gate (Entry 3), which is the mobile scroll-bounce source.
    const waveActive = isActive && !(opts && opts.outerActive === false);
    const allColors = waveActive
      ? (() => {
          const base = [39, 63, 39, 63, 39, 63]; // starting pattern
          const tick = Math.floor(Date.now() / _cc().colorWaveSpeed) % _cc().colorWaveFrames;
          const colors = [...base];
          // First half (0-5): flip cells 0→5 one by one
          // Second half (6-11): flip them back
          const half = Math.floor(_cc().colorWaveFrames / 2);
          const flipping = tick < half ? tick + 1 : _cc().colorWaveFrames - tick;
          for (let c = 0; c < flipping; c++) {
            colors[c] = colors[c] === 39 ? 63 : 39; // toggle
          }
          return colors;
        })()
      : [...cfg.colorTop, ...cfg.colorBot];

    let top = '';
    for (let i = 0; i < topChars.length; i++) {
      top += `\x1b[38;5;${allColors[i]}m${topChars[i]}`;
    }
    let bot = '';
    for (let i = 0; i < botChars.length; i++) {
      bot += `\x1b[38;5;${allColors[3 + i]}m${botChars[i]}`;
    }
    return [top + rst, bot + rst];
  }

  const color = healthPct >= 35 ? '\x1b[38;5;172m' : '\x1b[38;5;167m';
  return [
    color + lines[0] + rst,
    color + lines[1] + rst,
  ];
}

module.exports = { renderOrb, renderColoredOrb, WIREFRAME, getBreathPeriod, easeInOutSine };
