'use strict';

const { colorize } = require('./hud-palette.cjs');

// --- Zone Metadata ---
// Low priority — shows git push/branch status when data is available.
const ZONE_META = { key: 'gitStatus', priority: 2, minRows: 1, idealRows: 2 };

// --- Visibility Predicate ---
// Zone appears when git state has meaningful data (branch + at least one signal).
function gitStatusVisible(state) {
  const git = state.git;
  if (!git || typeof git !== 'object') return false;
  // Visible when there is branch data and at least some state to show
  return typeof git.branch === 'string' && git.branch.length > 0;
}

// --- Time-ago formatter ---
function timeAgo(isoTs) {
  if (!isoTs) return '';
  const ts = Date.parse(isoTs);
  if (Number.isNaN(ts)) return '';
  const ago = Math.max(0, Date.now() - ts);
  const mins = Math.floor(ago / 60000);
  const hrs = Math.floor(mins / 60);
  const days = Math.floor(hrs / 24);
  if (days > 0) return `${days}d ago`;
  if (hrs > 0) return `${hrs}h ago`;
  if (mins > 0) return `${mins}m ago`;
  return 'just now';
}

// --- Renderer ---
function renderGitStatusZone(state, palette) {
  const lines = [];
  const git = state.git || {};
  const branch = git.branch || 'unknown';
  const ahead = git.ahead || 0;
  const behind = git.behind || 0;
  const dirty = typeof git.dirty === 'boolean' ? git.dirty : null;
  const uncommitted = typeof git.uncommittedFiles === 'number' ? git.uncommittedFiles : null;
  const lastCommitTs = git.lastCommitTs || null;

  // Line 1: branch + ahead/behind + dirty count
  const parts = [
    colorize(palette, 'muted', 'git'),
    ' ',
    colorize(palette, 'accent', branch),
  ];

  if (ahead > 0 || behind > 0) {
    const arrows = [];
    if (ahead > 0) arrows.push(colorize(palette, 'ok', '\u2191' + ahead));
    if (behind > 0) arrows.push(colorize(palette, 'warn', '\u2193' + behind));
    parts.push(' ');
    parts.push(arrows.join(' '));
  }

  if (dirty && uncommitted > 0) {
    parts.push(' ');
    parts.push(colorize(palette, 'warn', `${uncommitted} dirty`));
  } else if (dirty === false) {
    parts.push(' ');
    parts.push(colorize(palette, 'ok', 'clean'));
  } else {
    parts.push(' ');
    parts.push(colorize(palette, 'muted', 'dirty unknown'));
  }

  lines.push('  ' + parts.join(''));

  // Line 2: last commit timestamp + recent commit subject (if available)
  const commits = Array.isArray(git.recentCommits) ? git.recentCommits : [];
  if (commits.length > 0 || lastCommitTs) {
    const line2Parts = [];
    if (lastCommitTs) {
      line2Parts.push(colorize(palette, 'muted', timeAgo(lastCommitTs)));
    }
    if (commits.length > 0 && commits[0].subject) {
      const cols = (state.terminal && state.terminal.cols) || 79;
      const maxSubjLen = Math.max(10, cols - 24);
      const subj = commits[0].subject;
      const truncSubj = subj.length > maxSubjLen ? subj.slice(0, maxSubjLen - 1) + '\u2026' : subj;
      line2Parts.push(colorize(palette, 'muted', truncSubj));
    }
    if (line2Parts.length > 0) {
      lines.push('  ' + line2Parts.join('  '));
    }
  }

  return lines;
}

module.exports = { renderGitStatusZone, ZONE_META, gitStatusVisible, timeAgo };
