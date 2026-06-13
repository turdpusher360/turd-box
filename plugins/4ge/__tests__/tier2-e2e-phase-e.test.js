// plugins/4ge/__tests__/tier2-e2e-phase-e.test.js
import { describe, it, expect, vi } from 'vitest';

const fs = require('fs');
vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  return { ...actual, existsSync: vi.fn(() => false), readFileSync: vi.fn(() => '{}'), appendFileSync: vi.fn(), mkdirSync: vi.fn(), readdirSync: vi.fn(() => []) };
});

describe('Tier 2 Phase E integration', () => {
  it('prompt scorer gives actionable suggestions for vague prompts', () => {
    const { suggestImprovements } = require('../lib/prompt-scorer.cjs');
    const result = suggestImprovements('fix it');
    expect(result.suggestions.length).toBeGreaterThan(0);
    expect(result.suggestions.some(s => s.includes('specific'))).toBe(true);
  });

  it('telemetry creates and finalizes session entries', () => {
    const { createSessionEntry, finalizeSession } = require('../lib/telemetry-collector.cjs');
    const entry = createSessionEntry('test-session', '/project');
    entry.tools_used = { Bash: 5, Read: 3 };
    const finalized = finalizeSession(entry);
    expect(finalized.total_tool_calls).toBe(8);
    expect(finalized.ended_at).toBeDefined();
  });

  it('budget forecast handles edge cases', () => {
    const { forecastBudget } = require('../lib/context-budget.cjs');
    const result = forecastBudget({
      tool_calls: 0,
      session_started: new Date().toISOString(),
      compact_threshold: 75,
    });
    expect(result.calls_remaining).toBe(75);
    expect(result.urgency).toBe('low');
  });

  it('causal attribution map with mixed files', () => {
    const { buildAttributionMap } = require('../lib/causal-map.cjs');
    const session = {
      teammates: [
        { name: 'frontend', scope: ['src/components/'] },
        { name: 'backend', scope: ['lib/'] },
      ],
    };
    const map = buildAttributionMap(session, [
      'src/components/Modal.tsx',
      'lib/auth.cjs',
      'README.md',
    ]);
    expect(map['frontend']).toContain('src/components/Modal.tsx');
    expect(map['backend']).toContain('lib/auth.cjs');
    expect(map['unattributed']).toContain('README.md');
  });

  it('hook-utils-v2 returns safe defaults', () => {
    const { read4geConfig } = require('../hooks/4ge-hook-utils-v2.cjs');
    const config = read4geConfig('/fake');
    expect(config.version).toBe('2.1.0');
    expect(config.design_suite.modes).toEqual(['visual', 'api', 'data', 'system']);
  });

  it('dialect detector fingerprints repo state', () => {
    const { detectDialect } = require('../lib/dialect-detector.cjs');
    const result = detectDialect('/fake');
    expect(result.state).toBe('fresh');
  });

  it('rubber duck normalizes errors consistently', () => {
    const { normalizeError } = require('../hooks/rubber-duck-debugger.cjs');
    const n1 = normalizeError('Error at /a/b.ts:10:5: foo');
    const n2 = normalizeError('Error at /x/y.ts:99:1: foo');
    expect(n1).toBe(n2);
  });

  it('all modules load without errors', () => {
    expect(() => require('../lib/dialect-detector.cjs')).not.toThrow();
    expect(() => require('../lib/hook-auditor.cjs')).not.toThrow();
    expect(() => require('../lib/prompt-scorer.cjs')).not.toThrow();
    expect(() => require('../lib/telemetry-collector.cjs')).not.toThrow();
    expect(() => require('../lib/context-budget.cjs')).not.toThrow();
    expect(() => require('../lib/causal-map.cjs')).not.toThrow();
  });
});
