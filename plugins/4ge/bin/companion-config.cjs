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
  messageCooldownS: 45,        // min seconds between non-critical popup messages (global rate limiter; critical bypasses)
  minDwellFlashMs: 6000,       // minimum visible time before peer flash messages can replace it
  minDwellSignalMs: 10000,     // minimum visible time before peer signal messages can replace it
  minDwellCriticalMs: 15000,   // minimum visible time before peer critical messages can replace it

  // motion / message control (Wave 1)
  faceMotion: false,           // false = calm steady eyes (default); true = per-tool thinking/exhausted glyph swap (e4d905d2 behavior)
  zen: false,                  // master quiet flag: forces calm idle + MAJOR-only messages + faceMotion off
  messages: 'all',             // 'all' (flash+signal+critical) | 'major' (MAJOR events only) | 'off' (suppress all companion messages)
  anomalyRow: false,           // false = legacy anomaly text bubble; true = persistent statusline row suppresses anomaly bubble

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
  clamp('messageCooldownS', 0, 600);
  clamp('minDwellFlashMs', 0, 120000);
  clamp('minDwellSignalMs', 0, 120000);
  clamp('minDwellCriticalMs', 0, 120000);
  // Ensure breathScaleMin <= breathScaleMax
  if (merged.breathScaleMin > merged.breathScaleMax) {
    merged.breathScaleMin = DEFAULTS.breathScaleMin;
    merged.breathScaleMax = DEFAULTS.breathScaleMax;
  }
  // Coerce animate to a real boolean — a stray string can't read as truthy accidentally
  merged.animate = (merged.animate !== false);   // default true; only explicit false disables
  // Coerce faceMotion + zen to real booleans. These are DEFAULT-FALSE flags, so use
  // the `=== true` idiom (NOT animate's `!== false`): a bad/typo'd value must fall to
  // calm (false), never accidentally enable motion. Only an explicit literal true enables.
  merged.faceMotion = (merged.faceMotion === true);
  merged.zen = (merged.zen === true);
  merged.anomalyRow = (merged.anomalyRow === true);
  // Validate messages enum — restrict to known levels, default 'all' on bad input
  const VALID_MESSAGE_LEVELS = ['all', 'major', 'off'];
  if (!VALID_MESSAGE_LEVELS.includes(merged.messages)) {
    merged.messages = DEFAULTS.messages;
  }
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
