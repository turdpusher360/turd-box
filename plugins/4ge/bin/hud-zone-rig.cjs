'use strict';

const { colorize } = require('./hud-palette.cjs');

const RIG_META = { key: 'rig', priority: 7, minRows: 1, idealRows: 3 };

function getRigContext(state) {
  return state && state.rigContext && typeof state.rigContext === 'object'
    ? state.rigContext
    : null;
}

function rigContextVisible(state) {
  const rig = getRigContext(state);
  if (!rig) return false;
  if (rig.isStale === true) return true;
  if (rig.status && rig.status !== 'ok') return true;
  return Number(rig.issueCount) > 0;
}

function statusRole(rig) {
  if (rig && rig.status === 'error') return 'error';
  if (rig && (rig.status === 'warn' || rig.isStale === true)) return 'warn';
  if (rig && rig.status === 'ok') return 'ok';
  return 'muted';
}

function issueLabel(count) {
  return `${count} ${count === 1 ? 'issue' : 'issues'}`;
}

function ageLabel(ageMinutes) {
  return Number.isFinite(ageMinutes) ? `${Math.max(0, Math.round(ageMinutes))}m old` : 'age unknown';
}

function clip(value, max = 96) {
  if (typeof value !== 'string') return '';
  const text = value.replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return text.slice(0, max - 3).trimEnd() + '...';
}

function renderRigZone(state, palette) {
  const rig = getRigContext(state);
  if (!rig) {
    return ['  ' + colorize(palette, 'muted', 'rig unknown no rig-context snapshot')];
  }

  const role = statusRole(rig);
  const status = rig.status || 'unknown';
  const count = Math.max(0, Number(rig.issueCount) || 0);
  const suffix = rig.isStale === true ? ' [stale]' : '';
  const lines = [
    '  ' +
      colorize(palette, 'muted', 'rig ') +
      colorize(palette, role, status) +
      colorize(palette, 'muted', ` ${issueLabel(count)} ${ageLabel(rig.ageMinutes)}${suffix}`),
  ];

  const issues = Array.isArray(rig.issues) ? rig.issues : [];
  if (issues.length === 0) {
    const headline = clip(rig.headline || 'rig context ok', 120);
    lines.push('  ' + colorize(palette, rig.isStale ? 'warn' : 'muted', headline));
    return lines;
  }

  for (const issue of issues.slice(0, 2)) {
    const issueRole = statusRole(issue);
    const name = clip(issue && issue.name, 32) || 'check';
    const summary = clip(issue && issue.summary, 100) || 'No summary';
    lines.push(
      '  ' +
        colorize(palette, issueRole, `${name}: `) +
        colorize(palette, 'text', summary),
    );
  }

  if (issues.length > 2) {
    lines.push('  ' + colorize(palette, 'muted', `+${issues.length - 2} more`));
  }

  return lines;
}

function renderRigCompact(state, palette) {
  if (!rigContextVisible(state)) return [];
  const rig = getRigContext(state);
  const role = statusRole(rig);
  const count = Math.max(0, Number(rig.issueCount) || 0);
  const firstIssue = Array.isArray(rig.issues) && rig.issues.length > 0
    ? clip(rig.issues[0].name, 32)
    : '';
  const stale = rig.isStale === true ? ' [stale]' : '';
  const issue = firstIssue ? ` ${firstIssue}` : '';
  return [
    '  ' +
      colorize(palette, 'muted', 'rig ') +
      colorize(palette, role, rig.status || 'unknown') +
      colorize(palette, 'muted', ` ${issueLabel(count)}${issue} ${ageLabel(rig.ageMinutes)}${stale}`),
  ];
}

module.exports = {
  RIG_META,
  renderRigZone,
  renderRigCompact,
  rigContextVisible,
};
