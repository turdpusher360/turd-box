'use strict';

/**
 * Forge board compatibility helper for 4ge.
 *
 * This module is intentionally self-contained so the plugin can emit
 * `_runs/forge-board/*` state regardless of where the canonical board engine
 * lives in the runtime. It creates the shared board artifacts used by Anvil
 * while preserving existing CLI workflows.
 */

const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_VERSION = 1;
const ALLOWED_MODES = new Set(['code', 'review', 'ship', 'maintain']);
const ALLOWED_PROJECTION_MODES = new Set(['advisory', 'auto-at-stop-lines']);

const MODE_SUGGESTIONS = {
  code: 'review',
  review: 'ship',
  ship: 'maintain',
  maintain: 'code',
};

function normalizeProjectRoot(projectRoot) {
  return projectRoot || process.cwd();
}

function boardRoot(projectRoot) {
  return path.join(normalizeProjectRoot(projectRoot), '_runs', 'forge-board');
}

function latestPath(projectRoot) {
  return path.join(boardRoot(projectRoot), 'latest.json');
}

function currentPath(projectRoot, sessionId) {
  return path.join(boardRoot(projectRoot), 'current', `${safeFilePart(sessionId)}.json`);
}

function historyDir(projectRoot) {
  return path.join(boardRoot(projectRoot), 'history');
}

function historyIndexPath(projectRoot) {
  return path.join(historyDir(projectRoot), 'index.json');
}

function ensureDirectory(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function safeDate(inputDate) {
  const value = inputDate || new Date().toISOString();
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return value;
  return new Date().toISOString();
}

function normalizeMode(mode) {
  if (!mode) return 'code';
  const normalized = String(mode).trim().toLowerCase();
  if (!ALLOWED_MODES.has(normalized)) {
    throw new Error(`Invalid Forge board mode: ${mode}`);
  }
  return normalized;
}

function normalizeProjectionMode(projectionMode) {
  if (!projectionMode) return 'advisory';
  const normalized = String(projectionMode).trim().toLowerCase();
  if (!ALLOWED_PROJECTION_MODES.has(normalized)) {
    throw new Error(`Invalid projection mode: ${projectionMode}`);
  }
  return normalized;
}

function safeFilePart(input) {
  return String(input || 'session')
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'session';
}

function makeSessionId(now, projectRoot) {
  const stamp = safeDate(now).replace(/[-:.]/g, '').slice(0, 15);
  const suffix = path.basename(normalizeProjectRoot(projectRoot)).replace(/[^a-zA-Z0-9]/g, '').slice(0, 4) || 'proj';
  return `S${stamp}-${suffix}`.toUpperCase();
}

function deriveSNumber(sessionId) {
  const match = String(sessionId || '').match(/^[sS](\d{4,})/);
  if (!match) return null;
  return `S${match[1]}`;
}

function makeProjectInfo(projectRoot) {
  const normalized = normalizeProjectRoot(projectRoot);
  const base = path.basename(normalized);
  return {
    root: normalized,
    slug: base.toLowerCase(),
    name: base || 'project',
  };
}

function getPaths(projectRoot) {
  const root = normalizeProjectRoot(projectRoot);
  return {
    boardRoot: boardRoot(root),
    latest: latestPath(root),
    historyIndex: historyIndexPath(root),
  };
}

function createBoard(opts = {}) {
  const projectRoot = normalizeProjectRoot(opts.projectRoot);
  const now = safeDate(opts.now);
  const mode = normalizeMode(opts.mode);
  const projectionMode = normalizeProjectionMode(opts.projectionMode);
  const sessionId = opts.sessionId || makeSessionId(now, projectRoot);

  return {
    schema_version: SCHEMA_VERSION,
    project: makeProjectInfo(projectRoot),
    session: {
      id: String(sessionId),
      s_number: deriveSNumber(sessionId),
      started_at: now,
      updated_at: now,
    },
    mode,
    mode_status: 'active',
    hybrid_suggestions: true,
    scope: 'current',
    status: 'ready',
    summary: String(opts.summary || 'Compatibility board initialized.'),
    proof: {
      diff: [],
      tests: [],
      ci: [],
      proof_planes: ['source/code', 'local/runtime', 'ci'],
    },
    product: {
      screenshots: [],
      preview_urls: [],
      render_checks: [],
      user_visible_changes: [],
    },
    decision: {
      verdict: 'needs-review',
      findings: [],
      recommended_next_mode: MODE_SUGGESTIONS[mode] || 'code',
      owner_gates: [],
    },
    quality_signal: {
      verdict: 'insufficient-evidence',
      judgments: [],
      metrics: [],
    },
    addons: {
      suggested: [],
      available: [],
      invoked: [],
    },
    projection: {
      mode: projectionMode,
      preview: [],
      applied: [],
    },
    continuity: {
      tasking: null,
      handoff: null,
      cartridge: null,
      decision_log: null,
      constraint_log: null,
      memory_ids: [],
    },
  };
}

function readLatestBoard(projectRoot) {
  return readJson(latestPath(projectRoot));
}

function readCurrentBoard(projectRoot, sessionId, fallbackBoard) {
  const board = fallbackBoard || readLatestBoard(projectRoot);
  if (!board || !board.session?.id) return null;
  const targetSession = sessionId || board.session.id;
  if (!targetSession) return null;
  return readJson(currentPath(projectRoot, targetSession)) || board;
}

function writeJson(filePath, value) {
  ensureDirectory(filePath);
  const serialized = JSON.stringify(value, null, 2);
  const tmpPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    fs.writeFileSync(tmpPath, `${serialized}\n`, 'utf8');
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // Best-effort cleanup; preserve the original write failure.
    }
    throw err;
  }
}

