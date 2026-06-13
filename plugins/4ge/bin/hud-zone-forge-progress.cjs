'use strict';

const { colorize } = require('./hud-palette.cjs');

// --- Zone Metadata ---
// Above activity (1) and badges (2), below cards (3) and forge (5).
// Visible only when forge-progress.json exists with active session data.
const ZONE_META = { key: 'forgeProgress', priority: 3, minRows: 3, idealRows: 8 };

// --- Status icons ---
const STATUS_ICON = {
  shipped:  '\u2588', // full block (green)
  running:  '\u2593', // dark shade (accent)
  queued:   '\u2591', // light shade (muted)
  deferred: '\u2500', // horizontal line (muted)
  failed:   '\u2717', // X mark (error)
};

const STATUS_COLOR = {
  shipped:  'ok',
  running:  'accent',
  queued:   'muted',
  deferred: 'muted',
  failed:   'error',
};

// --- Elapsed time formatter ---
function formatElapsed(startedAt) {
  if (!startedAt) return '';
  const start = Date.parse(startedAt);
  if (Number.isNaN(start)) return '';
  const elapsed = Math.max(0, Date.now() - start);
  const mins = Math.floor(elapsed / 60000);
  const hrs = Math.floor(mins / 60);
  if (hrs > 0) return `${hrs}h${mins % 60}m`;
  if (mins > 0) return `${mins}m`;
  const secs = Math.floor(elapsed / 1000);
  return `${secs}s`;
}

// --- Visibility Predicate ---
// Zone appears only when forge progress state has wave data.
function forgeProgressVisible(state) {
  const fp = state.forgeProgress;
  if (!fp || typeof fp !== 'object') return false;
  return Array.isArray(fp.waves) && fp.waves.length > 0;
}

// --- Wave status bar ---
// Renders a compact status bar: shipped/running/queued/failed segments.
function renderWaveBar(wave, palette, barWidth) {
  const pkgs = Array.isArray(wave.packages) ? wave.packages.length : 0;
  if (pkgs === 0) return colorize(palette, 'muted', '\u2500'.repeat(barWidth));

  const status = wave.status || 'queued';

  // For individual wave: full bar in wave's status color
  const filled = Math.min(barWidth, pkgs);
  const icon = STATUS_ICON[status] || STATUS_ICON.queued;
  const color = STATUS_COLOR[status] || 'muted';
  const bar = colorize(palette, color, icon.repeat(Math.min(filled, barWidth)));
  const remainder = barWidth - filled;
  const pad = remainder > 0 ? colorize(palette, 'muted', '\u2500'.repeat(remainder)) : '';

  return bar + pad;
}

// --- Renderer ---
function renderForgeProgressZone(state, palette) {
  const lines = [];
  const fp = state.forgeProgress;
  if (!fp || !Array.isArray(fp.waves)) {
    lines.push('  ' + colorize(palette, 'muted', 'No forge progress'));
    return lines;
  }

  const cols = (state.terminal && state.terminal.cols) || 79;
  const session = fp.session || '';
  const task = fp.task || '';
  const elapsed = formatElapsed(fp.startedAt);

  // Header: FORGE <session> -- <task> <elapsed>
  const headerParts = [
    colorize(palette, 'accent', 'FORGE'),
    ' ',
    colorize(palette, 'text', session),
  ];
  if (task) {
    const maxTaskLen = Math.max(10, cols - 30 - session.length);
    const truncTask = task.length > maxTaskLen ? task.slice(0, maxTaskLen - 1) + '\u2026' : task;
    headerParts.push(colorize(palette, 'muted', ' \u2014 '));
    headerParts.push(colorize(palette, 'muted', truncTask));
  }
  if (elapsed) {
    headerParts.push(' ');
    headerParts.push(colorize(palette, 'muted', elapsed));
  }
  lines.push('  ' + headerParts.join(''));

  // Per-wave rows
  const barWidth = 8;
  const waves = fp.waves;
  for (const wave of waves) {
    const id = wave.id || '?';
    const label = (wave.label || '').slice(0, 16).padEnd(16);
    const status = wave.status || 'queued';
    const commits = wave.commits || 0;
    const agents = Array.isArray(wave.agents) ? wave.agents : [];
    const pkgCount = Array.isArray(wave.packages) ? wave.packages.length : 0;

    const bar = renderWaveBar(wave, palette, barWidth);
    const statusIcon = colorize(palette, STATUS_COLOR[status] || 'muted', STATUS_ICON[status] || '\u25CB');
    const commitStr = commits > 0 ? colorize(palette, 'text', `${commits}c`) : colorize(palette, 'muted', '0c');
    const agentStr = agents.length > 0 ? colorize(palette, 'accent', `${agents.length}a`) : '';
    const pkgStr = colorize(palette, 'muted', `${pkgCount}p`);

    lines.push(
      '  ' + statusIcon + ' ' +
      colorize(palette, 'text', id.padEnd(4)) +
      colorize(palette, 'muted', label) + ' ' +
      bar + ' ' +
      commitStr +
      (agentStr ? ' ' + agentStr : '') + ' ' +
      pkgStr
    );

    // Active agents indented under their wave (only when running)
    if (status === 'running' && agents.length > 0) {
      for (const agent of agents) {
        const agentName = (agent.name || agent.type || 'agent').slice(0, 20);
        const agentStatus = agent.status || 'running';
        const agentElapsed = formatElapsed(agent.startedAt);
        const agentColor = agentStatus === 'done' ? 'ok' : agentStatus === 'failed' ? 'error' : 'accent';
        const elapsedPart = agentElapsed ? colorize(palette, 'muted', ' ' + agentElapsed) : '';
        lines.push(
          '    ' +
          colorize(palette, 'muted', '\u2514 ') +
          colorize(palette, agentColor, agentName) +
          elapsedPart
        );
      }
    }
  }

  // Footer: shipped/total packages, running count
  const totals = fp.totals || {};
  const shipped = totals.shipped || 0;
  const total = totals.packages || 0;
  const running = totals.running || 0;
  const queued = totals.queued || 0;

  const footerParts = [
    colorize(palette, 'ok', String(shipped)),
    colorize(palette, 'muted', '/'),
    colorize(palette, 'text', String(total)),
    colorize(palette, 'muted', ' shipped'),
  ];
  if (running > 0) {
    footerParts.push('  ');
    footerParts.push(colorize(palette, 'accent', String(running)));
    footerParts.push(colorize(palette, 'muted', ' active'));
  }
  if (queued > 0) {
    footerParts.push('  ');
    footerParts.push(colorize(palette, 'muted', `${queued} queued`));
  }
  lines.push('  ' + footerParts.join(''));

  return lines;
}

module.exports = { renderForgeProgressZone, ZONE_META, forgeProgressVisible, formatElapsed };
