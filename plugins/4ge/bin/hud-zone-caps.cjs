'use strict';

const path = require('path');
const { colorize, isNoColor } = require('./hud-palette.cjs');

// --- Zone Metadata ---
const ZONE_META = { priority: 6, minRows: 1, idealRows: 2 };

// --- Capability Display Order ---
// Source of truth: `lib/os/capabilities/*.cjs` (9 real capabilities as of S240).
// Ordered by boot layer (kernel → services → caps) to match boot-screen.cjs grouping.
// A cap in this list is only rendered if it's present in state.os.capabilities;
// entries missing from state are silently skipped (no phantom rendering).
// Caps present in state but not in this list are appended after in insertion order.
const CAP_ORDER = [
  // Kernel layer
  'forge-session', 'git', 'file-integrity', 'process-health',
  // Services layer
  'infra',
  // Caps layer
  'audit', 'forge', 'autoresearch', 'aisle',
];

// --- Compact Cap Name ---
// Short labels for the cap grid. Long names get abbreviated to fit the 10-char
// padding; short names pass through. Every real capability should have an
// entry here OR a natural name ≤10 chars.
const CAP_SHORT = {
  'forge-session': 'forge-s',
  'file-integrity': 'files',
  'process-health': 'process',
  'autoresearch': 'autores',
  // Naturally short (≤10 chars) — no remapping needed:
  //   git, infra, audit, forge, aisle
};

// --- Capability File Map ---
// Maps full capability names to their .cjs file in lib/os/capabilities/.
// Used by osc8CapLink() to produce file:// hyperlinks.
const CAP_FILES = {
  'forge-session': 'forge-session.cjs',
  'git':           'git.cjs',
  'file-integrity': 'file-integrity.cjs',
  'process-health': 'process-health.cjs',
  'infra':         'infra.cjs',
  'audit':         'audit.cjs',
  'forge':         'forge.cjs',
  'autoresearch':  'autoresearch.cjs',
  'aisle':         'aisle.cjs',
};

// Resolve the capabilities directory once (absolute path for file:// URLs).
const CAPS_DIR = path.resolve(__dirname, '..', '..', '..', 'lib', 'os', 'capabilities');

// --- OSC 8 Hyperlink Helper ---
// Wraps text in an OSC 8 escape sequence that makes it a clickable file:// link
// in terminals that support it (iTerm2, WezTerm, Ghostty, Windows Terminal).
// Falls back to plain text in unsupported terminals and when NO_COLOR is set.
function osc8Link(url, text) {
  return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

// Wraps a capability display name with an OSC 8 link to its source file.
// Returns plain text when NO_COLOR is set or the cap has no known file.
function osc8CapLink(fullName, displayText) {
  if (isNoColor()) return displayText;
  const file = CAP_FILES[fullName];
  if (!file) return displayText;
  const filePath = path.join(CAPS_DIR, file).replace(/\\/g, '/');
  return osc8Link(`file:///${filePath}`, displayText);
}

// --- Zone Renderer ---
// Capabilities grid: colored dots + names in rows of 5.
// Renders ONLY caps that exist in state.os.capabilities — no phantom entries.
function renderCapsZone(state, palette) {
  const caps = (state.os && state.os.capabilities) || {};
  const lines = [];

  // Build the display list: preferred order first (only if present in state),
  // then any stragglers from state not in the preferred list.
  const items = [];
  const seen = new Set();

  for (const name of CAP_ORDER) {
    if (!(name in caps)) continue;
    const cap = caps[name];
    const ok = cap && cap.ok !== false;
    const short = CAP_SHORT[name] || name;
    items.push({ name: short, ok, fullName: name });
    seen.add(name);
  }

  for (const [name, cap] of Object.entries(caps)) {
    if (seen.has(name)) continue;
    const ok = cap && cap.ok !== false;
    const short = CAP_SHORT[name] || name.slice(0, 10);
    items.push({ name: short, ok, fullName: name });
  }

  // Empty state — no caps reported
  if (items.length === 0) {
    lines.push('  ' + colorize(palette, 'muted', 'no capability data'));
    return lines;
  }

  // All ready? Compact single-line
  const allReady = items.every((i) => i.ok);
  if (allReady) {
    lines.push('  ' + colorize(palette, 'ok', `\u25CF all ${items.length} ready`));
    return lines;
  }

  // Render in rows of 5
  const perRow = 5;
  for (let i = 0; i < items.length; i += perRow) {
    const row = items.slice(i, i + perRow);
    const parts = row.map((item) => {
      const dotColor = item.ok ? 'ok' : 'error';
      const label = osc8CapLink(item.fullName, item.name.padEnd(10));
      return colorize(palette, dotColor, '\u25CF') + ' ' + colorize(palette, 'muted', label);
    });
    lines.push('  ' + parts.join(''));
  }

  return lines;
}

module.exports = { renderCapsZone, ZONE_META, CAP_ORDER, CAP_SHORT, CAP_FILES, osc8Link, osc8CapLink };
