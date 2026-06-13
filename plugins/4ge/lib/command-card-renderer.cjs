'use strict';

// command-card-renderer.cjs — Shared borderless command card renderer.
// Sprites use 4-bit ANSI only (\x1b[3Xm / \x1b[9Xm) for Termius compatibility.

const { getOrderedOptions } = require('./smart-order.cjs');

const R  = '\x1b[0m';
const B  = '\x1b[1m';
// 4-bit foreground helpers
const _r = '\x1b[31m'; const _R = '\x1b[91m'; // red / bright red
const _y = '\x1b[33m'; const _Y = '\x1b[93m'; // yellow / bright yellow
const _g = '\x1b[32m'; const _G = '\x1b[92m'; // green / bright green
const _c = '\x1b[36m'; const _C = '\x1b[96m'; // cyan / bright cyan
const _b = '\x1b[34m'; const _B2 = '\x1b[94m'; // blue / bright blue
const _m = '\x1b[35m'; const _M = '\x1b[95m'; // magenta / bright magenta
const _w = '\x1b[37m'; const _W = '\x1b[97m'; // white / bright white
const _k = '\x1b[90m';                          // dark gray (bright black)

// ── Character sprites (4-bit ANSI, 5 rows, 6-8 chars visible wide) ─────────

const FORGE_SM = [
  `  ${_Y}▄▄${R}  `,
  `${_Y}▄████▄${R}`,
  `${_r}██${R}${_Y}▀▀${R}${_r}██${R}`,
  `${_r}██████${R}`,
  `${_k}▀████▀${R}`,
];

const SENTRY_SM = [
  `${_k}▄████▄${R}`,
  `${_k}██████${R}`,
  `${_k}█${R}${_r}▄▄▄▄${R}${_k}█${R}`,
  `${_k}██████${R}`,
  `${_k}▀████▀${R}`,
];

const WRENCH_SM = [
  `${_k}▄ ▄▄ ▄${R}`,
  `${_k}██████${R}`,
  `${_k}█${R}${_Y}▀▀▀▀${R}${_k}█${R}`,
  `${_k}██████${R}`,
  `${_k}▀ ▀▀ ▀${R}`,
];

const SCOUT_SM = [
  `  ${_G}▄${R} ${_G}▄${R} `,
  `${_g}▄█████▄${R}`,
  `${_g}█${R}${_C}██${R}${_g}█${R}${_C}██${R}${_g}█${R}`,
  `${_g}▀█████▀${R}`,
  `  ${_g}███${R}  `,
];

const LENS_SM = [
  `${_k}▄████▄${R}`,
  `${_k}█${R}${_m}▄▄▄▄${R}${_k}█${R}`,
  `${_k}█${R}${_m}█${R}${_M}▀${R}${_m}██${R}${_k}█${R}`,
  `${_k}▀████▀${R}`,
  `    ${_y}██${R}`,
];

const DRIFT_SM = [
  `${_B2}▄██████▄${R}`,
  `${_B2}████████${R}`,
  `${_B2}████████${R}`,
  `${_B2}████████${R}`,
  `${_b}▀ ▀▀ ▀▀ ▀${R}`,
];

const PULSE_SM = [
  `${_r}▄▄${R}  ${_r}▄▄${R}`,
  `${_r}▀████▀${R}`,
  `${_r}████████${R}`,
  `${_g}─▄▀─▄▀─${R}`,
  `${_g}─▀▄─▀▄─${R}`,
];

const SPARK_SM = [
  `    ${_Y}▄▄${R}`,
  `${_Y}██████▄${R}`,
  `${_Y}████████${R}`,
  `${_Y}██████▀${R}`,
  `    ${_Y}▀▀${R}`,
];

const PIXEL_SM = [
  `${_c}▄████▄${R}`,
  `${_c}█${R}${_W}▀${R}${_c}████${R}`,
  `${_c}██████${R}`,
  `${_c}██████${R}`,
  `${_c}▀████▀${R}`,
];

const ANVIL_LEGACY_SM = [
  `${_Y}▄▄${R}    ${_Y}▄▄${R}`,
  `${_Y}██▄▄▄▄██${R}`,
  `${_Y}████████${R}`,
  `${_Y}████████${R}`,
  `${_c}▀████▀${R}`,
];

