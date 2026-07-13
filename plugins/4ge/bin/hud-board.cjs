#!/usr/bin/env node
'use strict';

// hud-board.cjs — the lead's write path for the statusline board.
//
//   hud-board set --title "R2 backup" --line "ok:live upload verified" \
//                 --line "warn:secret-redact defect queued" [--ttl 900] [--priority 7]
//   hud-board clear
//   hud-board show     # ANSI render to stdout for verification
//
// Writes to <CLAUDE_PROJECT_DIR||cwd>/_runs/os/hud-board.json — the SAME stateDir
// hud-data-loader.cjs reads for the live statusline. Levels: info|ok|warn|alert|accent.

const path = require('node:path');
const store = require('../lib/hud-board-store.cjs');
const { resolvePalette, getTheme } = require('./hud-palette.cjs');
const { renderBoardZone } = require('./hud-zone-board.cjs');

function resolveStateDir() {
  const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  return path.join(root, '_runs', 'os');
}

function out(s) { process.stdout.write(String(s) + '\n'); }
function err(s) { process.stderr.write(String(s) + '\n'); }

// "level:text" — split on the first ':'. A known level prefix sets the level;
// anything else is treated as plain info text (so a bare "1:1 with X" still works).
function parseLine(spec) {
  const s = String(spec == null ? '' : spec);
  const idx = s.indexOf(':');
  if (idx > 0) {
    const level = s.slice(0, idx).trim();
    if (store.VALID_LEVELS.includes(level)) {
      return { level, text: s.slice(idx + 1).trim() };
    }
  }
  return { level: 'info', text: s.trim() };
}

function parseArgs(argv) {
  const out = { title: '', lines: [], ttl: null, priority: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--title') out.title = argv[++i] || '';
    else if (a === '--line') out.lines.push(parseLine(argv[++i]));
    else if (a === '--ttl') out.ttl = parseInt(argv[++i], 10);
    else if (a === '--priority') out.priority = parseInt(argv[++i], 10);
    else if (a.startsWith('--title=')) out.title = a.slice('--title='.length);
    else if (a.startsWith('--line=')) out.lines.push(parseLine(a.slice('--line='.length)));
    else if (a.startsWith('--ttl=')) out.ttl = parseInt(a.slice('--ttl='.length), 10);
    else if (a.startsWith('--priority=')) out.priority = parseInt(a.slice('--priority='.length), 10);
  }
  return out;
}

function cmdSet(argv) {
  const args = parseArgs(argv);
  const lines = args.lines.filter((l) => l && l.text);
  if (lines.length === 0) {
    err('hud-board set: at least one --line "<level>:<text>" is required');
    return 2;
  }
  const board = store.writeBoard(resolveStateDir(), {
    title: args.title,
    lines,
    ttlSec: Number.isFinite(args.ttl) ? args.ttl : null,
    priority: Number.isFinite(args.priority) ? args.priority : null,
  });
  out(`board set: "${board.title || '(untitled)'}" — ${board.lines.length} line(s), ttl ${board.ttlSec}s`);
  return 0;
}

function cmdClear() {
  const removed = store.clearBoard(resolveStateDir());
  out(removed ? 'board cleared' : 'no board to clear');
  return 0;
}

function cmdShow() {
  const board = store.readBoard(resolveStateDir());
  if (!board) {
    out('no active board');
    return 0;
  }
  const palette = resolvePalette({ name: getTheme() });
  const state = { terminal: { cols: process.stdout.columns || 80 }, board };
  process.stdout.write(renderBoardZone(state, palette).join('\n') + '\n');
  return 0;
}

function main(argv = process.argv.slice(2)) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'set': return cmdSet(rest);
    case 'clear': return cmdClear();
    case 'show': return cmdShow();
    default:
      err('usage: hud-board <set|clear|show> [--title T] [--line "level:text"]... [--ttl S] [--priority N]');
      return cmd ? 2 : 1;
  }
}

if (require.main === module) {
  process.exit(main());
}

module.exports = { parseArgs, parseLine, resolveStateDir, cmdSet, cmdClear, cmdShow, main };
