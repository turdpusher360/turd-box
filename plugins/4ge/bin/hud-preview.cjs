#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { renderSurface } = require('./hud-surface-host.cjs');

// --- Arg Parsing ---
const args = process.argv.slice(2);
function getArg(name) {
  const prefix = '--' + name + '=';
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith(prefix)) return args[i].slice(prefix.length);
    if (args[i] === '--' + name && i + 1 < args.length) return args[i + 1];
  }
  return null;
}
function hasFlag(name) { return args.includes('--' + name); }

const colsOverride = getArg('cols');
const rowsOverride = getArg('rows');
const stateFile = getArg('state');
const modeOverride = getArg('mode') || 'full';
const watchMode = hasFlag('watch');
const cycleMode = hasFlag('cycle');

const cols = colsOverride ? parseInt(colsOverride, 10) : (process.stdout.columns || 80);
const rows = rowsOverride ? parseInt(rowsOverride, 10) : (process.stdout.rows || 24);

// --- State Loading ---
function loadState(options = {}) {
  const targetStateFile = Object.prototype.hasOwnProperty.call(options, 'stateFile')
    ? options.stateFile
    : stateFile;
  const mocksDir = path.join(__dirname, 'mocks');
  const target = targetStateFile
    ? (path.isAbsolute(targetStateFile) ? targetStateFile : path.join(process.cwd(), targetStateFile))
    : path.join(mocksDir, 'healthy.json');
  try {
    return JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch (e) {
    process.stderr.write(`[hud-preview] Failed to load state: ${e.message}\n`);
    return null;
  }
}

function renderFrame(options = {}) {
  const mode = options.mode || modeOverride;
  const frameCols = options.cols || cols;
  const frameRows = options.rows || rows;
  const state = loadState(options);
  if (!state) return '(no state loaded)';

  try {
    return renderSurface({
      rawState: state,
      mode,
      terminal: { cols: frameCols, rows: frameRows },
      context: { trigger: 'preview' },
    }).output;
  } catch (e) {
    return `[hud-preview] Render error: ${e.message}`;
  }
}

// --- Display ---
function display(mode, options = {}) {
  const frameCols = options.cols || cols;
  const frameRows = options.rows || rows;
  const targetStateFile = Object.prototype.hasOwnProperty.call(options, 'stateFile')
    ? options.stateFile
    : stateFile;
  const modeLabel = mode.toUpperCase();
  const dimLabel = `${frameCols}x${frameRows}`;
  const stateLabel = targetStateFile || 'healthy.json';

  // Clear screen
  process.stdout.write('\x1b[2J\x1b[H');

  // Frame header
  process.stdout.write(`\x1b[90m--- HUD Preview | mode=${modeLabel} | ${dimLabel} | state=${stateLabel} ---\x1b[0m\n\n`);

  // Render engine output
  const output = renderFrame({
    mode,
    stateFile: targetStateFile,
    cols: frameCols,
    rows: frameRows,
  });
  process.stdout.write(output);

  process.stdout.write(`\n\n\x1b[90m--- end (${new Date().toLocaleTimeString()}) ---\x1b[0m\n`);
}

// --- Cycle Mode ---
function runCycle() {
  const modes = ['strip', 'full'];
  const sizes = [
    { cols: 48, rows: 28, label: 'phone' },
    { cols: 80, rows: 24, label: 'standard' },
    { cols: 200, rows: 50, label: 'ultrawide' },
  ];

  for (const size of sizes) {
    for (const mode of modes) {
      process.stdout.write('\x1b[2J\x1b[H');
      process.stdout.write(`\x1b[90m--- CYCLE: ${size.label} (${size.cols}x${size.rows}) mode=${mode} ---\x1b[0m\n\n`);
      process.stdout.write(renderFrame({
        mode,
        stateFile,
        cols: size.cols,
        rows: size.rows,
      }));
      process.stdout.write(`\n\x1b[90m--- end ---\x1b[0m\n`);

      // Pause 2s between frames
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
    }
  }
}

// --- Main ---
function main() {
  if (cycleMode) {
    runCycle();
  } else if (watchMode) {
    display(modeOverride);

    // Watch engine source files for changes
    const watchTargets = [
      path.join(__dirname, 'hud-engine.cjs'),
      path.join(__dirname, 'hud-palette.cjs'),
      path.join(__dirname, 'hud-state.cjs'),
      path.join(__dirname, 'hud-canvas.cjs'),
      path.join(__dirname, 'hud-zone-face.cjs'),
      path.join(__dirname, 'hud-zone-health.cjs'),
    ];

    const debounceMs = 300;
    let timer = null;

    for (const target of watchTargets) {
      try {
        fs.watch(target, () => {
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => display(modeOverride), debounceMs);
        });
      } catch {
        // File may not exist yet — skip silently
      }
    }

    process.stdout.write('\x1b[90mWatching for changes... (Ctrl+C to exit)\x1b[0m\n');
  } else {
    display(modeOverride);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  loadState,
  renderFrame,
  display,
  runCycle,
  usesSurfaceHost: true,
};
