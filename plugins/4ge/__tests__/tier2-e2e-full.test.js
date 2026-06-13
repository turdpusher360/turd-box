import { describe, it, expect, vi } from 'vitest';

const fs = require('fs');
vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  return { ...actual, existsSync: vi.fn(() => false), readFileSync: vi.fn(() => '{}'), appendFileSync: vi.fn(), writeFileSync: vi.fn(), mkdirSync: vi.fn(), readdirSync: vi.fn(() => []) };
});

describe('Tier 2 full integration', () => {
  it('all modules load without errors', () => {
    expect(() => require('../lib/dialect-detector.cjs')).not.toThrow();
    expect(() => require('../lib/hook-auditor.cjs')).not.toThrow();
    expect(() => require('../lib/prompt-scorer.cjs')).not.toThrow();
    expect(() => require('../lib/telemetry-collector.cjs')).not.toThrow();
    expect(() => require('../lib/context-budget.cjs')).not.toThrow();
    expect(() => require('../lib/causal-map.cjs')).not.toThrow();
    expect(() => require('../lib/trust-score.cjs')).not.toThrow();
    expect(() => require('../lib/layout-parser.cjs')).not.toThrow();
    expect(() => require('../lib/session-archaeology.cjs')).not.toThrow();
    expect(() => require('../lib/checkpoint-buddy.cjs')).not.toThrow();
    expect(() => require('../hooks/4ge-hook-utils-v2.cjs')).not.toThrow();
  });

  it('trust escalation full cycle: guided -> assisted -> failure -> guided', () => {
    const { TrustScore, THRESHOLDS } = require('../lib/trust-score.cjs');
    const ts = new TrustScore();
    expect(ts.getLevel()).toBe('guided');
    for (let i = 0; i < THRESHOLDS.assisted; i++) ts.recordSuccess();
    expect(ts.getLevel()).toBe('assisted');
    for (let i = 0; i < 3; i++) ts.recordFailure(); // -6, back to guided
    expect(ts.getLevel()).toBe('guided');
  });

  it('bundled layouts all validate', () => {
    const { validateLayout } = require('../lib/layout-parser.cjs');
    const layouts = [
      { name: 'test', topology: 'paired', teammates: [{ name: 'w', agent: 'impl' }, { name: 'r', agent: 'rev' }] },
      { name: 'test', topology: 'star', teammates: [{ name: 'a', agent: 'a1' }, { name: 'b', agent: 'b1' }] },
      { name: 'test', topology: 'pipeline', teammates: [{ name: 'a', agent: 'a1' }] },
    ];
    for (const layout of layouts) {
      expect(validateLayout(layout)).toEqual([]);
    }
  });

  it('budget + telemetry interop', () => {
    const { forecastBudget } = require('../lib/context-budget.cjs');
    const { createSessionEntry } = require('../lib/telemetry-collector.cjs');
    const session = createSessionEntry('test', '/p');
    const budget = forecastBudget({
      tool_calls: 50,
      session_started: session.started_at,
      compact_threshold: 75,
    });
    expect(budget.calls_remaining).toBe(25);
    expect(budget.urgency).toBe('medium');
  });

  it('scorer + causal map independence (no shared state)', () => {
    const { scorePrompt } = require('../lib/prompt-scorer.cjs');
    const { buildAttributionMap } = require('../lib/causal-map.cjs');
    const score = scorePrompt('implement login page at src/login.tsx');
    expect(score.score).toBeGreaterThan(0);
    const map = buildAttributionMap({ teammates: [] }, ['file.ts']);
    expect(map['unattributed']).toContain('file.ts');
  });

  it('buddy + archaeology independence (no shared state)', () => {
    const { extractWins } = require('../lib/checkpoint-buddy.cjs');
    const { searchByTopic } = require('../lib/session-archaeology.cjs');
    const wins = extractWins('5 files changed, 100 insertions(+), 20 deletions(-)');
    expect(wins.files_changed).toBe(5);
    const results = searchByTopic([], 'auth');
    expect(results).toEqual([]);
  });
});
