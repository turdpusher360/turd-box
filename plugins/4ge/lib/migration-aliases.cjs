'use strict';

const UNIVERSAL_ALIASES = {
  'impl': 'sonnet-execute',
  'review': 'opus-review',
  'DFE': 'DFE',
  'sec': 'opus-review',
  'plan': 'opus-planner',
  'ops': 'general-purpose',
  'test': 'sonnet-execute',
  'guide': 'general-purpose',
  'research': 'sonnet-research',
};

// Example per-profile alias maps. Keys match the placeholder profiles in
// config-loader.cjs (example-monorepo / example-webapp / example-api). Define
// aliases for your own profile by adding an entry keyed to its profile name.
const REPO_ALIASES = {
  'example-monorepo': {
    'cf': 'sonnet-execute',
    'd365': 'sonnet-research',
    'teams': 'sonnet-research',
  },
  'example-webapp': {
    'stream': 'sonnet-execute',
    'mobile': 'sonnet-execute',
    'overlay': 'sonnet-execute',
    'cf': 'sonnet-execute',
  },
  'example-api': {
    'd365': 'sonnet-research',
    'teams': 'sonnet-research',
    'safety': 'opus-review',
    'cf': 'sonnet-execute',
  },
};

function resolveAlias(alias, profile) {
  const repoSpecific = REPO_ALIASES[profile] || {};
  if (alias in repoSpecific) return repoSpecific[alias];
  if (UNIVERSAL_ALIASES[alias]) return UNIVERSAL_ALIASES[alias];
  return null;
}

function getUniversalAliases() { return { ...UNIVERSAL_ALIASES }; }
function getRepoAliases(profile) { return { ...REPO_ALIASES[profile] }; }

function validateAliasChain(profile, customAliases) {
  const aliases = {
    ...UNIVERSAL_ALIASES,
    ...REPO_ALIASES[profile],
    ...customAliases,
  };
  const cycles = [];

  for (const [alias, target] of Object.entries(aliases)) {
    if (target === alias) continue;
    const visited = new Set([alias]);
    let current = target;
    while (aliases[current]) {
      if (visited.has(current)) {
        cycles.push(`${alias} -> ${[...visited].join(' -> ')} -> ${current}`);
        break;
      }
      visited.add(current);
      current = aliases[current];
    }
  }

  return { valid: cycles.length === 0, cycles };
}

module.exports = { resolveAlias, getUniversalAliases, getRepoAliases, validateAliasChain };
