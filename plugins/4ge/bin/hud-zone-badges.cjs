'use strict';

const { colorize, stripAnsi } = require('./hud-palette.cjs');

// --- Zone Metadata ---
const ZONE_META = { priority: 2, minRows: 1, idealRows: 2 };

// --- Badge Definitions ---
// Each badge has: id, name, description, check function
// check(state, history) returns true if earned
const BADGE_DEFS = [
  { id: 'forge-master', name: 'forge-master', desc: 'Complete 5 forge sessions' },
  { id: 'audit-clean', name: 'audit-clean', desc: 'Pass a full audit with 0 P0 findings' },
  { id: 'full-deploy', name: 'full-deploy', desc: 'Ship via /ship with all checks green' },
  { id: 'zone-builder', name: 'zone-builder', desc: 'All 9 HUD zones rendering' },
  { id: 'test-green', name: 'test-green', desc: '100% test pass rate in a session' },
  { id: 'export-ready', name: 'export-ready', desc: 'Export 3 session deliverables' },
  { id: 'studio-mode', name: 'studio-mode', desc: 'Activate full studio mode' },
  { id: 'all-zones', name: 'all-zones', desc: 'Use every zone in a single render' },
  { id: 'companion-v2', name: 'companion-v2', desc: 'Anvil reaches expression level 2' },
  { id: 'memory-keeper', name: 'memory-keeper', desc: 'Store 50 memories with quality gate' },
];

// --- Badge State ---
// Loads from disk: { earned: { 'forge-master': '2026-04-07T...', ... }, newThisSession: [] }
function loadBadges(filePath) {
  try {
    const fs = require('fs');
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return {
      earned: data.earned || {},
      newThisSession: data.newThisSession || [],
    };
  } catch {
    return { earned: {}, newThisSession: [] };
  }
}

function saveBadges(filePath, badgeState) {
  const fs = require('fs');
  const dir = require('path').dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(badgeState, null, 2));
}

function earnBadge(badgeState, badgeId) {
  if (badgeState.earned[badgeId]) return false; // already earned
  badgeState.earned[badgeId] = new Date().toISOString();
  badgeState.newThisSession.push(badgeId);
  return true;
}

// --- Zone Renderer ---
function renderBadgesZone(state, palette) {
  const lines = [];

  // Load badge state from state object or default
  const badges = (state.badges && state.badges.earned) || {};
  const newBadges = (state.badges && state.badges.newThisSession) || [];

  // Render in rows of 4
  const perRow = 4;
  for (let i = 0; i < BADGE_DEFS.length; i += perRow) {
    const row = BADGE_DEFS.slice(i, i + perRow);
    const parts = row.map(badge => {
      const earned = !!badges[badge.id];
      const isNew = newBadges.includes(badge.id);

      if (isNew) {
        // Gold star for newly earned
        return colorize(palette, 'warn', '\u2605 ') + colorize(palette, 'text', badge.name);
      } else if (earned) {
        // Gold diamond for earned
        return colorize(palette, 'warn', '\u25C6') + ' ' + colorize(palette, 'muted', badge.name);
      } else {
        // Dim circle for locked
        return colorize(palette, 'muted', '\u25CB ' + badge.name);
      }
    });

    // Pad each entry to 18 chars visible width (use stripAnsi to handle ANSI codes in icon)
    const padded = parts.map((p) => {
      const visLen = stripAnsi(p).length;
      const pad = Math.max(0, 18 - visLen);
      return p + ' '.repeat(pad);
    });

    lines.push('  ' + padded.join(''));
  }

  // Show "NEW" callout if badges earned this session
  if (newBadges.length > 0) {
    const newest = newBadges[newBadges.length - 1];
    lines.push('  ' + colorize(palette, 'muted', '                                 ') +
      colorize(palette, 'warn', '\u2605 NEW: ') +
      colorize(palette, 'text', newest) +
      colorize(palette, 'muted', ' earned'));
  }

  return lines;
}

module.exports = {
  renderBadgesZone,
  ZONE_META,
  BADGE_DEFS,
  loadBadges,
  saveBadges,
  earnBadge,
};