// Anvil — simplified eye-pair, used as the default fallback
const ANVIL_SM = [
  `${_Y}▄▄${R}  ${_Y}▄▄${R}`,
  `${_Y}████████${R}`,
  `${_Y}█${R}${_c}▀${R}${_Y}██${R}${_c}▀${R}${_Y}█${R}`,
  `${_Y}████████${R}`,
  `${_y}▀██████▀${R}`,
];

/** Map command IDs to their character sprite. */
const COMMAND_CHARACTERS = {
  forge:    FORGE_SM,
  maintain: WRENCH_SM,
  outhouse: WRENCH_SM,
  audit:    SENTRY_SM,
  aisle:    SENTRY_SM,
  export:   LENS_SM,
  dfe:      LENS_SM,
  recall:   SCOUT_SM,
  research: SCOUT_SM,
  infra:    PULSE_SM,
  debug:    DRIFT_SM,
  drift:    DRIFT_SM,
  studio:   SPARK_SM,
  '4ge':    PIXEL_SM,
  default:  ANVIL_SM,
};

/** Greetings keyed by command ID. */
const GREETINGS = {
  forge:    'Ready to forge. What are we building?',
  maintain: 'A few things need attention.',
  outhouse: 'Running outhouse scan.',
  audit:    'Let me take a look before something slips.',
  aisle:    'Security posture ready.',
  export:   'Ready to package the session.',
  dfe:      'AI-touched code detected. Standing by.',
  recall:   "Digging up what we know.",
  research: 'Research mode. What are we investigating?',
  infra:    'Checking container health.',
  debug:    'Tracing the call stack.',
  drift:    'Navigation mode.',
  studio:   'Studio mode ready.',
  '4ge':    'All systems nominal.',
  default:  'Standing by.',
};

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Strip all ANSI escape codes from a string. */
function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

/** Visible (printable) width of a potentially ANSI-decorated string. */
function visWidth(str) {
  return stripAnsi(str).length;
}

/** Pad a string to visible width `w`, filling with spaces on the right. */
function padRight(str, w) {
  const gap = w - visWidth(str);
  return str + (gap > 0 ? ' '.repeat(gap) : '');
}

/** Detect terminal column width, falling back to 80. */
function termCols() {
  return process.stdout.columns || 80;
}

/** Return true if the NO_COLOR env var is set (any non-empty value). */
function noColor() {
  return Boolean(process.env.NO_COLOR);
}

// ── Core renderer ────────────────────────────────────────────────────────────

/**
 * Build a context summary line from the context object.
 * @param {{ branch?: string, phase?: string, tests?: string }} ctx
 * @returns {string} plain string, no ANSI
 */
function buildContextLine(ctx) {
  if (!ctx || typeof ctx !== 'object') return '';
  const parts = [];
  if (ctx.branch)  parts.push(`branch: ${ctx.branch}`);
  if (ctx.phase)   parts.push(`phase: ${ctx.phase}`);
  if (ctx.tests)   parts.push(`tests: ${ctx.tests}`);
  // Allow arbitrary keys beyond the three named ones
  for (const [k, v] of Object.entries(ctx)) {
    if (!['branch', 'phase', 'tests'].includes(k) && v != null) {
      parts.push(`${k}: ${v}`);
    }
  }
  return parts.join(' | ');
}

/**
 * Render a borderless command card.
 *
 * @param {{
 *   sprite: string[],
 *   greeting: string,
 *   context?: Record<string, string>,
 *   options: Array<{ id: string, label: string, recommended?: boolean }>,
 *   tip?: string,
 *   palette?: Record<string, string>,
 * }} params
 * @returns {string} Multi-line string ready to print.
 */
