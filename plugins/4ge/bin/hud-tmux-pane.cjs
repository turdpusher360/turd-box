#!/usr/bin/env node
'use strict';

// hud-tmux-pane.cjs — Option C prototype
//
// A standalone Node process designed to run in a tmux split pane.
// Watches _runs/os/ for state changes, renders the full HUD scene
// on every change. The tmux pane IS the output surface.
//
// Usage:
//   node plugins/4ge/bin/hud-tmux-pane.cjs [--state-dir PATH] [--theme NAME]
//
// The process clears the pane on start, renders once, then enters
// a watch loop. Ctrl+C to exit. Handles SIGWINCH for resize.

const fs = require('node:fs');
const path = require('node:path');
const { loadSurfaceState, renderSurface } = require('./hud-surface-host.cjs');

// --- Resolve project root (walk up from bin/) ---
const BIN_DIR = __dirname;
const PLUGIN_DIR = path.resolve(BIN_DIR, '..');
const PROJECT_ROOT = path.resolve(PLUGIN_DIR, '..', '..');

// --- Parse CLI args ---
const args = process.argv.slice(2);
let stateDir = path.join(PROJECT_ROOT, '_runs', 'os');
let themeName = null;
let refreshMs = 300;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--state-dir' && i + 1 < args.length) {
    stateDir = path.resolve(args[++i]);
  } else if (args[i].startsWith('--state-dir=')) {
    stateDir = path.resolve(args[i].split('=').slice(1).join('='));
  } else if (args[i] === '--theme' && i + 1 < args.length) {
    themeName = args[++i];
  } else if (args[i].startsWith('--theme=')) {
    themeName = args[i].split('=').slice(1).join('=');
  } else if (args[i] === '--refresh' && i + 1 < args.length) {
    refreshMs = parseInt(args[++i], 10) || 300;
  } else if (args[i].startsWith('--refresh=')) {
    refreshMs = parseInt(args[i].split('=').slice(1).join('='), 10) || 300;
  }
}

// --- ANSI helpers ---
const ESC = '\x1b';
const CLEAR_SCREEN = `${ESC}[2J${ESC}[H`;
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;

// --- Load HUD modules (resilient — prototype may run before all modules exist) ---
let resolvePalette, colorize, getTheme, setTheme;

try {
  const palette = require(path.join(BIN_DIR, 'hud-palette.cjs'));
  resolvePalette = palette.resolvePalette;
  colorize = palette.colorize;
  getTheme = palette.getTheme;
  setTheme = palette.setTheme;
} catch {
  // Fallback: plain text
  resolvePalette = () => ({ ok: '', warn: '', error: '', accent: '', muted: '', text: '', glow: '', bg: '', reset: '' });
  colorize = (_p, _r, t) => t;
  getTheme = () => 'plain';
  setTheme = () => false;
}

// --- Ensure state directory exists ---
function ensureStateDir() {
  try {
    if (!fs.existsSync(stateDir)) {
      fs.mkdirSync(stateDir, { recursive: true });
    }
    return true;
  } catch {
    return false;
  }
}

// --- Seed demo state files if empty ---
function seedDemoState() {
  const healthPath = path.join(stateDir, 'health.json');
  const bootPath = path.join(stateDir, 'boot-status.json');
  const metaPath = path.join(stateDir, 'session-meta.json');

  if (!fs.existsSync(healthPath)) {
    const health = {
      memory: { ok: true, reason: 'hub responding' },
      git: { ok: true, reason: 'repo clean' },
      forge: { ok: true, reason: 'idle' },
      audit: { ok: true, reason: 'ready' },
      aisle: { ok: true, reason: 'posture ready' },
      infra: { ok: false, reason: 'docker not running' },
    };
    fs.writeFileSync(healthPath, JSON.stringify(health, null, 2));
  }

  if (!fs.existsSync(bootPath)) {
    const boot = {
      session_id: 'tmux-proto-001',
      booted_at: new Date().toISOString(),
      total_boot_ms: 142,
      capabilities: {
        memory: { status: 'ready', init_ms: 12 },
        git: { status: 'ready', init_ms: 8 },
        forge: { status: 'ready', init_ms: 45 },
        audit: { status: 'ready', init_ms: 22 },
        aisle: { status: 'ready', init_ms: 31 },
        infra: { status: 'degraded', init_ms: 0, reason: 'docker not running' },
      },
    };
    fs.writeFileSync(bootPath, JSON.stringify(boot, null, 2));
  }

  if (!fs.existsSync(metaPath)) {
    const meta = {
      session_id: 'tmux-proto-001',
      model: 'opus-4.6',
      est_context_pct: 12,
      tool_count_running: 0,
    };
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  }
}

// --- Build state from disk ---
function buildState(options = {}) {
  const targetStateDir = options.stateDir || stateDir;
  const targetProjectRoot = options.projectRoot || PROJECT_ROOT;
  const terminal = options.terminal || {
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
  };

  try {
    return loadSurfaceState({
      projectRoot: targetProjectRoot,
      stateDir: targetStateDir,
      terminal,
      context: { trigger: 'tmux-pane', event: null, zone: null },
      runExpensiveProbes: false,
    });
  } catch {
    // Fall through to manual JSON fallback.
  }

  // Fallback: manual JSON reads
  const readJson = (name) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(targetStateDir, name), 'utf8'));
    } catch {
      return {};
    }
  };

  return {
    projectRoot: targetProjectRoot,
    terminal,
    session: { id: 'tmux', model: 'unknown', contextPct: 0, uptime: 0, toolCount: 0, rateLimits: 'N/A', contextLabel: '' },
    os: { overallHealth: 'unknown', bootTime: 0, capabilities: {} },
    forge: { active: false, phase: null, teammates: [], scope: null },
    context: { trigger: 'tmux-pane', event: null, zone: null },
    badges: {},
    memory: {},
    health: readJson('health.json'),
    bootStatus: readJson('boot-status.json'),
  };
}

