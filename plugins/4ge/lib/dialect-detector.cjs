'use strict';

const fs = require('fs');
const path = require('path');

const CURRENT_VERSION = '2.1.0';
const DIALECT_STATES = ['fresh', 'partial', 'configured'];

/**
 * Fingerprints a repo to determine its 4ge state.
 *
 * @param {string} root - Project root path
 * @returns {{ state: string, drift: boolean, version: string|null, tier: string|null, details: object }}
 */
function detectDialect(root) {
  const configPath = path.join(root, '.4ge', 'config.json');
  const blueprintPath = path.join(root, '.blueprint-config.json');

  const hasConfig = fs.existsSync(configPath);
  const hasBlueprint = fs.existsSync(blueprintPath);

  if (!hasConfig && !hasBlueprint) {
    return { state: 'fresh', drift: false, version: null, tier: null, details: {} };
  }

  if (!hasConfig && hasBlueprint) {
    return { state: 'partial', drift: false, version: null, tier: null, details: { hasBlueprint: true } };
  }

  // Config exists — check for drift
  let config = {};
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return { state: 'configured', drift: true, version: null, tier: null, details: { parseError: true } };
  }

  const version = config.version || null;
  const drift = version !== CURRENT_VERSION;

  return {
    state: 'configured',
    drift,
    version,
    tier: config.tier || null,
    details: {
      hooksEnabled: config.hooks ? Object.keys(config.hooks).filter(k => config.hooks[k] === true).length : 0,
      agentsEnabled: config.agents && config.agents.core_team,
    },
  };
}

/**
 * Recommends the next action based on dialect state.
 *
 * @param {{ state: string, drift?: boolean }} dialect
 * @returns {{ command: string|null, message: string }}
 */
function recommendAction(dialect) {
  if (dialect.state === 'fresh') {
    return { command: '/blueprint setup', message: 'No 4ge configuration found. Run /blueprint setup to get started.' };
  }
  if (dialect.state === 'partial') {
    return { command: '/blueprint setup', message: 'Partial setup detected (.blueprint-config.json exists but .4ge/ missing). Run /blueprint setup to complete.' };
  }
  if (dialect.drift) {
    return { command: '/blueprint update', message: `Config drift detected (v${dialect.version} → v${CURRENT_VERSION}). Run /blueprint update to sync.` };
  }
  return { command: null, message: `4ge v${dialect.version} is up to date (${dialect.tier} tier).` };
}

/**
 * Vertical indicator patterns.
 * Each entry maps file/directory signals to a vertical suggestion.
 * The first vertical with >= min_matches signals wins.
 */
const VERTICAL_INDICATORS = {
  devops: {
    signals: ['Dockerfile', 'docker-compose.yml', 'docker-compose.yaml', '.github/workflows', 'terraform', 'Jenkinsfile', 'k8s', '.gitlab-ci.yml'],
    min_matches: 1,
  },
  datascience: {
    signals: ['*.ipynb', 'notebooks', 'requirements.txt', 'environment.yml', 'setup.py', 'pyproject.toml'],
    min_matches: 2,
  },
  legal: {
    signals: ['LICENSES', 'compliance', '.licensrc', 'LICENSE-THIRD-PARTY', 'NOTICE'],
    min_matches: 2,
  },
};

/**
 * Suggest a vertical based on detected file/directory patterns.
 * Returns the first matching vertical name, or null if no match.
 *
 * @param {string} root - project root path
 * @returns {string|null} suggested vertical name
 */
function suggestVertical(root) {
  for (const [vertical, config] of Object.entries(VERTICAL_INDICATORS)) {
    let matches = 0;
    for (const signal of config.signals) {
      // Handle glob-like patterns (*.ext) by scanning directory
      if (signal.startsWith('*.')) {
        const ext = signal.slice(1); // '.ipynb'
        try {
          const entries = fs.readdirSync(root);
          if (entries.some(e => e.endsWith(ext))) {
            matches++;
          }
        } catch {
          // unreadable directory, skip
        }
      } else {
        if (fs.existsSync(path.join(root, signal))) {
          matches++;
        }
      }
      // Early exit once threshold met
      if (matches >= config.min_matches) break;
    }
    if (matches >= config.min_matches) return vertical;
  }
  return null;
}

module.exports = { detectDialect, recommendAction, suggestVertical, VERTICAL_INDICATORS, DIALECT_STATES, CURRENT_VERSION };
