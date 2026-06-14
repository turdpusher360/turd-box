import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);

function requireFresh() {
  for (const key of Object.keys(_require.cache)) {
    if (key.includes('hud-expressions') || key.includes('hud-palette')) {
      delete _require.cache[key];
    }
  }
  return _require(path.resolve(__dirname, '../hud-expressions.cjs'));
}

describe('expression resolver theme independence', () => {
  it('does not expose palette-aware block-art rendering APIs', () => {
    const mod = requireFresh();
    expect(mod.buildExpression).toBeUndefined();
    expect(mod.EXPRESSIONS).toBeUndefined();
    expect(mod.selectExpression).toBeUndefined();
  });

  it('resolves expression names without emitting ANSI art', () => {
    const { getExpressionName } = requireFresh();
    const result = getExpressionName({
      session: { contextPct: 65 },
      os: { capabilities: {} },
      forge: { active: false },
      context: { event: null },
    });
    expect(result).toBe('thinking');
    expect(result).not.toContain('\x1b[');
  });
});