function writeBoard(projectRoot, board) {
  const root = normalizeProjectRoot(projectRoot);
  const normalizedBoard = {
    ...createBoard({ projectRoot: root, ...board }),
    ...board,
  };
  const sessionId = normalizedBoard.session?.id || makeSessionId(undefined, root);
  normalizedBoard.session = {
    ...normalizedBoard.session,
    id: String(sessionId),
    updated_at: safeDate(normalizedBoard.session?.updated_at),
  };

  const latest = latestPath(root);
  const current = currentPath(root, sessionId);

  writeJson(latest, normalizedBoard);
  writeJson(current, normalizedBoard);

  return {
    paths: {
      latest,
      current,
      boardRoot: boardRoot(root),
      historyIndex: historyIndexPath(root),
    },
    board: normalizedBoard,
  };
}

function setMode(projectRoot, mode, options = {}) {
  const root = normalizeProjectRoot(projectRoot);
  const normalizedMode = normalizeMode(mode);

  const board = readLatestBoard(root);
  const base = board && board.schema_version === SCHEMA_VERSION ? board : createBoard({ projectRoot: root, now: options.now });
  const now = safeDate(options.now);

  const nextBoard = {
    ...base,
    mode: normalizedMode,
    mode_status: options.modeStatus || base.mode_status || 'active',
    decision: {
      ...base.decision,
      recommended_next_mode: MODE_SUGGESTIONS[normalizedMode],
    },
    summary: options.summary || base.summary,
    session: {
      ...base.session,
      updated_at: now,
    },
    proof: {
      ...base.proof,
      proof_planes: base.proof?.proof_planes || ['source/code', 'local/runtime', 'ci'],
    },
  };

  nextBoard.decision.recommended_next_mode ||= MODE_SUGGESTIONS[normalizedMode];

  const result = writeBoard(root, nextBoard);
  return result;
}

function setProjectionMode(projectRoot, projectionMode, options = {}) {
  const root = normalizeProjectRoot(projectRoot);
  const normalizedProjection = normalizeProjectionMode(projectionMode);
  const board = readLatestBoard(root);
  const base = board && board.schema_version === SCHEMA_VERSION ? board : createBoard({ projectRoot: root, now: options.now });
  const now = safeDate(options.now);

  const nextBoard = {
    ...base,
    projection: {
      ...(base.projection || {}),
      mode: normalizedProjection,
      preview: Array.isArray(base.projection?.preview) ? base.projection.preview : [],
      applied: Array.isArray(base.projection?.applied) ? base.projection.applied : [],
    },
    session: {
      ...base.session,
      updated_at: now,
    },
  };

  return writeBoard(root, nextBoard);
}

function readHistoryIndex(projectRoot) {
  const root = normalizeProjectRoot(projectRoot);
  const indexPath = historyIndexPath(root);
  const raw = readJson(indexPath);

  if (!raw || typeof raw !== 'object') {
    return {
      schema_version: SCHEMA_VERSION,
      project: makeProjectInfo(root),
      entries: [],
    };
  }

  return {
    schema_version: Number.isFinite(raw.schema_version) ? raw.schema_version : SCHEMA_VERSION,
    project: {
      root: raw.project?.root || normalizeProjectRoot(root),
      slug: raw.project?.slug || makeProjectInfo(root).slug,
      name: raw.project?.name || makeProjectInfo(root).name,
    },
    entries: Array.isArray(raw.entries) ? raw.entries : [],
  };
}

module.exports = {
  SCHEMA_VERSION,
  ALLOWED_MODES: [...ALLOWED_MODES],
  ALLOWED_PROJECTION_MODES: [...ALLOWED_PROJECTION_MODES],
  makeSessionId,
  getPaths,
  createBoard,
  readLatestBoard,
  readCurrentBoard,
  writeBoard,
  setMode,
  setProjectionMode,
  readHistoryIndex,
};
