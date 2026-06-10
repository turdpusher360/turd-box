// plugins/4ge/hooks/4ge-hook-utils-v2.cjs
'use strict';

const fs = require('fs');
const path = require('path');

const SAFE_DEFAULTS = {
  version: '2.1.0',
  tier: 'standard',
  design_suite: { enabled: false, modes: ['visual', 'api', 'data', 'system'], default_mode: 'visual' },
  telemetry: { enabled: false, retention_days: 90 },
  trust: { level: 'guided', score: 0 },
  lounge: { enabled: false, max_options: 4 },
};

/**
 * Reads .4ge/config.json with safe defaults for missing Tier 2 sections.
 */
function read4geConfig(root) {
  const configPath = path.join(root, '.4ge', 'config.json');
  let config = {};

  if (fs.existsSync(configPath)) {
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch { /* fall through to defaults */ }
  }

  return {
    ...SAFE_DEFAULTS,
    ...config,
    design_suite: { ...SAFE_DEFAULTS.design_suite, ...(config.design_suite || {}) },
    telemetry: { ...SAFE_DEFAULTS.telemetry, ...(config.telemetry || {}) },
    trust: { ...SAFE_DEFAULTS.trust, ...(config.trust || {}) },
    lounge: { ...SAFE_DEFAULTS.lounge, ...(config.lounge || {}) },
  };
}

/**
 * Appends a JSON entry as a line to a JSONL file.
 */
function appendJsonl(filePath, entry) {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(filePath, JSON.stringify(entry) + '\n');
  } catch { /* best effort */ }
}

/**
 * Reads the most recent N entries from a JSONL file.
 */
function readRecentJsonl(filePath, limit) {
  if (!fs.existsSync(filePath)) return [];

  try {
    const stat = fs.statSync(filePath);
    if (stat.size > 1_000_000) return []; // bail on files > 1MB (hook budget safety)
    const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean);
    const parsed = lines
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
    return parsed.slice(-limit).reverse();
  } catch {
    return [];
  }
}

module.exports = { read4geConfig, appendJsonl, readRecentJsonl, SAFE_DEFAULTS };
