'use strict';
// companion-config.cjs — Loads companion tuning knobs from .4ge/config.json.
// Returns merged config with hardcoded defaults. Zero-crash: returns defaults on any error.

const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULTS = {
  // companion-state.cjs timing
  decayMs: 3000,
  dwellMs: 2000,
  idleThresholdS: 30,
  longIdleS: 300,
  veryLongIdleS: 600,
  contextWarnPct: 50,
  contextSleepyPct: 35,
  highToolCount: 200,
  blinkInterval: 25000,

  // hud-braille-orb.cjs rendering
  animate: true,               // master gate: false = byte-identical frozen statusline (mobile escape hatch)
  breathScaleMin: 0.80,
  breathScaleMax: 0.85,
  shimmer: true,
  colorWaveSpeed: 400,
  colorWaveFrames: 12,
  colorTop: [39, 63, 39],
  colorBot: [63, 39, 63],

  // insight engine
  insights: {
    enabled: true,
    rotationMs: 45000,
    tone: 'warm',
  },
};

let _cached = null;
let _cachedAt = 0;
const CACHE_TTL = 10000; // re-read config at most every 10s

// Read the `companion` block from a .4ge/config.json under `dir`.
// Zero-crash: missing file, unreadable file, or invalid JSON → {}.
function _readCompanionBlock(dir) {
  if (!dir) return {};
  const configPath = path.join(dir, '.4ge', 'config.json');
  try {
    if (fs.existsSync(configPath)) {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      return (raw && typeof raw.companion === 'object' && raw.companion) || {};
    }
  } catch { /* defaults */ }
  return {};
}

function loadCompanionConfig(projectRoot) {
  const now = Date.now();
  if (_cached && (now - _cachedAt) < CACHE_TTL) return _cached;

  const root = projectRoot || process.env.CLAUDE_PROJECT_DIR || process.cwd();

  // Precedence: DEFAULTS < homedir global (~/.4ge/config.json, written by
  // first-run.cjs) < project-local (<root>/.4ge/config.json). first-run writes
  // to homedir, so without the homedir read a completed setup would still get
  // DEFAULTS (the silent companion-customization-is-dead bug).
  let homeDir = null;
  try { homeDir = os.homedir(); } catch { homeDir = null; }
  const homeConfig = (homeDir && homeDir !== root) ? _readCompanionBlock(homeDir) : {};
  const projectConfig = _readCompanionBlock(root);
  const userConfig = { ...homeConfig, ...projectConfig };

  // Shallow merge: user overrides win, with nested insights merge
  const merged = { ...DEFAULTS, ...userConfig };
  merged.insights = {
    ...DEFAULTS.insights,
    ...homeConfig.insights,
    ...projectConfig.insights,
  };

  // Validate array fields
  if (!Array.isArray(merged.colorTop) || merged.colorTop.length !== 3) merged.colorTop = DEFAULTS.colorTop;
  if (!Array.isArray(merged.colorBot) || merged.colorBot.length !== 3) merged.colorBot = DEFAULTS.colorBot;

  // Validate numeric ranges — clamp to sane bounds
  const clamp = (key, min, max) => {
    if (typeof merged[key] !== 'number' || merged[key] < min || merged[key] > max) merged[key] = DEFAULTS[key];
  };
  // Rendering params
  clamp('breathScaleMin', 0.1, 1.0);
  clamp('breathScaleMax', 0.1, 1.0);
  clamp('colorWaveSpeed', 50, 5000);
  clamp('colorWaveFrames', 2, 60);
  // Timing params — prevent freeze (0) or strobe (negative)
  clamp('decayMs', 100, 30000);
  clamp('dwellMs', 100, 30000);
  clamp('idleThresholdS', 1, 600);
  clamp('longIdleS', 10, 3600);
  clamp('veryLongIdleS', 30, 7200);
  clamp('contextWarnPct', 10, 95);
  clamp('contextSleepyPct', 5, 90);
  clamp('highToolCount', 10, 10000);
  clamp('blinkInterval', 1000, 120000);
  // Ensure breathScaleMin <= breathScaleMax
  if (merged.breathScaleMin > merged.breathScaleMax) {
    merged.breathScaleMin = DEFAULTS.breathScaleMin;
    merged.breathScaleMax = DEFAULTS.breathScaleMax;
  }
  // Coerce animate to a real boolean — a stray string can't read as truthy accidentally
  merged.animate = (merged.animate !== false);   // default true; only explicit false disables
  // Validate insights.tone — restrict to known values
  const VALID_TONES = ['warm', 'technical', 'minimal'];
  if (!VALID_TONES.includes(merged.insights.tone)) {
    merged.insights.tone = DEFAULTS.insights.tone;
  }

  _cached = merged;
  _cachedAt = now;
  return merged;
}

function clearCache() {
  _cached = null;
  _cachedAt = 0;
}

module.exports = { loadCompanionConfig, clearCache, DEFAULTS };
