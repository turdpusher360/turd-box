'use strict';

// Canonical plugin-local copy of PROTECTED_HOOKS from lib/runtime-config-schema.cjs.
// IMPORTANT: If lib/runtime-config-schema.cjs changes, update this array to match.
// The config-integration test (T61) enforces sync automatically.
const PROTECTED_HOOKS = [
  'guard_git_scope',
  'guard_dns_exfil',
  'enforce_approved_agents',
  'file_content_secret_guard',
];

const REQUIRED_FIELDS = ['version', 'tier', 'hooks', 'agents', 'agent_routing'];

function validateRuntimeConfig(config) {
  const errors = [];

  for (const field of REQUIRED_FIELDS) {
    if (config[field] === undefined) {
      errors.push(`Missing required field: ${field}`);
    }
  }

  if (!config.profile) {
    errors.push('Missing required field: profile');
  }

  if (config.version && !/^\d+\.\d+\.\d+$/.test(config.version)) {
    errors.push(`version: "${config.version}" does not match pattern X.Y.Z`);
  }

  if (config.tier && !['lite', 'standard', 'full'].includes(config.tier)) {
    errors.push(`tier: "${config.tier}" not in allowed values [lite, standard, full]`);
  }

  if (config.hooks && typeof config.hooks === 'object') {
    for (const hook of PROTECTED_HOOKS) {
      if (config.hooks[hook] === false) {
        errors.push(
          `Protected hook "${hook}" cannot be disabled. Security-critical hooks always run.`
        );
      }
    }
  }

  return errors;
}

module.exports = { PROTECTED_HOOKS, validateRuntimeConfig };
