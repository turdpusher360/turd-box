import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cjsRequire = createRequire(import.meta.url);

const { PROTECTED_HOOKS: pluginHooks } = cjsRequire('../lib/security-constants.cjs');
const { resolveAlias, validateAliasChain } = cjsRequire('../lib/migration-aliases.cjs');

describe('Tier 3 config integration', () => {
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
});
