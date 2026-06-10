'use strict';

const { PROTECTED_HOOKS } = require('./security-constants.cjs');

function generateApiConfig() {
  const hooks = {};
  for (const hook of PROTECTED_HOOKS) { hooks[hook] = true; }

  Object.assign(hooks, {
    post_edit_typecheck: true, task_staleness_scan: true, console_log_stop_audit: true,
    scope_auto_scan: true, permission_auto_decide: true, pre_write_check: true,
    hono_patterns: true, a11y_patterns: true,
    task_completed_verify: { enabled: true, commands: ['npx tsc --noEmit', 'npx eslint .', 'npx vitest run --changed HEAD'] },
  });

  return {
    version: '2.1.0', tier: 'standard', profile: 'example-api',
    detected: { language: 'typescript', framework: 'hono', package_manager: 'npm', testing: 'vitest', cloud: 'cloudflare', monorepo: 'turborepo', ci_cd: 'github', docker: false },
    hooks,
    agents: {
      core_team: true,
      specialists: ['d365-specialist', 'teams-specialist', 'safety-specialist', 'cloudflare-specialist'],
      model_routing: { judgment: 'opus', execution: 'sonnet', minimum: 'sonnet' },
    },
    agent_routing: {
      weights: { description_keyword_match: 0.6, task_verb_match: 0.3, recent_usage_bonus: 0.1 },
      aliases: { 'd365': 'd365-specialist', 'teams': 'teams-specialist', 'safety': 'safety-specialist', 'cf': 'cloudflare-specialist' },
    },
    os_layer: { enabled: true, modules: 24, capabilities: 13 },
    memory: { hub_url: 'http://localhost:8091', protocol: 'streamable-http', scope: 'domain:api' },
    custom_rules: ['safety-escalation-patterns', 'd365-entity-conventions', 'pwa-offline-first-patterns'],
    design_suite: { enabled: true, modes: ['api', 'data', 'system'], default_mode: 'api' },
    telemetry: { enabled: true, retention_days: 90 },
    trust: { level: 'guided', score: 0, thresholds: { assisted: 10, autonomous: 25 } },
    lounge: { enabled: false, max_options: 4 },
    domain_banned_terms: [], eject_manifest: {},
  };
}

module.exports = { generateApiConfig };
