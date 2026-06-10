import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const cjsRequire = createRequire(import.meta.url);
const { generateApiConfig } = cjsRequire('../lib/repo-config-api.cjs');
const { validateRuntimeConfig, PROTECTED_HOOKS } = cjsRequire('../lib/security-constants.cjs');

describe('repo-config-api', () => {
  const config = generateApiConfig();

  it('generates a valid runtime config', () => {
    const errors = validateRuntimeConfig(config);
    expect(errors).toEqual([]);
  });

  it('sets tier to standard', () => { expect(config.tier).toBe('standard'); });
  it('sets profile to example-api', () => { expect(config.profile).toBe('example-api'); });

  it('enables all protected hooks', () => {
    for (const hook of PROTECTED_HOOKS) {
      expect(config.hooks[hook], `Protected hook ${hook} must not be disabled`).not.toBe(false);
      expect(config.hooks[hook]).toBeTruthy();
    }
  });

  it('includes D365 and Teams specialists', () => {
    expect(config.agents.specialists).toContain('d365-specialist');
    expect(config.agents.specialists).toContain('teams-specialist');
    expect(config.agents.specialists).toContain('safety-specialist');
  });

  it('enables hono_patterns hook', () => { expect(config.hooks.hono_patterns).toBe(true); });

  it('does not enable autoresearch (standard tier)', () => {
    expect(config.autoresearch).toBeUndefined();
  });

  it('scopes memory to domain:api', () => { expect(config.memory.scope).toBe('domain:api'); });

  it('includes construction domain custom rules', () => {
    expect(config.custom_rules).toContain('safety-escalation-patterns');
    expect(config.custom_rules).toContain('d365-entity-conventions');
    expect(config.custom_rules).toContain('pwa-offline-first-patterns');
  });

  it('has OS layer enabled', () => { expect(config.os_layer.enabled).toBe(true); });

  it('has d365 alias in agent_routing', () => {
    expect(config.agent_routing.aliases['d365']).toBe('d365-specialist');
  });
});
