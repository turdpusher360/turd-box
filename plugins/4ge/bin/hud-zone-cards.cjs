'use strict';

const { colorize, stripAnsi } = require('./hud-palette.cjs');
const { COMMAND_CHARACTERS, GREETINGS } = require('../lib/command-card-renderer.cjs');

let getInsight;
try {
  getInsight = require('./companion-insights.cjs').getInsight;
} catch { getInsight = null; }

// ── Zone Metadata ───────────────────────────────────────────────────────────
// priority 3 — between badges (2) and session (1), after caps (6) and forge (5)
// minRows: 0 so it gracefully drops when no active command
const ZONE_META = { key: 'cards', priority: 3, minRows: 0, idealRows: 4, label: 'Cards' };

// ── ANSI helpers ────────────────────────────────────────────────────────────
const R = '\x1b[0m';
const B = '\x1b[1m';

// ── Visible width helper ─────────────────────────────────────────────────────
function visLen(str) {
  return stripAnsi(str).length;
}

// ── Render a single command card row (sprite + content side by side) ─────────
// Returns an array of ANSI strings (rows).
function renderCommandCard(sprite, command, status, palette, width, state, overrideGreeting) {
  const SPRITE_COL = 12;
  const INDENT = 2;
  const rows = [];

  const sideBySide = width >= 50;

  if (!sideBySide) {
    for (const spriteLine of sprite) {
      rows.push(' '.repeat(INDENT) + spriteLine);
    }
    const name = B + colorize(palette, 'accent', command) + R;
    rows.push(' '.repeat(INDENT) + name);
    if (status) {
      rows.push(' '.repeat(INDENT) + colorize(palette, 'muted', status));
    }
    return rows;
  }

  const insight = overrideGreeting || (getInsight ? getInsight(state) : null);
  const greeting = insight || GREETINGS[command] || GREETINGS.default || 'Standing by.';
  const contentLines = [
    B + colorize(palette, 'accent', command) + R,
    colorize(palette, 'muted', greeting),
  ];
  if (status) {
    contentLines.push(colorize(palette, 'muted', status));
  }

  const totalLines = Math.max(sprite.length, contentLines.length);

  for (let i = 0; i < totalLines; i++) {
    const spriteLine = sprite[i] || '';
    const spriteVis = visLen(spriteLine);
    const spritePad = ' '.repeat(Math.max(0, SPRITE_COL - spriteVis));
    const contentLine = contentLines[i] || '';
    rows.push(' '.repeat(INDENT) + spriteLine + spritePad + '  ' + contentLine);
  }

  return rows;
}

// ── Zone Renderer ────────────────────────────────────────────────────────────
// Reads state.context.event or state.forge.activeCommand to pick the command.
// Returns [] when no active command (zone drops gracefully).
function renderCommandCards(state, width) {
  const event = (state.context && state.context.event) || '';
  const activeCommand = (state.forge && state.forge.activeCommand) || '';

  const eventCommandMap = {
    'forge-phase': 'forge',
    'badge-earned': '4ge',
    'test-pass': '4ge',
    'test-fail': 'debug',
    'commit': 'forge',
    'export': 'export',
  };

  const commandName = activeCommand || eventCommandMap[event] || '';
  const palette = state.palette || {};
  const cols = width || (state.terminal && state.terminal.cols) || 80;

  if (!commandName) {
    // Idle placeholder — resolve insight here, pass as overrideGreeting to avoid double-call
    const sprite = COMMAND_CHARACTERS.default;
    const insight = getInsight ? getInsight(state) : null;
    const greeting = insight || GREETINGS.default || 'Standing by.';
    return renderCommandCard(sprite, 'idle', null, palette, cols, null, greeting);
  }

  const sprite = COMMAND_CHARACTERS[commandName] || COMMAND_CHARACTERS.default;

  // Build brief status from available state fields
  const statusParts = [];
  if (state.forge && state.forge.active) {
    const phase = state.forge.phase || 'active';
    statusParts.push(`forge ${phase}`);
  }
  if (state.git && state.git.branch) {
    const branchInfo = state.git.branch;
    const dirtyFlag = state.git.dirty ? '*' : '';
    statusParts.push(`${branchInfo}${dirtyFlag}`);
  }
  if (event) {
    statusParts.push(event.replace(/-/g, ' '));
  }
  const status = statusParts.slice(0, 3).join(' | ');

  return renderCommandCard(sprite, commandName, status, palette, cols, state);
}

module.exports = {
  renderCommandCards,
  ZONE_META,
};