// --- Render the menu bar at the bottom ---
function renderMenu(palette) {
  const items = [
    { key: '1', label: 'Health' },
    { key: '2', label: 'Caps' },
    { key: '3', label: 'Forge' },
    { key: '4', label: 'Badges' },
    { key: '5', label: 'Theme' },
    { key: 'q', label: 'Quit' },
  ];

  const parts = items.map(item => {
    const keyStr = colorize(palette, 'accent', `[${item.key}]`);
    const labelStr = colorize(palette, 'text', item.label);
    return `${keyStr} ${labelStr}`;
  });

  const separator = colorize(palette, 'muted', ' \u2502 ');
  return '  ' + parts.join(separator);
}

// --- Render the full scene ---
function renderScene(options = {}) {
  const state = buildState(options);
  const palette = resolvePalette({ name: options.themeName || themeName || getTheme() });
  const cols = state.terminal.cols;

  let output = '';

  // Main HUD content
  try {
    output = renderSurface({ rawState: state, mode: 'full' }).output;
  } catch {
    // Fallback: minimal rendering
    const health = state.health || {};
    output += colorize(palette, 'accent', '  Agentic OS') + colorize(palette, 'muted', ' \u00B7 tmux pane') + '\n';
    output += colorize(palette, 'muted', '  \u2500'.repeat(Math.min(cols - 4, 60))) + '\n';

    for (const [name, h] of Object.entries(health)) {
      const ok = h && h.ok;
      const icon = ok ? colorize(palette, 'ok', '\u2713') : colorize(palette, 'error', '\u2717');
      const reason = (h && h.reason) ? colorize(palette, 'muted', ` (${h.reason})`) : '';
      output += `  ${icon} ${colorize(palette, 'text', name)}${reason}\n`;
    }
  }

  // Bottom bar: timestamp + menu
  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const timestamp = colorize(palette, 'muted', `  last render: ${timeStr}`);
  const menu = renderMenu(palette);
  const divider = colorize(palette, 'muted', '  ' + '\u2500'.repeat(Math.min(cols - 4, 72)));

  return output + '\n' + divider + '\n' + timestamp + '\n' + menu;
}

function redraw() {
  const scene = renderScene();
  process.stdout.write(CLEAR_SCREEN + scene + '\n');
}

// --- Debounced file watcher ---
let debounceTimer = null;

function scheduleRedraw() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    redraw();
  }, refreshMs);
}

// --- Watch state directory ---
let watcher = null;

function startWatching() {
  if (!fs.existsSync(stateDir)) return;

  try {
    watcher = fs.watch(stateDir, { persistent: true }, (eventType, filename) => {
      // Only re-render for JSON state files
      if (filename && filename.endsWith('.json')) {
        scheduleRedraw();
      }
    });

    watcher.on('error', (err) => {
      // fs.watch can be flaky — just log to stderr and keep running
      process.stderr.write(`[hud-tmux] watcher error: ${err.message}\n`);
    });
  } catch (err) {
    process.stderr.write(`[hud-tmux] watch failed: ${err.message}\n`);
  }
}

// --- Handle keyboard input ---
function setupKeyboard() {
  if (!process.stdin.isTTY) return;

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');

  process.stdin.on('data', (key) => {
    // Ctrl+C or 'q' to quit
    if (key === '\x03' || key === 'q' || key === 'Q') {
      shutdown();
      return;
    }

    switch (key) {
      case '1': // Health zone
      case '2': // Caps zone
      case '3': // Forge zone
      case '4': // Badges zone
        // Re-render with zone focus (future: zoom into zone)
        redraw();
        break;

      case '5': { // Cycle theme
        const themes = ['forge', 'dark-ansi', 'tokyonight-dark', 'catppuccin-mocha', 'dracula', 'nord'];
        const current = themeName || getTheme();
        const idx = themes.indexOf(current);
        const next = themes[(idx + 1) % themes.length];
        themeName = next;
        if (setTheme) setTheme(next);
        redraw();
        break;
      }

      case 'r': // Force refresh
        redraw();
        break;
    }
  });
}

// --- Graceful shutdown ---
function shutdown() {
  process.stdout.write(SHOW_CURSOR);
  if (watcher) {
    watcher.close();
    watcher = null;
  }
  process.exit(0);
}

// --- Startup banner ---
function printStartupBanner() {
  const palette = resolvePalette({ name: themeName || getTheme() });
  const banner = [
    '',
    colorize(palette, 'accent', '  \u25C6 HUD Tmux Pane') + colorize(palette, 'muted', ' \u00B7 Option C prototype'),
    colorize(palette, 'muted', `  Watching: ${stateDir}`),
    colorize(palette, 'muted', `  Refresh: ${refreshMs}ms debounce`),
    colorize(palette, 'muted', `  Theme: ${themeName || getTheme()}`),
    '',
  ];
  process.stdout.write(CLEAR_SCREEN + HIDE_CURSOR + banner.join('\n') + '\n');
}

// --- Main ---
function main() {
  process.stdout.on('resize', () => {
    scheduleRedraw();
  });
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  ensureStateDir();
  seedDemoState();
  printStartupBanner();

  // Brief pause to show banner, then render
  setTimeout(() => {
    redraw();
    startWatching();
    setupKeyboard();
  }, 400);
}

if (require.main === module) {
  main();
}

module.exports = {
  buildState,
  renderScene,
  renderMenu,
  ensureStateDir,
  seedDemoState,
  usesSurfaceHost: true,
};
