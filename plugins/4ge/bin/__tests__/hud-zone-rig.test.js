import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const _require = createRequire(import.meta.url);
const {
  RIG_META,
  renderRigZone,
  renderRigCompact,
  rigContextVisible,
} = _require('../hud-zone-rig.cjs');
const { resolvePalette, stripAnsi } = _require('../hud-palette.cjs');

const palette = resolvePalette({ name: 'forge' });

function plain(lines) {
  return stripAnsi(Array.isArray(lines) ? lines.join('\n') : String(lines));
}

describe('hud-zone-rig', () => {
  it('uses alert priority below core context and health zones', () => {
    expect(RIG_META.key).toBe('rig');
    expect(RIG_META.priority).toBe(7);
    expect(RIG_META.minRows).toBe(1);
  });

  it('stays invisible when rig context is present and ok', () => {
    expect(rigContextVisible({
      rigContext: {
        status: 'ok',
        issueCount: 0,
        isStale: false,
      },
    })).toBe(false);
  });

  it('is visible for warn, unknown, error, and stale snapshots', () => {
    expect(rigContextVisible({ rigContext: { status: 'warn', issueCount: 1, isStale: false } })).toBe(true);
    expect(rigContextVisible({ rigContext: { status: 'unknown', issueCount: 1, isStale: false } })).toBe(true);
    expect(rigContextVisible({ rigContext: { status: 'error', issueCount: 1, isStale: false } })).toBe(true);
    expect(rigContextVisible({ rigContext: { status: 'ok', issueCount: 0, isStale: true } })).toBe(true);
  });

  it('renders a compact issue summary and issue details', () => {
    const output = plain(renderRigZone({
      rigContext: {
        status: 'warn',
        issueCount: 2,
        headline: '2 rig checks need attention',
        ageMinutes: 4,
        isStale: false,
        issues: [
          { name: 'lockfile', status: 'warn', summary: 'package-lock.json older than package.json' },
          { name: 'active_sessions', status: 'unknown', summary: 'active session count not provided' },
        ],
      },
    }, palette));

    expect(output).toContain('rig warn');
    expect(output).toContain('2 issues');
    expect(output).toContain('4m old');
    expect(output).toContain('lockfile: package-lock.json older than package.json');
    expect(output).toContain('active_sessions: active session count not provided');
  });

  it('labels stale snapshots even when all checks were ok', () => {
    const output = plain(renderRigZone({
      rigContext: {
        status: 'ok',
        issueCount: 0,
        headline: 'rig context ok',
        ageMinutes: 120,
        isStale: true,
        issues: [],
      },
    }, palette));

    expect(output).toContain('rig ok');
    expect(output).toContain('[stale]');
    expect(output).toContain('120m old');
  });

  it('exposes a one-line compact row only when visible', () => {
    expect(renderRigCompact({
      rigContext: { status: 'ok', issueCount: 0, isStale: false },
    }, palette)).toEqual([]);

    const output = plain(renderRigCompact({
      rigContext: {
        status: 'warn',
        issueCount: 1,
        headline: '1 rig check needs attention',
        ageMinutes: 3,
        isStale: false,
        issues: [{ name: 'handoff', status: 'warn', summary: 'stale' }],
      },
    }, palette));

    expect(output).toContain('rig warn');
    expect(output).toContain('1 issue');
    expect(output).toContain('handoff');
  });
});
