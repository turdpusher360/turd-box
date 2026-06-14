'use strict';
// companion-config-writer.cjs — the single read-merge-write primitive for the
// `companion` block of .4ge/config.json (Wave 1, OPP-1 in interaction-config.md).
//
// WHY THIS EXISTS: companion-config.cjs is a pure LOADER — nothing in the plugin
// ever wrote the `companion` block, so every knob was dark to users. This writer
// closes that gap. The /hud setter subcommands and the update-ack flow call it.
//
// CRITICAL: this does a READ-MERGE-WRITE preserving EVERY other top-level key
// (setupComplete / tier / version / hooks). It must NOT whole-file overwrite —
// that is the first-run.cjs::completeSetup trap (interaction-config.md §1.4) that
// would nuke setup/tier/hooks.

const fs = require('fs');
const path = require('path');
const os = require('os');

let writeFileAtomic;
try {
  writeFileAtomic = require('../lib/atomic-write.cjs').writeFileAtomic;
} catch {
  // Fallback: inline tmp+rename if the shared helper can't be loaded.
  writeFileAtomic = function (targetPath, content) {
    const tmp = `${targetPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, targetPath);
  };
}

// Resolve the plugin version for the ack/update-drift stamp. Prefer plugin.json;
// fall back to first-run.cjs PLUGIN_VERSION; fail-soft to null.
function _pluginVersion() {
  try {
    const pj = require('../.claude-plugin/plugin.json');
    if (pj && typeof pj.version === 'string') return pj.version;
  } catch { /* try next */ }
  try {
    const fr = require('../lib/first-run.cjs');
    if (fr && typeof fr.PLUGIN_VERSION === 'string') return fr.PLUGIN_VERSION;
  } catch { /* give up */ }
  return null;
}

function _resolveConfigPath(opts) {
  const o = opts || {};
  if (o.global) {
    let homeDir = null;
    try { homeDir = os.homedir(); } catch { homeDir = null; }
    const root = homeDir || o.projectRoot || process.cwd();
    return path.join(root, '.4ge', 'config.json');
  }
  const root = o.projectRoot || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  return path.join(root, '.4ge', 'config.json');
}

// Read the whole config object (zero-crash: missing/corrupt → {}).
function _readWholeConfig(configPath) {
  try {
    if (fs.existsSync(configPath)) {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (raw && typeof raw === 'object') return raw;
    }
  } catch { /* corrupt → start fresh, preserving nothing we can't parse */ }
  return {};
}

/**
 * setCompanionKeys — merge `patch` into the companion block of .4ge/config.json,
 * preserving all sibling top-level keys. Stamps companion._version with the
 * current plugin version so the update-aware prompt can diff against it.
 *
 * @param {object} patch - shallow companion-block keys to set (e.g. { faceMotion: true }).
 *                         A nested `insights` object is shallow-merged into the existing one.
 * @param {object} [opts] - { global?: boolean, projectRoot?: string, stampVersion?: boolean }
 *                         stampVersion defaults true; pass false to write without touching _version.
 * @returns {{ path: string, companion: object }} the resolved path and the written companion block.
 */
function setCompanionKeys(patch, opts) {
  const o = opts || {};
  const configPath = _resolveConfigPath(o);
  const whole = _readWholeConfig(configPath);

  const prevCompanion = (whole.companion && typeof whole.companion === 'object') ? whole.companion : {};
  const nextCompanion = { ...prevCompanion };

  if (patch && typeof patch === 'object') {
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'insights' && v && typeof v === 'object') {
        nextCompanion.insights = { ...prevCompanion.insights, ...v };
      } else if (k === 'zones' && v && typeof v === 'object') {
        nextCompanion.zones = { ...prevCompanion.zones, ...v };
      } else {
        nextCompanion[k] = v;
      }
    }
  }

  if (o.stampVersion !== false) {
    const ver = _pluginVersion();
    if (ver) nextCompanion._version = ver;
  }

  whole.companion = nextCompanion;

  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  writeFileAtomic(configPath, JSON.stringify(whole, null, 2));

  // Best-effort: clear the loader cache so a same-process re-read sees the write
  // immediately (cross-process picks it up within the 10s TTL).
  try { require('./companion-config.cjs').clearCache(); } catch { /* non-fatal */ }

  return { path: configPath, companion: nextCompanion };
}

module.exports = { setCompanionKeys, _resolveConfigPath, _pluginVersion };
