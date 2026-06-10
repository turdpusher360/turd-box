'use strict';

const { PROTECTED_HOOKS } = require('./security-constants.cjs');

function generateMonorepoConfig() {
  const hooks = {};
  for (const hook of PROTECTED_HOOKS) { hooks[hook] = true; }

  Object.assign(hooks, {
    post_edit_typecheck: true, task_staleness_scan: true, console_log_stop_audit: true,
    scope_auto_scan: true, permission_auto_decide: true, pre_write_check: true,
    react_patterns: true, hono_patterns: true, a11y_patterns: true, motion_perf: true,
    validate_doc_on_save: true, research_trigger: true, large_output_compress: true,
    ghost_reversion_guard: true, memory_protocol_check: true, post_edit_format: true,
    task_completed_verify: { enabled: true, commands: ['npx tsc --noEmit', 'npx eslint .', 'npx vitest run --changed HEAD'] },
  });

  return {
    version: '2.1.0', tier: 'full', profile: 'example-monorepo',
    detected: { language: 'typescript', framework: 'vite', package_manager: 'npm', testing: 'vitest', cloud: 'cloudflare', monorepo: '', ci_cd: '', docker: true },
    hooks,
    agents: {
      core_team: true,
      specialists: ['sonnet-execute', 'sonnet-research', 'opus-review'],
      audit_team: ['master-auditor', 'opus-audit'],
      model_routing: { judgment: 'opus', execution: 'sonnet', minimum: 'sonnet' },
    },
    agent_routing: {
      weights: { description_keyword_match: 0.6, task_verb_match: 0.3, recent_usage_bonus: 0.1 },
      aliases: { 'impl': 'sonnet-execute', 'review': 'opus-review', 'DFE': 'DFE', 'sec': 'opus-review' },
    },
    os_layer: { enabled: true, modules: 24, capabilities: 13 },
    memory: { hub_url: 'http://localhost:8091', protocol: 'streamable-http', scope: 'domain:monorepo' },
    autoresearch: { enabled: true, domains: 94 },
    design_suite: { enabled: true, modes: ['visual', 'api', 'data', 'system'], default_mode: 'system' },
    telemetry: { enabled: true, retention_days: 90, session_log_path: '_runs/os/resource-ledger.jsonl' },
    trust: { level: 'autonomous', score: 30, thresholds: { assisted: 10, autonomous: 25 } },
    lounge: { enabled: true, max_options: 4 },
    domain_banned_terms: [], eject_manifest: {},
  };
}

module.exports = { generateMonorepoConfig };