function renderCommandCard({ sprite, greeting, context, options, tip, palette }) {
  const cols    = termCols();
  const plain   = noColor();
  const narrow  = cols < 50;

  // Palette helpers — fall back to raw strings when palette absent or NO_COLOR
  const ac = (role, text) => {
    if (plain || !palette || !palette[role]) return text;
    return `${palette[role]}${text}${palette.reset || R}`;
  };

  const spriteRows  = Array.isArray(sprite) ? sprite : [];
  const spriteVis   = 8; // max visible width of sprite column
  const gutterW     = 2; // space between sprite and content

  const contentIndent = narrow ? 0 : spriteVis + gutterW;

  const lines = [];

  // ── Sprite + Greeting block ──────────────────────────────────
  if (narrow) {
    // Narrow: sprite on its own lines, then content below
    if (!plain) {
      for (const row of spriteRows) lines.push(row);
    }
    lines.push('');
    lines.push(plain ? greeting : `${B}${ac('accent', greeting)}${R}`);
  } else {
    // Wide: sprite left, content right
    const ctxLine    = buildContextLine(context);
    const totalRows  = Math.max(spriteRows.length, 2);

    for (let i = 0; i < totalRows; i++) {
      const spCell = plain
        ? ' '.repeat(spriteVis)
        : padRight(spriteRows[i] || '', spriteVis);

      let textCell = '';
      if (i === 0) {
        textCell = plain ? greeting : `${B}${ac('accent', greeting)}${R}`;
      } else if (i === 1 && ctxLine) {
        textCell = plain ? ctxLine : ac('muted', ctxLine);
      }

      lines.push(spCell + ' '.repeat(gutterW) + textCell);
    }

    // If context line didn't fit alongside the sprite, add it now
    if (spriteRows.length < 2 && buildContextLine(context)) {
      const ctxLine2 = buildContextLine(context);
      lines.push(
        ' '.repeat(contentIndent) + (plain ? ctxLine2 : ac('muted', ctxLine2))
      );
    }
  }

  lines.push('');

  // ── Options ──────────────────────────────────────────────────
  const indent = ' '.repeat(contentIndent);
  if (Array.isArray(options) && options.length > 0) {
    for (let i = 0; i < options.length; i++) {
      const opt = options[i];
      const num = String(i + 1);
      const rec = opt.recommended;
      const badge = rec ? (plain ? ' [recommended]' : ` ${_Y}[recommended]${R}`) : '';

      if (plain) {
        const marker = rec ? '>' : ' ';
        lines.push(`${indent}${marker} ${num}  ${opt.label}${badge}`);
      } else {
        const numPart   = rec ? `${B}${ac('accent', num)}${R}` : ac('muted', num);
        const labelPart = rec ? `${B}${_W}${opt.label}${R}` : ac('text', opt.label);
        lines.push(`${indent}  ${numPart}  ${labelPart}${badge}`);
      }
    }
  }

  // ── Tip ──────────────────────────────────────────────────────
  if (tip) {
    lines.push('');
    const tipLine = `tip: ${tip}`;
    lines.push(indent + (plain ? tipLine : ac('muted', tipLine)));
  }

  return lines.join('\n');
}

// ── Convenience wrapper ──────────────────────────────────────────────────────

/**
 * Look up the sprite and greeting for a command, fetch ordered options,
 * then render and return the card string.
 *
 * @param {string} commandId - e.g. 'forge', 'audit'
 * @param {Array<{ id: string, label: string, baseScore: number }>} optionDefs
 * @param {Record<string, string>} [contextOverrides] - merged into the context line
 * @param {Record<string, string>} [palette] - hud-palette resolved palette object
 * @returns {string}
 */
function renderCard(commandId, optionDefs, contextOverrides, palette) {
  const sprite   = COMMAND_CHARACTERS[commandId] || COMMAND_CHARACTERS.default;
  const greeting = GREETINGS[commandId]          || GREETINGS.default;
  const options  = getOrderedOptions(commandId, Array.isArray(optionDefs) ? optionDefs : []);
  return renderCommandCard({
    sprite,
    greeting,
    context: contextOverrides || {},
    options,
    palette,
  });
}

// ── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  // Sprite constants
  FORGE_SM,
  SENTRY_SM,
  WRENCH_SM,
  SCOUT_SM,
  LENS_SM,
  DRIFT_SM,
  PULSE_SM,
  SPARK_SM,
  PIXEL_SM,
  ANVIL_LEGACY_SM,
  ANVIL_SM,
  // Character + greeting maps
  COMMAND_CHARACTERS,
  GREETINGS,
  // Renderers
  renderCommandCard,
  renderCard,
  // Utilities
  stripAnsi,
  visWidth,
};
