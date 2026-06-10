// plugins/4ge/__tests__/design-suite-visual.test.js
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { assembleVisualToolkit, A11Y_RULES, RESPONSIVE_PATTERNS } = require('../lib/design-suite-visual.cjs');

describe('design-suite-visual', () => {
  const baseConfig = {
    detected: { framework: 'react' },
    design_suite: { enabled: true, modes: ['visual'] },
  };

  it('returns a toolkit object with required sections', () => {
    const tk = assembleVisualToolkit(baseConfig);
    expect(tk).toHaveProperty('tailwind');
    expect(tk).toHaveProperty('a11y');
    expect(tk).toHaveProperty('responsive');
    expect(tk).toHaveProperty('framework_refs');
    expect(tk).toHaveProperty('workflow');
  });

  it('includes 5 a11y rules', () => {
    expect(A11Y_RULES).toHaveLength(5);
    expect(A11Y_RULES[0]).toHaveProperty('id');
    expect(A11Y_RULES[0]).toHaveProperty('rule');
    expect(A11Y_RULES[0]).toHaveProperty('severity');
  });

  it('includes 4 responsive patterns', () => {
    expect(RESPONSIVE_PATTERNS).toHaveLength(4);
    expect(RESPONSIVE_PATTERNS[0]).toHaveProperty('name');
    expect(RESPONSIVE_PATTERNS[0]).toHaveProperty('pattern');
  });

  it('loads React refs for react framework', () => {
    const tk = assembleVisualToolkit(baseConfig);
    expect(tk.framework_refs.framework).toBe('react');
    expect(tk.framework_refs.patterns).toBeDefined();
    expect(tk.framework_refs.patterns.length).toBeGreaterThan(0);
  });

  it('loads Vue refs for vue framework', () => {
    const config = { ...baseConfig, detected: { framework: 'vue' } };
    const tk = assembleVisualToolkit(config);
    expect(tk.framework_refs.framework).toBe('vue');
  });

  it('loads Svelte refs for svelte framework', () => {
    const config = { ...baseConfig, detected: { framework: 'svelte' } };
    const tk = assembleVisualToolkit(config);
    expect(tk.framework_refs.framework).toBe('svelte');
  });

  it('returns generic refs for unknown framework', () => {
    const config = { ...baseConfig, detected: { framework: '' } };
    const tk = assembleVisualToolkit(config);
    expect(tk.framework_refs.framework).toBe('generic');
  });
});
