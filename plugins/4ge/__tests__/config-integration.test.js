import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cjsRequire = createRequire(import.meta.url);

const { PROTECTED_HOOKS: pluginHooks, validateRuntimeConfig } = cjsRequire('../lib/security-constants.cjs');
const { generateMonorepoConfig } = cjsRequire('../lib/repo-config-monorepo.cjs');
const { generateWebappConfig } = cjsRequire('../lib/repo-config-webapp.cjs');
const { generateApiConfig } = cjsRequire('../lib/repo-config-api.cjs');
const { resolveAlias, validateAliasChain } = cjsRequire('../lib/migration-aliases.cjs');

describe('Tier 3 config integration', () => {
  const configs = {
    monorepo: generateMonorepoConfig(),
    webapp: generateWebappConfig(),
    api: generateApiConfig(),
  };

  // Security sync check: plugin copy must match root lib copy
  it('security-constants.cjs PROTECTED_HOOKS matches lib/runtime-config-schema.cjs (drift check)', () => {
    const rootSchemaPath = path.resolve(__dirname, '../../../lib/runtime-config-schema.cjs');
    let rootHooks;
    try {
      rootHooks = cjsRequire(rootSchemaPath).PROTECTED_HOOKS;
    } catch {
      // Root lib not present (e.g., external install) — skip drift check
      return;
    }
    expect(pluginHooks).toEqual(rootHooks);
  });

  it('all three configs pass plugin validateRuntimeConfig', () => {
    for (const [name, config] of Object.entries(configs)) {
      const errors = validateRuntimeConfig(config);
      expect(errors, `${name} config has validation errors: ${errors.join(', ')}`).toEqual([]);
    }
  });

  it('all canonical configs scope the default vitest verification command', () => {
    for (const [name, config] of Object.entries(configs)) {
      const commands = config.hooks.task_completed_verify.commands;
      expect(commands, `${name} should use changed-file vitest verification`).toContain('npx vitest run --changed HEAD');
      expect(commands, `${name} should not run the full vitest suite on TaskCompleted`).not.toContain('npx vitest run');
    }
  });

  it('all three configs enforce PROTECTED_HOOKS (not false, not missing)', () => {
    for (const [name, config] of Object.entries(configs)) {
      for (const hook of pluginHooks) {
        expect(
          config.hooks[hook],
          `${name} is missing protected hook "${hook}"`
        ).toBeTruthy();
        expect(
          config.hooks[hook],
          `${name} has disabled protected hook "${hook}"`
        ).not.toBe(false);
      }
    }
  });

  it('each config has a unique profile', () => {
    const profiles = Object.values(configs).map(c => c.profile);
    expect(new Set(profiles).size).toBe(3);
  });

  it('memory scopes are unique per repo', () => {
    const scopes = Object.values(configs).map(c => c.memory.scope);
    expect(new Set(scopes).size).toBe(3);
  });

  it('alias chains are clean across all profiles', () => {
    for (const profile of ['example-monorepo', 'example-webapp', 'example-api', 'generic']) {
      const result = validateAliasChain(profile);
      expect(result.valid, `${profile} has alias cycles: ${result.cycles.join(', ')}`).toBe(true);
    }
  });

  it('all standard aliases resolve to non-null strings', () => {
    const universalAliases = ['impl', 'review', 'DFE', 'sec', 'plan', 'ops', 'test'];
    for (const alias of universalAliases) {
      for (const profile of ['example-monorepo', 'example-webapp', 'example-api', 'generic']) {
        const resolved = resolveAlias(alias, profile);
        expect(resolved, `${alias} resolves to null for ${profile}`).not.toBeNull();
        expect(typeof resolved).toBe('string');
      }
    }
  });

  it('monorepo config has more agents enabled than api (full vs standard tier difference)', () => {
    const sbdAgents = configs.monorepo.agents.specialists.length + (configs.monorepo.agents.audit_team?.length || 0);
    const apiAgents = configs.api.agents.specialists.length;
    expect(sbdAgents).toBeGreaterThan(apiAgents);
  });

  it('example-api does not have autoresearch (standard tier constraint)', () => {
    expect(configs.api.autoresearch).toBeUndefined();
  });

  it('monorepo has autoresearch enabled (full tier)', () => {
    expect(configs.monorepo.autoresearch?.enabled).toBe(true);
  });
});
