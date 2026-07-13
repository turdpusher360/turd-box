'use strict';

// hud-board-store.cjs — read/write/validate the lead-authored HUD board.
//
// The board is a small, lead-written explainer (status lanes, verdicts, callouts)
// that the statusline HUD renders live for the operator. It lives at
// `_runs/os/hud-board.json`. Writes are atomic (tmp + rename). Reads validate the
// schema AND freshness, and NEVER throw — a missing / corrupt / expired file
// yields `null` so the zone stays invisible. The statusline runs this read on
// every render, so it must stay fast and fail-invisible.

const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_VERSION = 1;
const DEFAULT_TTL_SEC = 900; // 15 minutes
const MAX_TTL_SEC = 86400; // 24h hard cap
const BOARD_FILENAME = 'hud-board.json';
const VALID_LEVELS = ['info', 'ok', 'warn', 'alert', 'accent'];
const MAX_LINES = 12;
const MAX_TEXT = 200;
const MAX_TITLE = 80;

// Level → palette semantic role (see hud-palette.cjs). alert maps to the loudest
// role (error); info is plain body text.
const LEVEL_ROLE = { info: 'text', ok: 'ok', warn: 'warn', alert: 'error', accent: 'accent' };

function levelRole(level) {
  return LEVEL_ROLE[level] || 'text';
}

function boardPath(stateDir) {
  return path.join(stateDir || '.', BOARD_FILENAME);
}

// Accept epoch ms (number) or an ISO string; returns ms or NaN.
function parseTs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Date.parse(value);
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
}

function normalizeLine(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const text = typeof raw.text === 'string' ? raw.text.slice(0, MAX_TEXT) : '';
  if (!text.trim()) return null;
  const level = VALID_LEVELS.includes(raw.level) ? raw.level : 'info';
  return { text, level };
}

function normalizeTtl(value) {
  let ttlSec = Number(value);
  if (!Number.isFinite(ttlSec) || ttlSec <= 0) ttlSec = DEFAULT_TTL_SEC;
  return Math.min(ttlSec, MAX_TTL_SEC);
}

// Structural validation only (no freshness). Returns a normalized board or null.
function validateBoard(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.v !== SCHEMA_VERSION) return null;
  if (!Array.isArray(raw.lines)) return null;
  const lines = raw.lines.map(normalizeLine).filter(Boolean).slice(0, MAX_LINES);
  if (lines.length === 0) return null;
  const createdAt = parseTs(raw.createdAt);
  if (!Number.isFinite(createdAt)) return null;
  const title = typeof raw.title === 'string' ? raw.title.slice(0, MAX_TITLE) : '';
  const priority = Number.isFinite(Number(raw.priority)) ? Number(raw.priority) : null;
  return { v: SCHEMA_VERSION, title, lines, ttlSec: normalizeTtl(raw.ttlSec), createdAt, priority };
}

function isFresh(board, now = Date.now()) {
  if (!board || !Number.isFinite(board.createdAt) || !Number.isFinite(board.ttlSec)) return false;
  return (board.createdAt + board.ttlSec * 1000) > now;
}

function ageMs(board, now = Date.now()) {
  if (!board || !Number.isFinite(board.createdAt)) return 0;
  return Math.max(0, now - board.createdAt);
}

// Read + validate + freshness-check. Returns a normalized board or null. Never throws.
function readBoard(stateDir, now = Date.now()) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(boardPath(stateDir), 'utf8'));
  } catch {
    return null; // missing or corrupt → invisible
  }
  const board = validateBoard(raw);
  if (!board) return null;
  if (!isFresh(board, now)) return null; // expired → invisible
  return board;
}

// Normalize + atomic write (tmp + rename). Returns the written board.
// Throws only on a genuine fs failure or an empty line set (a board with no
// lines can never render, so writing one is a caller error).
function writeBoard(stateDir, input = {}, now = Date.now()) {
  const lines = Array.isArray(input.lines)
    ? input.lines.map(normalizeLine).filter(Boolean).slice(0, MAX_LINES)
    : [];
  if (lines.length === 0) {
    throw new Error('writeBoard: at least one non-empty line is required');
  }
  const board = {
    v: SCHEMA_VERSION,
    title: typeof input.title === 'string' ? input.title.slice(0, MAX_TITLE) : '',
    lines,
    ttlSec: normalizeTtl(input.ttlSec),
    createdAt: now,
    priority: Number.isFinite(Number(input.priority)) ? Number(input.priority) : null,
  };
  fs.mkdirSync(stateDir, { recursive: true });
  const dest = boardPath(stateDir);
  const tmp = `${dest}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
  fs.writeFileSync(tmp, JSON.stringify(board, null, 2));
  fs.renameSync(tmp, dest);
  return board;
}

// Remove the board file. Returns true if a file was removed. Never throws.
function clearBoard(stateDir) {
  try {
    fs.unlinkSync(boardPath(stateDir));
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  SCHEMA_VERSION,
  DEFAULT_TTL_SEC,
  MAX_TTL_SEC,
  BOARD_FILENAME,
  VALID_LEVELS,
  MAX_LINES,
  MAX_TEXT,
  MAX_TITLE,
  LEVEL_ROLE,
  levelRole,
  boardPath,
  validateBoard,
  isFresh,
  ageMs,
  readBoard,
  writeBoard,
  clearBoard,
};
