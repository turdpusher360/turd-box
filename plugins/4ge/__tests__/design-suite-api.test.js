// plugins/4ge/__tests__/design-suite-api.test.js
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { assembleApiToolkit, VALIDATION_RULES, ERROR_SCHEMA } = require('../lib/design-suite-api.cjs');

describe('design-suite-api', () => {
  const baseConfig = {
    detected: { cloud: 'cloudflare', framework: '' },
    design_suite: { enabled: true, modes: ['api'] },
  };

  it('returns a toolkit with required sections', () => {
    const tk = assembleApiToolkit(baseConfig);
    expect(tk).toHaveProperty('openapi');
    expect(tk).toHaveProperty('validation');
    expect(tk).toHaveProperty('error_handling');
    expect(tk).toHaveProperty('framework_refs');
    expect(tk).toHaveProperty('workflow');
  });

  it('includes 5 validation rules', () => {
    expect(VALIDATION_RULES).toHaveLength(5);
    expect(VALIDATION_RULES[0]).toHaveProperty('id');
    expect(VALIDATION_RULES[0]).toHaveProperty('rule');
  });

  it('includes error schema with required fields', () => {
    expect(ERROR_SCHEMA).toHaveProperty('status');
    expect(ERROR_SCHEMA).toHaveProperty('code');
    expect(ERROR_SCHEMA).toHaveProperty('message');
  });

  it('loads Hono refs for cloudflare cloud', () => {
    const tk = assembleApiToolkit(baseConfig);
    expect(tk.framework_refs.router).toBe('hono');
    expect(tk.framework_refs.patterns.length).toBeGreaterThan(0);
  });

  it('loads Express refs for non-cloudflare', () => {
    const config = { ...baseConfig, detected: { cloud: '' } };
    const tk = assembleApiToolkit(config);
    expect(tk.framework_refs.router).toBe('express');
  });

  it('loads Fastify refs when detected', () => {
    const config = { ...baseConfig, detected: { cloud: '', framework: 'fastify' } };
    const tk = assembleApiToolkit(config);
    expect(tk.framework_refs.router).toBe('fastify');
  });

  it('returns correct workflow steps', () => {
    const tk = assembleApiToolkit(baseConfig);
    expect(tk.workflow).toHaveLength(5);
    expect(tk.workflow[0].name).toBe('OpenAPI');
  });
});
