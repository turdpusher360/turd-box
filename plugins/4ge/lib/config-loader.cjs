'use strict';

const fs = require('fs');
const path = require('path');

// Example repo profiles. These are neutral placeholders that demonstrate the
// detection mechanism. To define a profile for your own repository, add an entry
// here (or supply one via a local, non-shipped config) with `signals` that are
// directory/path markers unique to that repo and a `min_matches` threshold.
const REPO_PROFILES = {
  'example-monorepo': {
    description: 'Full-stack monorepo with the complete Agentic OS, multi-agent teams, and autoresearch',
    signals: ['lib/os/kernel', 'plugins/4ge', 'scripts/autoresearch', 'claude-commander'],
    min_matches: 3,
  },
  'example-webapp': {
    description: 'Web/app project — TypeScript, React Native, Cloudflare Workers, local LLM',
    signals: ['packages/core', 'packages/widget-sdk', 'packages/memory', 'packages/dashboard'],
    min_matches: 2,
  },
  'example-api': {
    description: 'API/service project — TypeScript, Cloudflare Workers (Hono), enterprise connectors',
    signals: ['packages/api', 'apps/service', 'apps/router', 'domain'],
    min_matches: 2,
  },
};

const MARKER_FILE = path.join('plugins', '4ge', '.tier3-profile');

function detectRepoProfile(projectRoot) {
  const markerPath = path.join(projectRoot, MARKER_FILE);
  if (!fs.existsSync(markerPath)) return 'generic';

  let markerProfile = '';
  try {
    markerProfile = fs.readFileSync(markerPath, 'utf8').trim();
    if (markerProfile.length > 64) return 'generic';
  } catch {
    return 'generic';
  }

  if (!REPO_PROFILES[markerProfile]) return 'generic';

  const profile = REPO_PROFILES[markerProfile];
  let matchCount = 0;
  for (const signal of profile.signals) {
    if (fs.existsSync(path.join(projectRoot, signal))) matchCount++;
  }
  if (matchCount < profile.min_matches) return 'generic';

  return markerProfile;
}

function loadConfig(projectRoot) {
  const configPath = path.join(projectRoot, '.4ge', 'config.json');
  if (!fs.existsSync(configPath)) return { loaded: false, config: null };
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return { loaded: true, config };
  } catch (err) {
    return { loaded: false, config: null, error: err.message };
  }
}

module.exports = { loadConfig, detectRepoProfile, REPO_PROFILES };
