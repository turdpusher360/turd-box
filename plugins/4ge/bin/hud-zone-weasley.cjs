'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { colorize } = require('./hud-palette.cjs');

// --- Zone Metadata ---
// The Weasley Clock zone: who is working where, across sessions. Low priority,
// self-hiding — it only appears when MORE THAN ONE live agent is on the repo, so
// it costs nothing in a normal solo glance.
const ZONE_META = { key: 'weasley', priority: 2, minRows: 2, idealRows: 4 };

const STALE_MS = 60000;

/**
 * Resolve the AISLE clock path. Mirrors weasley-utils.resolveAisleStateDir so the
 * zone reads the same authoritative file the hooks write. Self-loaded here
 * because clock.json lives outside _runs/ and the canonical HUD state pipeline
 * does not carry it.
 * @param {string} [cwd]
 * @returns {string}
 */
function clockPath(cwd) {
  const projectId = (cwd || process.cwd())
    .replace(/[\\/:\s_]/g, '-')
    .replace(/^-+/, '');
  return path.join(os.homedir(), '.claude', 'projects', projectId, 'aisle', 'clock.json');
}

/**
 * Load and prune the live agent list (no heartbeat within STALE_MS dropped).
 * @param {number} [now]
 * @param {string} [cwd]
 * @returns {Array<{key,type,name,session,lastActive,files}>}
 */
function loadLiveAgents(now, cwd) {
  now = now || Date.now();
  let clock;
  try {
    clock = JSON.parse(fs.readFileSync(clockPath(cwd), 'utf8'));
  } catch {
    return [];
  }
  const agents = (clock && clock.agents) || {};
  const live = [];
  for (const [key, v] of Object.entries(agents)) {
    if (!v || typeof v.lastActive !== 'number') continue;
    if (now - v.lastActive > STALE_MS) continue;
    live.push({
      key,
      type: v.type || 'agent',
      name: v.name || key,
      session: v.session || '',
      lastActive: v.lastActive,
      files: v.files && typeof v.files === 'object' ? Object.keys(v.files) : [],
    });
  }
  // Most-recently-active first.
  live.sort((a, b) => b.lastActive - a.lastActive);
  return live;
}

// --- Visibility Predicate ---
// Appears only when 2+ live agents share the repo (the multi-agent case Weasley
// exists for). Solo sessions never see it.
function weasleyVisible(state) {
  const cwd = (state && state.cwd) || process.cwd();
  return loadLiveAgents(Date.now(), cwd).length >= 2;
}

function timeAgo(now, ts) {
  const ago = Math.max(0, now - ts);
  const s = Math.floor(ago / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m`;
}

// --- Renderer ---
function renderWeasleyZone(state, palette) {
  const now = Date.now();
  const cwd = (state && state.cwd) || process.cwd();
  const agents = loadLiveAgents(now, cwd);
  const lines = [];
  if (agents.length < 2) return lines;

  const cols = (state && state.terminal && state.terminal.cols) || 79;
  lines.push('  ' + colorize(palette, 'muted', 'weasley') + ' ' +
    colorize(palette, 'accent', `${agents.length} agents on repo`));

  for (const a of agents.slice(0, 4)) {
    const file = a.files.length > 0 ? path.basename(a.files[0]) : 'idle';
    const more = a.files.length > 1 ? colorize(palette, 'muted', ` +${a.files.length - 1}`) : '';
    const label = `${a.name}`;
    const maxFileLen = Math.max(8, cols - label.length - 18);
    const shownFile = file.length > maxFileLen ? file.slice(0, maxFileLen - 1) + '…' : file;
    lines.push('  ' +
      colorize(palette, 'ok', '●') + ' ' +
      colorize(palette, 'fg', label) + ' ' +
      colorize(palette, 'muted', shownFile) + more + ' ' +
      colorize(palette, 'muted', timeAgo(now, a.lastActive)));
  }
  return lines;
}

module.exports = { renderWeasleyZone, ZONE_META, weasleyVisible, loadLiveAgents, clockPath };
