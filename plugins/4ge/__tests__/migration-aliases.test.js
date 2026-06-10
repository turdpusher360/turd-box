import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const cjsRequire = createRequire(import.meta.url);
const { resolveAlias, getUniversalAliases, getRepoAliases, validateAliasChain } = cjsRequire('../lib/migration-aliases.cjs');

describe('migration-aliases', () => {
  it('resolves universal aliases for any profile', () => {
    expect(resolveAlias('impl', 'generic')).toBe('sonnet-execute');
    expect(resolveAlias('review', 'generic')).toBe('opus-review');
    expect(resolveAlias('DFE', 'generic')).toBe('DFE');
  });

  it('resolves repo-specific aliases for example-webapp', () => {
    expect(resolveAlias('stream', 'example-webapp')).toBe('sonnet-execute');
    expect(resolveAlias('overlay', 'example-webapp')).toBe('sonnet-execute');
  });

  it('resolves repo-specific aliases for example-api', () => {
    expect(resolveAlias('d365', 'example-api')).toBe('sonnet-research');
    expect(resolveAlias('teams', 'example-api')).toBe('sonnet-research');
  });

  it('falls back to universal alias when repo alias not found', () => {
    expect(resolveAlias('impl', 'example-webapp')).toBe('sonnet-execute');
    expect(resolveAlias('review', 'example-api')).toBe('opus-review');
  });

  it('returns null for unknown aliases in any profile', () => {
    expect(resolveAlias('nonexistent', 'generic')).toBeNull();
    expect(resolveAlias('nonexistent', 'example-monorepo')).toBeNull();
  });

  it('getUniversalAliases returns all universal aliases', () => {
    const aliases = getUniversalAliases();
    expect(aliases).toHaveProperty('impl');
    expect(aliases).toHaveProperty('review');
    expect(aliases).toHaveProperty('DFE');
    expect(aliases).toHaveProperty('sec');
  });

  it('getRepoAliases returns repo-specific aliases', () => {
    const turdAliases = getRepoAliases('example-webapp');
    expect(turdAliases).toHaveProperty('stream');
    const apiAliases = getRepoAliases('example-api');
    expect(apiAliases).toHaveProperty('d365');
  });

  it('getRepoAliases returns empty object for unknown profile', () => {
    expect(getRepoAliases('unknown')).toEqual({});
  });

  it('validateAliasChain reports valid for all known repos', () => {
    for (const profile of ['example-monorepo', 'example-webapp', 'example-api', 'generic']) {
      const result = validateAliasChain(profile);
      expect(result.valid, `${profile} alias chain has cycles: ${result.cycles.join(', ')}`).toBe(true);
      expect(result.cycles).toEqual([]);
    }
  });

  it('validateAliasChain detects circular references in custom aliases', () => {
    const customAliases = { a: 'b', b: 'a' };
    const result = validateAliasChain('generic', customAliases);
    expect(result.valid).toBe(false);
    expect(result.cycles.length).toBeGreaterThan(0);
  });

  it('only points aliases at installed 4ge plugin agents', () => {
    const installed = new Set([
      'DFE',
      'dfe-artifacts',
      'dfe-existence',
      'dfe-logic',
      'dfe-runtime',
      'dfe-security',
      'forge-brainstorm',
      'forge-planner',
      'forge-shipper',
      'general-purpose',
      'master-auditor',
      'master-auditor-46',
      'opus-audit',
      'opus-planner',
      'opus-review',
      'sonnet-execute',
      'sonnet-research',
    ]);

    for (const profile of ['generic', 'example-monorepo', 'example-webapp', 'example-api']) {
      const aliases = { ...getUniversalAliases(), ...getRepoAliases(profile) };
      for (const [alias, target] of Object.entries(aliases)) {
        expect(installed.has(target), `${profile}:${alias} -> ${target} is not installed`).toBe(true);
      }
    }
  });
});
