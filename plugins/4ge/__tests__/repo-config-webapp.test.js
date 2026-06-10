import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const cjsRequire = createRequire(import.meta.url);
const { generateWebappConfig } = cjsRequire('../lib/repo-config-webapp.cjs');
const { validateRuntimeConfig, PROTECTED_HOOKS } = cjsRequire('../lib/security-constants.cjs');

describe('repo-config-webapp', () => {
  const config = generateWebappConfig();

  it('generates a valid runtime config', () => {
    const errors = validateRuntimeConfig(config);
    expect(errors).toEqual([]);
  });

  it('sets tier to full', () => { expect(config.tier).toBe('full'); });
  it('sets profile to example-webapp', () => { expect(config.profile).toBe('example-webapp'); });

  it('enables all protected hooks', () => {
    for (const hook of PROTECTED_HOOKS) {
      expect(config.hooks[hook], `Protected hook ${hook} must not be disabled`).not.toBe(false);
      expect(config.hooks[hook]).toBeTruthy();
    }
  });

  it('includes streaming-specific specialists', () => {
    expect(config.agents.specialists).toContain('streaming-specialist');
    expect(config.agents.specialists).toContain('mobile-specialist');
    expect(config.agents.specialists).toContain('overlay-specialist');
  });

  it('enables react_patterns and motion_perf hooks', () => {
    expect(config.hooks.react_patterns).toBe(true);
    expect(config.hooks.motion_perf).toBe(true);
  });

  it('enables hono_patterns for CF Workers', () => { expect(config.hooks.hono_patterns).toBe(true); });

  it('is GPU-aware and has Ollama integration', () => {
    expect(config.gpu_aware).toBe(true);
    expect(config.ollama_integration).toBe(true);
  });

  it('scopes memory to domain:webapp', () => { expect(config.memory.scope).toBe('domain:webapp'); });

  it('includes custom rules for streaming patterns', () => {
    expect(config.custom_rules).toContain('streaming-overlay-patterns');
    expect(config.custom_rules).toContain('core-command-conventions');
    expect(config.custom_rules).toContain('cf-worker-edge-patterns');
  });

  it('has streaming alias in agent_routing', () => {
    expect(config.agent_routing.aliases['stream']).toBe('streaming-specialist');
  });
});
