'use strict';

const { colorize, stripAnsi } = require('./hud-palette.cjs');

const ZONE_META = { priority: 5, minRows: 1, idealRows: 6 };
const PHASES = ['scope', 'brainstorm', 'spec', 'plan', 'execute', 'review', 'ship'];

function phaseIndex(phaseName) {
  if (!phaseName) return 0;
  const idx = PHASES.indexOf(phaseName.toLowerCase());
  return idx >= 0 ? idx + 1 : 0;
}

function renderPipelineRow(currentPhaseIndex, palette) {
  const parts = [];
  for (let i = 0; i < PHASES.length; i++) {
    const phaseNum = i + 1;
    let markerChar, markerRole;
    if (currentPhaseIndex === 0) {
      markerChar = '\u25CB'; markerRole = 'muted';
    } else if (phaseNum < currentPhaseIndex) {
      markerChar = '\u25CF'; markerRole = 'ok';
    } else if (phaseNum === currentPhaseIndex) {
      markerChar = '\u25C6'; markerRole = 'accent';
    } else {
      markerChar = '\u25CB'; markerRole = 'muted';
    }
    parts.push(colorize(palette, markerRole, markerChar));
    parts.push(' ');
    parts.push(colorize(palette, markerRole, PHASES[i]));
    if (i < PHASES.length - 1) {
      let arrowRole;
      if (currentPhaseIndex === 0) arrowRole = 'muted';
      else if (phaseNum < currentPhaseIndex) arrowRole = 'ok';
      else if (phaseNum === currentPhaseIndex) arrowRole = 'accent';
      else arrowRole = 'muted';
      parts.push(' ');
      parts.push(colorize(palette, arrowRole, '\u25B6'));
      parts.push(' ');
    }
  }
  return '  ' + parts.join('');
}

function connector(index, total) {
  if (total === 1) return '\u2514 ';
  if (index === 0) return '\u250C ';
  if (index === total - 1) return '\u2514 ';
  return '\u251C ';
}

function renderForgeZone(state, palette) {
  const { forge } = state;
  const lines = [];
  if (!forge.active) {
    lines.push('  ' + colorize(palette, 'accent', 'FORGE') + colorize(palette, 'muted', '  no active session'));
    return lines;
  }
  const session = forge.scope || '';
  const phase = forge.phase || '';
  lines.push('  ' + colorize(palette, 'accent', 'FORGE') + colorize(palette, 'muted', `  ${session}${phase ? ' \u00B7 ' + phase : ''}`));
  lines.push(renderPipelineRow(phaseIndex(phase), palette));
  const teammates = forge.teammates || [];
  if (teammates.length === 0) {
    lines.push('  ' + colorize(palette, 'muted', '  (no active teammates)'));
  } else {
    for (let i = 0; i < teammates.length; i++) {
      const tm = teammates[i];
      const conn = connector(i, teammates.length);
      const name = (tm.name || 'unknown').padEnd(16);
      const tmPhase = (tm.phase || 'idle').padEnd(13);
      const scope = (tm.scope || '--').padEnd(16);
      const status = tm.status || '--';
      const statusColor = status.includes('PASS') || status.includes('applied') || /\[\d+\/\d+\]/.test(status) ? 'ok'
        : status.includes('blocked') || status.includes('note') ? 'warn' : 'muted';
      lines.push('  ' + colorize(palette, 'muted', conn) + colorize(palette, 'text', name) + colorize(palette, 'muted', tmPhase) + colorize(palette, 'muted', scope) + colorize(palette, statusColor, status));
    }
  }
  return lines;
}

module.exports = { renderForgeZone, ZONE_META, PHASES, phaseIndex };
