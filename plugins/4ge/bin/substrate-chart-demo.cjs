#!/usr/bin/env node
'use strict';

// Read-only showcase for the substrate chart primitives. Renders each
// primitive over a few sample series so the craft can be judged at a glance.
// The plain-glyph sections render identically on mobile Termius response text
// (braille + block glyphs survive; ANSI does not). The trailing colored
// section is terminal-only — its cold blue/purple ramp only shows under a
// 256-color/truecolor terminal. No side effects; safe to run anytime.
//
//   node plugins/4ge/bin/substrate-chart-demo.cjs           # plain + colored
//   node plugins/4ge/bin/substrate-chart-demo.cjs --plain   # plain only

const {
  blockRamp,
  brailleChart,
  brailleBand,
  sparkline,
  colorizeRamp,
  COLD_RAMP_256,
} = require('../lib/substrate-render.cjs');

const out = (s = '') => process.stdout.write(s + '\n');

// --- Sample series -------------------------------------------------------
const sine = Array.from({ length: 32 }, (_, i) => Math.round(50 + 40 * Math.sin(i / 3)));
const spikes = [4, 5, 4, 6, 5, 22, 6, 5, 4, 5, 18, 5, 4, 6, 5, 4];
const rampUp = Array.from({ length: 24 }, (_, i) => i * i); // quadratic climb
const latency = [42, 38, 45, 51, 120, 47, 43, 210, 55, 48, 44, 46, 90, 43, 41, 45];

function section(title) {
  out();
  out('── ' + title + ' ' + '─'.repeat(Math.max(0, 60 - title.length)));
}

// --- 1. Block ramp (misrender-safe fallback) -----------------------------
section('blockRamp — ▁▂▃▄▅▆▇█ fallback, one glyph per sample');
out('sine    ' + blockRamp(sine));
out('spikes  ' + blockRamp(spikes));
out('rampUp  ' + blockRamp(rampUp));
out('latency ' + blockRamp(latency));

section('blockRamp — resampled to a fixed width (32 samples → 16 glyphs)');
out('sine@16 ' + blockRamp(sine, { width: 16 }));
out('sine@8  ' + blockRamp(sine, { width: 8 }));

// --- 2. Braille sparkline (height 1) -------------------------------------
section('braille sparkline — 2×4 dots/cell, height 1 (existing vs new engine)');
out('sparkline()   ' + sparkline(sine, 16));
out('brailleChart  ' + brailleChart(sine, { width: 16 })[0]);

// --- 3. Braille line chart (multi-row, connected) ------------------------
section('brailleChart line — height 2, connected curve');
brailleChart(sine, { height: 2, width: 32 }).forEach((l) => out('  ' + l));

section('brailleChart line — height 3, latency series');
brailleChart(latency, { height: 3, width: 24 }).forEach((l) => out('  ' + l));

// --- 4. Braille area / density band --------------------------------------
section('brailleBand — area/density band, height 3');
brailleBand(sine, { height: 3, width: 32 }).forEach((l) => out('  ' + l));

section('brailleBand — spikes, height 4');
brailleBand(spikes, { height: 4, width: 16 }).forEach((l) => out('  ' + l));

// --- 5. Colored ramp (terminal-only) -------------------------------------
if (!process.argv.includes('--plain')) {
  section('cold ramp legend (violet→cyan) — terminal-only, 256-color');
  out('  stops ' + COLD_RAMP_256.map((_, i) => colorizeRamp('██', i / (COLD_RAMP_256.length - 1))).join(' '));
  out('  256   ' + COLD_RAMP_256.map((n) => String(n).padStart(2)).join('   '));

  section('colored blockRamp + brailleBand (ramp) — terminal-only');
  out('  ramp  ' + blockRamp(sine, { width: 32, color: 'ramp' }));
  brailleBand(sine, { height: 3, width: 32, color: 'ramp' }).forEach((l) => out('  ' + l));
  out();
  out('(re-run with --plain to omit ANSI for mobile/response-text judgment)');
}
