#!/usr/bin/env node
'use strict';

/**
 * hud-watcher.cjs — Background file-watch loop that keeps a rendered HUD frame
 * current on disk. Other rendering surfaces (tmux pane, Electron, middleware)
 * read the output files instead of re-running the engine.
 *
 * Watches: _runs/os/ for state file changes (health.json, session-meta.json, etc.)
 * Writes:  _runs/os/hud-frame.ansi  (full ANSI render)
 *          _runs/os/hud-frame.txt   (stripped ANSI for debugging)
 *
 * Usage:
 *   node plugins/4ge/bin/hud-watcher.cjs
 *   # Runs until killed (Ctrl+C or SIGTERM)
 *
 * SessionStart hook can spawn detached:
 *   spawn('node', ['plugins/4ge/bin/hud-watcher.cjs'], {
 *     detached: true, stdio: 'ignore', cwd: projectRoot
 *   }).unref();
 */

const fs = require('node:fs');
const path = require('node:path');

// --- Resolve engine paths relative to this file ---
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const STATE_DIR = path.join(PROJECT_ROOT, '_runs', 'os');
const FRAME_ANSI = path.join(STATE_DIR, 'hud-frame.ansi');
const FRAME_TXT = path.join(STATE_DIR, 'hud-frame.txt');

const DATA_LOADER = path.resolve(__dirname, 'hud-data-loader.cjs');
const ENGINE = path.resolve(__dirname, 'hud-engine.cjs');

let loadHudData, renderByMode, stripAnsi;
try {
  loadHudData = require(DATA_LOADER).loadHudData;
  renderByMode = require(ENGINE).renderByMode;
  stripAnsi = require(path.resolve(__dirname, 'hud-palette.cjs')).stripAnsi;
} catch (err) {
  process.stderr.write(`hud-watcher: failed to load engine modules: ${err.message}\n`);
  process.exit(1);
}

// --- Configuration ---
const DEBOUNCE_MS = 300;
const COLS = 100;  // Default canvas width (no real terminal)
const ROWS = 30;   // Default canvas height

// --- State ---
let renderCount = 0;
let debounceTimer = null;
let rendering = false;

/**
 * Load state from disk, render full mode, write output files.
 * Returns render duration in ms.
 */
function renderFrame() {
  if (rendering) return -1; // guard against reentrant calls
  rendering = true;
  const t0 = Date.now();

  try {
    const raw = loadHudData({
      stateDir: STATE_DIR,
      cwd: PROJECT_ROOT,
      runExpensiveProbes: false,
    });

    // Override terminal dimensions since we have no real TTY
    raw.terminal = { cols: COLS, rows: ROWS };

    const ansiOutput = renderByMode(raw, 'full');
    const textOutput = stripAnsi(ansiOutput);

    // Atomic write: tmp + rename to prevent partial reads
    const tmpAnsi = FRAME_ANSI + '.tmp';
    const tmpTxt = FRAME_TXT + '.tmp';

    fs.writeFileSync(tmpAnsi, ansiOutput, 'utf8');
    fs.renameSync(tmpAnsi, FRAME_ANSI);

    fs.writeFileSync(tmpTxt, textOutput, 'utf8');
    fs.renameSync(tmpTxt, FRAME_TXT);

    renderCount++;
    const elapsed = Date.now() - t0;
    return elapsed;
  } catch (err) {
    process.stderr.write(`hud-watcher: render error: ${err.message}\n`);
    return -1;
  } finally {
    rendering = false;
  }
}

/**
 * Debounced render trigger. Coalesces rapid file changes into a single render.
 */
function scheduleRender(reason) {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    const elapsed = renderFrame();
    if (elapsed >= 0) {
      process.stderr.write(
        `hud-watcher: render #${renderCount} in ${elapsed}ms (trigger: ${reason})\n`
      );
    }
  }, DEBOUNCE_MS);
}

// --- Startup ---
process.stderr.write(`hud-watcher: starting, watching ${STATE_DIR}\n`);
process.stderr.write(`hud-watcher: canvas ${COLS}x${ROWS}, debounce ${DEBOUNCE_MS}ms\n`);

// Ensure state dir exists
if (!fs.existsSync(STATE_DIR)) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
}

// Initial render immediately
const initialElapsed = renderFrame();
process.stderr.write(
  `hud-watcher: initial render #${renderCount} in ${initialElapsed}ms\n`
);

// --- File Watcher ---
// fs.watch on the directory. Fires on any file create/modify/delete within _runs/os/.
// We ignore our own output files to prevent feedback loops.
const IGNORE_FILES = new Set(['hud-frame.ansi', 'hud-frame.txt', 'hud-frame.ansi.tmp', 'hud-frame.txt.tmp']);

let watcher;
try {
  watcher = fs.watch(STATE_DIR, { persistent: true }, (eventType, filename) => {
    // Skip our own output files
    if (filename && IGNORE_FILES.has(filename)) return;
    // Skip .tmp files from atomic writes by other processes
    if (filename && filename.endsWith('.tmp')) return;

    scheduleRender(filename || eventType);
  });
} catch (err) {
  process.stderr.write(`hud-watcher: fs.watch failed: ${err.message}\n`);
  process.stderr.write('hud-watcher: falling back to 2s poll interval\n');

  // Fallback: poll every 2 seconds
  setInterval(() => {
    scheduleRender('poll');
  }, 2000);
}

// --- Graceful Shutdown ---
function shutdown(signal) {
  process.stderr.write(`hud-watcher: ${signal} received, ${renderCount} total renders\n`);
  if (watcher) watcher.close();
  if (debounceTimer) clearTimeout(debounceTimer);
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Keep process alive
process.stdin.resume();
