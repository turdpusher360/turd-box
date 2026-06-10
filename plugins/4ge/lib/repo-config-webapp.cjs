'use strict';

const { PROTECTED_HOOKS } = require('./security-constants.cjs');

function generateWebappConfig() {
  const hooks = {};
  for (const hook of PROTECTED_HOOKS) { hooks[hook] = true; }

  Object.assign(hooks, {
    post_edit_typecheck: true, task_staleness_scan: true, console_log_stop_audit: true,
    scope_auto_scan: true, permission_auto_decide: true, pre_write_check: true,
    react_patterns: true, hono_patterns: true, motion_perf: true, a11y_patterns: true,
    large_output_compress: true,
    task_completed_verify: { enabled: true, commands: ['npx tsc --noEmit', 'npx eslint .', 'npx vitest run --changed HEAD'] },
  });

  return {
    version: '2.1.0', tier: 'full', profile: 'example-webapp',
    detected: { language: 'typescript', framework: 'react', package_manager: 'npm', testing: 'vitest', cloud: 'cloudflare', monorepo: 'turborepo', ci_cd: '', docker: true },
    hooks,
    agents: {
      core_team: true,
      specialists: ['streaming-specialist', 'mobile-specialist', 'overlay-specialist', 'cloudflare-specialist'],
      model_routing: { judgment: 'opus', execution: 'sonnet', minimum: 'sonnet' },
    },
    agent_routing: {
      weights: { description_keyword_match: 0.6, task_verb_match: 0.3, recent_usage_bonus: 0.1 },
      aliases: { 'stream': 'streaming-specialist', 'mobile': 'mobile-specialist', 'overlay': 'overlay-specialist', 'cf': 'cloudflare-specialist' },
    },
    os_layer: { enabled: true, modules: 24, capabilities: 13 },
    memory: { hub_url: 'http://localhost:8091', protocol: 'streamable-http', scope: 'domain:webapp' },
    gpu_aware: true, ollama_integration: true,
    custom_rules: ['streaming-overlay-patterns', 'core-command-conventions', 'cf-worker-edge-patterns'],
    design_suite: { enabled: true, modes: ['visual', 'api', 'system'], default_mode: 'visual' },
    telemetry: { enabled: true, retention_days: 90 },
    trust: { level: 'assisted', score: 15, thresholds: { assisted: 10, autonomous: 25 } },
    lounge: { enabled: true, max_options: 4 },
    domain_banned_terms: [], eject_manifest: {},
  };
}

module.exports = { generateWebappConfig };
