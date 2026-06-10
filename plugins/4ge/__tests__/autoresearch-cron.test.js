// plugins/4ge/__tests__/autoresearch-cron.test.js
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const cjsRequire = createRequire(import.meta.url);
const { findStaleDomains, buildCronSchedule, formatStaleReport } = cjsRequire('../lib/autoresearch-cron.cjs');

describe('autoresearch-cron', () => {
  it('identifies domains not measured in 7+ days', () => {
    const domains = [
      { name: 'hook-doc-sync', last_measured: '2026-03-20', score: 95 },
      { name: 'error-recovery', last_measured: '2026-04-01', score: 100 },
      { name: 'agent-freshness', last_measured: '2026-03-15', score: 80 },
    ];
    const stale = findStaleDomains(domains, 7, new Date('2026-04-01'));
    expect(stale).toHaveLength(2);
    expect(stale.map(d => d.name)).toContain('hook-doc-sync');
    expect(stale.map(d => d.name)).toContain('agent-freshness');
  });

  it('returns empty array when no domains are stale', () => {
    const domains = [
      { name: 'fresh', last_measured: '2026-04-01', score: 100 },
    ];
    const stale = findStaleDomains(domains, 7, new Date('2026-04-01'));
    expect(stale).toEqual([]);
  });

  it('builds a cron schedule sorted by priority (lower score = higher priority)', () => {
    const stale = [
      { name: 'domain-a', last_measured: '2026-03-20', score: 70 },
      { name: 'domain-b', last_measured: '2026-03-25', score: 90 },
    ];
    const schedule = buildCronSchedule(stale);
    expect(schedule).toHaveLength(2);
    expect(schedule[0].domain).toBe('domain-a');
    expect(schedule[0].priority).toBeGreaterThan(schedule[1].priority);
  });

  it('formats stale report as markdown table containing domain name and score', () => {
    const stale = [
      { name: 'domain-a', last_measured: '2026-03-20', score: 70 },
    ];
    const report = formatStaleReport(stale);
    expect(report).toContain('domain-a');
    expect(report).toContain('70');
  });

  it('handles empty domain list', () => {
    const stale = findStaleDomains([], 7, new Date());
    expect(stale).toEqual([]);
  });

  it('treats domain with missing last_measured as stale', () => {
    const domains = [{ name: 'never-measured', score: 0 }];
    const stale = findStaleDomains(domains, 7, new Date('2026-04-01'));
    expect(stale).toHaveLength(1);
    expect(stale[0].name).toBe('never-measured');
  });

  it('formatStaleReport returns friendly message for empty list', () => {
    const report = formatStaleReport([]);
    expect(report).toContain('up to date');
  });
});
