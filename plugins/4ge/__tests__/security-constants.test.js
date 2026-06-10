import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const cjsRequire = createRequire(import.meta.url);
const { PROTECTED_HOOKS, validateRuntimeConfig } = cjsRequire('../lib/security-constants.cjs');

describe('security-constants', () => {
  it('exports PROTECTED_HOOKS as non-empty array', () => {
    expect(Array.isArray(PROTECTED_HOOKS)).toBe(true);
    expect(PROTECTED_HOOKS.length).toBeGreaterThan(0);
  });

  it('PROTECTED_HOOKS includes guard_git_scope', () => {
    expect(PROTECTED_HOOKS).toContain('guard_git_scope');
  });

  it('PROTECTED_HOOKS includes guard_dns_exfil', () => {
    expect(PROTECTED_HOOKS).toContain('guard_dns_exfil');
  });

  it('PROTECTED_HOOKS includes enforce_approved_agents', () => {
    expect(PROTECTED_HOOKS).toContain('enforce_approved_agents');
  });

  it('PROTECTED_HOOKS includes file_content_secret_guard', () => {
    expect(PROTECTED_HOOKS).toContain('file_content_secret_guard');
  });

  it('validateRuntimeConfig returns empty array for valid config', () => {
    const config = {
      version: '2.1.0',
      tier: 'full',
      profile: 'example-monorepo',
      hooks: { guard_git_scope: true, guard_dns_exfil: true, enforce_approved_agents: true, file_content_secret_guard: true },
      agents: {},
      agent_routing: {},
    };
    const errors = validateRuntimeConfig(config);
    expect(errors).toEqual([]);
  });

  it('validateRuntimeConfig returns error for missing version', () => {
    const config = { tier: 'full', profile: 'x', hooks: {}, agents: {}, agent_routing: {} };
    const errors = validateRuntimeConfig(config);
    expect(errors.some(e => e.includes('version'))).toBe(true);
  });

  it('validateRuntimeConfig returns error for missing tier', () => {
    const config = { version: '1.0.0', profile: 'x', hooks: {}, agents: {}, agent_routing: {} };
    const errors = validateRuntimeConfig(config);
    expect(errors.some(e => e.includes('tier'))).toBe(true);
  });

  it('validateRuntimeConfig returns error for missing profile', () => {
    const config = { version: '1.0.0', tier: 'full', hooks: {}, agents: {}, agent_routing: {} };
    const errors = validateRuntimeConfig(config);
    expect(errors.some(e => e.includes('profile'))).toBe(true);
  });
});
