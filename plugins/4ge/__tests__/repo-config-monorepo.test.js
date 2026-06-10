import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const cjsRequire = createRequire(import.meta.url);
const { generateMonorepoConfig } = cjsRequire('../lib/repo-config-monorepo.cjs');
const { validateRuntimeConfig, PROTECTED_HOOKS } = cjsRequire('../lib/security-constants.cjs');

describe('repo-config-monorepo', () => {
  const config = generateMonorepoConfig();

  it('generates a valid runtime config', () => {
    const errors = validateRuntimeConfig(config);
    expect(errors).toEqual([]);
  });

  it('sets tier to full', () => {
    expect(config.tier).toBe('full');
  });

  it('sets profile to example-monorepo', () => {
    expect(config.profile).toBe('example-monorepo');
  });

  it('enables all protected hooks (hooks present and not false)', () => {
    for (const hook of PROTECTED_HOOKS) {
      expect(config.hooks[hook], `Protected hook ${hook} must not be disabled`).not.toBe(false);
      expect(config.hooks[hook]).toBeTruthy();
    }
  });

  it('includes audit team', () => {
    expect(config.agents.audit_team).toContain('master-auditor');
    expect(config.agents.audit_team).toContain('opus-audit');
  });

  it('sets capabilities to 13 (current booted count)', () => {
    expect(config.os_layer.capabilities).toBe(13);
  });

  it('includes memory hub configuration with example-monorepo scope', () => {
    expect(config.memory.hub_url).toBe('http://localhost:8091');
    expect(config.memory.scope).toBe('domain:monorepo');
  });

  it('enables autoresearch with 94 domains', () => {
    expect(config.autoresearch.enabled).toBe(true);
    expect(config.autoresearch.domains).toBe(94);
  });

  it('enables all Tier 2 features', () => {
    expect(config.design_suite.enabled).toBe(true);
    expect(config.telemetry.enabled).toBe(true);
    expect(config.trust.level).toBe('autonomous');
    expect(config.lounge.enabled).toBe(true);
  });

  it('includes sufficient hooks (>= 15 enabled)', () => {
    const hookCount = Object.keys(config.hooks).filter(k =>
      config.hooks[k] === true || (typeof config.hooks[k] === 'object' && config.hooks[k]?.enabled === true)
    ).length;
    expect(hookCount).toBeGreaterThanOrEqual(15);
  });

  it('has agent_routing with aliases', () => {
    expect(config.agent_routing.aliases).toBeDefined();
    expect(config.agent_routing.aliases['impl']).toBe('sonnet-execute');
    expect(config.agent_routing.aliases['DFE']).toBe('DFE');
  });
});
