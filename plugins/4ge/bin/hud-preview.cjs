#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

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
function loadState() {
  const mocksDir = path.join(__dirname, 'mocks');
  const target = stateFile
    ? (path.isAbsolute(stateFile) ? stateFile : path.join(process.cwd(), stateFile))
    : path.join(mocksDir, 'healthy.json');
  try {
    return JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch (e) {
    process.stderr.write(`[hud-preview] Failed to load state: ${e.message}\n`);
    return null;
  }
}

// --- Engine Invocation ---
const ENGINE_PATH = path.join(__dirname, 'hud-engine.cjs');

function renderFrame(mode) {
  const state = loadState();
  if (!state) return '(no state loaded)';

  // Inject terminal dimensions into state
  state.terminal = { cols, rows };
  state.context = state.context || {};
  state.context.trigger = 'preview';

  try {
    const input = JSON.stringify(state);
    const result = execSync(
      `node "${ENGINE_PATH}" --mode=${mode} --cols=${cols} --rows=${rows}`,
      { input, encoding: 'utf8', timeout: 5000, env: { ...process.env, COLUMNS: String(cols), LINES: String(rows) } }
    );
    return result;
  } catch (e) {
    return `[hud-preview] Engine error: ${e.message}`;
  }
}

// --- Display ---
function display(mode) {
  const modeLabel = mode.toUpperCase();
  const dimLabel = `${cols}x${rows}`;
  const stateLabel = stateFile || 'healthy.json';

  // Clear screen
  process.stdout.write('\x1b[2J\x1b[H');

  // Frame header
  process.stdout.write(`\x1b[90m--- HUD Preview | mode=${modeLabel} | ${dimLabel} | state=${stateLabel} ---\x1b[0m\n\n`);

  // Render engine output
  const output = renderFrame(mode);
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
      const state = loadState();
      if (state) {
        state.terminal = { cols: size.cols, rows: size.rows };
        state.context = state.context || {};
        state.context.trigger = 'preview';
        try {
          const input = JSON.stringify(state);
          const result = execSync(
            `node "${ENGINE_PATH}" --mode=${mode} --cols=${size.cols} --rows=${size.rows}`,
            { input, encoding: 'utf8', timeout: 5000, env: { ...process.env, COLUMNS: String(size.cols), LINES: String(size.rows) } }
          );
          process.stdout.write(result);
        } catch (e) {
          process.stdout.write(`[error] ${e.message}\n`);
        }
      }
      process.stdout.write(`\n\x1b[90m--- end ---\x1b[0m\n`);

      // Pause 2s between frames
      execSync('sleep 2 || timeout /t 2 >nul 2>&1', { stdio: 'ignore' });
    }
  }
}

// --- Main ---
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
