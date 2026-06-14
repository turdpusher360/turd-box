import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);
const MODULE_PATH = path.resolve(__dirname, '../../lib/badge-tracker.cjs');

function requireFresh() {
  // Clear tracker and any transitive CJS deps from cache
  for (const key of Object.keys(_require.cache)) {
    if (key.includes('badge-tracker') || key.includes('hud-expressions')) {
      delete _require.cache[key];
    }
  }
  return _require(MODULE_PATH);
}

// --- Temp directory helpers ---

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'badge-tracker-test-'));
});

afterEach(() => {
  // Clean up temp directory
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch { /* ignore */ }
});

function tmpFile(name) {
  return path.join(tmpDir, name);
}

// ============================================================
// earnBadge
// ============================================================

describe('earnBadge', () => {
  it('marks a badge as earned and adds to newThisSession', () => {
    const { earnBadge, emptyState } = requireFresh();
    const state = emptyState();
    const result = earnBadge(state, 'forge-master');
    expect(result).toBe(true);
    expect(state.earned['forge-master']).toMatch(/^\d{4}-/);
    expect(state.newThisSession).toContain('forge-master');
  });

  it('returns false for an already-earned badge', () => {
    const { earnBadge, emptyState } = requireFresh();
    const state = emptyState();
    earnBadge(state, 'forge-master');
    const second = earnBadge(state, 'forge-master');
    expect(second).toBe(false);
    expect(state.newThisSession.filter(b => b === 'forge-master')).toHaveLength(1);
  });

  it('does not duplicate newThisSession entries', () => {
    const { earnBadge } = requireFresh();
    const state = { earned: {}, newThisSession: ['forge-master'] };
    // Manually clear earned to force the earn path while newThisSession already has the id
    earnBadge(state, 'test-green');
    expect(state.newThisSession).toContain('forge-master');
    expect(state.newThisSession).toContain('test-green');
    expect(new Set(state.newThisSession).size).toBe(state.newThisSession.length);
  });
});

// ============================================================
// loadBadgeState / saveBadgeState
// ============================================================

describe('loadBadgeState', () => {
  it('returns empty state when file does not exist', () => {
    const { loadBadgeState } = requireFresh();
    const state = loadBadgeState(tmpFile('nonexistent.json'));
    expect(state.earned).toEqual({});
    expect(state.newThisSession).toEqual([]);
  });

  it('loads previously saved state', () => {
    const { loadBadgeState, saveBadgeState } = requireFresh();
    const fp = tmpFile('badges.json');
    const written = {
      earned: { 'forge-master': '2026-04-01T00:00:00.000Z' },
      newThisSession: [],
    };
    saveBadgeState(written, fp);
    const loaded = loadBadgeState(fp);
    expect(loaded.earned['forge-master']).toBe('2026-04-01T00:00:00.000Z');
  });

  it('returns empty state on malformed JSON', () => {
    const { loadBadgeState } = requireFresh();
    const fp = tmpFile('bad.json');
    fs.writeFileSync(fp, '{ not valid json }', 'utf8');
    const state = loadBadgeState(fp);
    expect(state.earned).toEqual({});
  });

  it('coerces missing fields to defaults', () => {
    const { loadBadgeState } = requireFresh();
    const fp = tmpFile('partial.json');
    fs.writeFileSync(fp, JSON.stringify({ earned: null }), 'utf8');
    const state = loadBadgeState(fp);
    expect(state.earned).toEqual({});
    expect(state.newThisSession).toEqual([]);
  });
});

describe('saveBadgeState', () => {
  it('creates parent directory if missing', () => {
    const { saveBadgeState, emptyState } = requireFresh();
    const fp = path.join(tmpDir, 'nested', 'dir', 'badges.json');
    const result = saveBadgeState(emptyState(), fp);
    expect(result).toBe(true);
    expect(fs.existsSync(fp)).toBe(true);
  });

  it('returns false on write error (read-only path)', () => {
    const { saveBadgeState, emptyState } = requireFresh();
    // Use a path with null byte which is always invalid
    const result = saveBadgeState(emptyState(), '/\0/invalid.json');
    expect(result).toBe(false);
  });

  it('round-trips badge state correctly', () => {
    const { saveBadgeState, loadBadgeState } = requireFresh();
    const fp = tmpFile('rt.json');
    const state = {
      earned: { 'zone-builder': '2026-04-07T12:00:00.000Z', 'test-green': '2026-04-07T13:00:00.000Z' },
      newThisSession: ['test-green'],
    };
    saveBadgeState(state, fp);
    const loaded = loadBadgeState(fp);
    expect(loaded.earned).toEqual(state.earned);
    expect(loaded.newThisSession).toEqual(state.newThisSession);
  });
});

// ============================================================
// Individual badge check functions
// ============================================================

describe('checkForgeMaster', () => {
  it('returns true when 5+ HANDOFF files exist', () => {
    const { checkForgeMaster } = requireFresh();
    // Create 5 HANDOFF files
    for (let i = 1; i <= 5; i++) {
      fs.writeFileSync(path.join(tmpDir, `HANDOFF-S${i}.md`), `# handoff ${i}`);
    }
    expect(checkForgeMaster({ runsDir: tmpDir })).toBe(true);
  });

  it('returns false when fewer than 5 HANDOFF files', () => {
    const { checkForgeMaster } = requireFresh();
    for (let i = 1; i <= 4; i++) {
      fs.writeFileSync(path.join(tmpDir, `HANDOFF-S${i}.md`), `# handoff ${i}`);
    }
    expect(checkForgeMaster({ runsDir: tmpDir })).toBe(false);
  });

  it('returns false when directory does not exist', () => {
    const { checkForgeMaster } = requireFresh();
    expect(checkForgeMaster({ runsDir: path.join(tmpDir, 'no-such-dir') })).toBe(false);
  });

  it('ignores non-HANDOFF .md files', () => {
    const { checkForgeMaster } = requireFresh();
    // 3 HANDOFF + 2 other
    for (let i = 1; i <= 3; i++) {
      fs.writeFileSync(path.join(tmpDir, `HANDOFF-S${i}.md`), '');
    }
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '');
    fs.writeFileSync(path.join(tmpDir, 'notes.md'), '');
    expect(checkForgeMaster({ runsDir: tmpDir })).toBe(false);
  });
});

describe('checkAuditClean', () => {
  it('returns true when latest date dir has report with 0 P0 findings', () => {
    const { checkAuditClean } = requireFresh();
    const dateDir = path.join(tmpDir, '2026-04-07');
    fs.mkdirSync(dateDir, { recursive: true });
    fs.writeFileSync(path.join(dateDir, 'master-report.md'),
      '# Audit Report\nP0 findings: 0\nP1 findings: 3');
    expect(checkAuditClean({ auditDir: tmpDir })).toBe(true);
  });

  it('returns false when P0 count is nonzero', () => {
    const { checkAuditClean } = requireFresh();
    const dateDir = path.join(tmpDir, '2026-04-07');
    fs.mkdirSync(dateDir, { recursive: true });
    fs.writeFileSync(path.join(dateDir, 'master-report.md'),
      '# Audit Report\nP0 findings: 2\nP1 findings: 5');
    expect(checkAuditClean({ auditDir: tmpDir })).toBe(false);
  });

  it('returns false when no date subdirectories exist', () => {
    const { checkAuditClean } = requireFresh();
    // tmpDir has no YYYY-MM-DD subdirs
    expect(checkAuditClean({ auditDir: tmpDir })).toBe(false);
  });

  it('returns false when audit directory does not exist', () => {
    const { checkAuditClean } = requireFresh();
    expect(checkAuditClean({ auditDir: path.join(tmpDir, 'no-audit') })).toBe(false);
  });

  it('uses latest date dir when multiple exist', () => {
    const { checkAuditClean } = requireFresh();
    // Older dir: has P0 findings. Newer dir: clean.
    const older = path.join(tmpDir, '2026-04-05');
    const newer = path.join(tmpDir, '2026-04-07');
    fs.mkdirSync(older, { recursive: true });
    fs.mkdirSync(newer, { recursive: true });
    fs.writeFileSync(path.join(older, 'report.md'), 'P0 findings: 2');
    fs.writeFileSync(path.join(newer, 'report.md'), 'P0: 0 issues found');
    expect(checkAuditClean({ auditDir: tmpDir })).toBe(true);
  });
});

describe('checkFullDeploy', () => {
  it('returns true when .last-ship marker exists', () => {
    const { checkFullDeploy } = requireFresh();
    const markerPath = tmpFile('.last-ship');
    fs.writeFileSync(markerPath, '2026-04-07');
    expect(checkFullDeploy({ deployMarker: markerPath })).toBe(true);
  });

  it('returns false when marker file does not exist and git dir missing', () => {
    const { checkFullDeploy } = requireFresh();
    expect(checkFullDeploy({
      deployMarker: tmpFile('.missing-ship'),
      repoRoot: tmpDir,
    })).toBe(false);
  });

  it('returns true when COMMIT_EDITMSG contains /ship', () => {
    const { checkFullDeploy } = requireFresh();
    const gitDir = path.join(tmpDir, '.git');
    fs.mkdirSync(gitDir);
    fs.writeFileSync(path.join(gitDir, 'COMMIT_EDITMSG'), 'feat: ship it via /ship');
    expect(checkFullDeploy({
      deployMarker: tmpFile('.missing-ship'),
      repoRoot: tmpDir,
    })).toBe(true);
  });

  it('returns true when COMMIT_EDITMSG contains /commit', () => {
    const { checkFullDeploy } = requireFresh();
    const gitDir = path.join(tmpDir, '.git');
    fs.mkdirSync(gitDir);
    fs.writeFileSync(path.join(gitDir, 'COMMIT_EDITMSG'), 'build: /commit all checks green');
    expect(checkFullDeploy({
      deployMarker: tmpFile('.missing-ship'),
      repoRoot: tmpDir,
    })).toBe(true);
  });

  it('returns false when COMMIT_EDITMSG has no /ship or /commit', () => {
    const { checkFullDeploy } = requireFresh();
    const gitDir = path.join(tmpDir, '.git');
    fs.mkdirSync(gitDir);
    fs.writeFileSync(path.join(gitDir, 'COMMIT_EDITMSG'), 'fix: minor patch');
    expect(checkFullDeploy({
      deployMarker: tmpFile('.missing-ship'),
      repoRoot: tmpDir,
    })).toBe(false);
  });
});

describe('checkZoneBuilder', () => {
  it('returns true when all expected zone files exist', () => {
    const { checkZoneBuilder, EXPECTED_ZONE_FILES } = requireFresh();
    for (const f of EXPECTED_ZONE_FILES) {
      fs.writeFileSync(path.join(tmpDir, f), "'use strict';");
    }
    expect(checkZoneBuilder({ binDir: tmpDir })).toBe(true);
  });

  it('returns false when one zone file is missing', () => {
    const { checkZoneBuilder, EXPECTED_ZONE_FILES } = requireFresh();
    // Write all except the last one
    for (const f of EXPECTED_ZONE_FILES.slice(0, -1)) {
      fs.writeFileSync(path.join(tmpDir, f), "'use strict';");
    }
    expect(checkZoneBuilder({ binDir: tmpDir })).toBe(false);
  });

  it('returns false when bin directory does not exist', () => {
    const { checkZoneBuilder } = requireFresh();
    expect(checkZoneBuilder({ binDir: path.join(tmpDir, 'no-bin') })).toBe(false);
  });
});

describe('checkTestGreen', () => {
  it('returns true when marker has 0 failures', () => {
    const { checkTestGreen } = requireFresh();
    const fp = tmpFile('.last-test-result.json');
    fs.writeFileSync(fp, JSON.stringify({ failures: 0, passed: 338 }));
    expect(checkTestGreen({ testMarker: fp })).toBe(true);
  });

  it('returns false when marker has 1+ failures', () => {
    const { checkTestGreen } = requireFresh();
    const fp = tmpFile('.last-test-result.json');
    fs.writeFileSync(fp, JSON.stringify({ failures: 3, passed: 335 }));
    expect(checkTestGreen({ testMarker: fp })).toBe(false);
  });

  it('supports numFailedTests field (vitest JSON format)', () => {
    const { checkTestGreen } = requireFresh();
    const fp = tmpFile('.last-test-result.json');
    fs.writeFileSync(fp, JSON.stringify({ numFailedTests: 0, numPassedTests: 200 }));
    expect(checkTestGreen({ testMarker: fp })).toBe(true);
  });

  it('returns false when marker file does not exist', () => {
    const { checkTestGreen } = requireFresh();
    expect(checkTestGreen({ testMarker: tmpFile('.no-test') })).toBe(false);
  });

  it('returns false on malformed marker', () => {
    const { checkTestGreen } = requireFresh();
    const fp = tmpFile('.bad-test.json');
    fs.writeFileSync(fp, '{ bad json }');
    expect(checkTestGreen({ testMarker: fp })).toBe(false);
  });
});

describe('checkExportReady', () => {
  it('returns true when 3+ recent export files exist', () => {
    const { checkExportReady } = requireFresh();
    // Create 3 recent .md files
    for (let i = 1; i <= 3; i++) {
      fs.writeFileSync(path.join(tmpDir, `session-export-${i}.md`), `# export ${i}`);
    }
    expect(checkExportReady({ exportDir: tmpDir })).toBe(true);
  });

  it('returns false when fewer than 3 export files exist', () => {
    const { checkExportReady } = requireFresh();
    fs.writeFileSync(path.join(tmpDir, 'export-1.md'), '# 1');
    fs.writeFileSync(path.join(tmpDir, 'export-2.pdf'), '');
    expect(checkExportReady({ exportDir: tmpDir })).toBe(false);
  });

  it('returns false when export directory does not exist', () => {
    const { checkExportReady } = requireFresh();
    expect(checkExportReady({ exportDir: path.join(tmpDir, 'no-dropbox') })).toBe(false);
  });

  it('ignores files with non-export extensions', () => {
    const { checkExportReady } = requireFresh();
    // 3 files with wrong extensions (.cjs, .log, .tmp)
    fs.writeFileSync(path.join(tmpDir, 'thing.cjs'), '');
    fs.writeFileSync(path.join(tmpDir, 'thing.log'), '');
    fs.writeFileSync(path.join(tmpDir, 'thing.tmp'), '');
    expect(checkExportReady({ exportDir: tmpDir })).toBe(false);
  });
});

describe('checkStudioMode', () => {
  it('returns true when zones present and companion-v2 earned', () => {
    const { checkStudioMode, EXPECTED_ZONE_FILES } = requireFresh();
    for (const f of EXPECTED_ZONE_FILES) {
      fs.writeFileSync(path.join(tmpDir, f), "'use strict';");
    }
    const badgeState = { earned: { 'companion-v2': '2026-04-07T00:00:00.000Z' }, newThisSession: [] };
    expect(checkStudioMode({ binDir: tmpDir }, badgeState)).toBe(true);
  });

  it('returns false when companion-v2 not yet earned', () => {
    const { checkStudioMode, EXPECTED_ZONE_FILES } = requireFresh();
    for (const f of EXPECTED_ZONE_FILES) {
      fs.writeFileSync(path.join(tmpDir, f), "'use strict';");
    }
    const badgeState = { earned: {}, newThisSession: [] };
    expect(checkStudioMode({ binDir: tmpDir }, badgeState)).toBe(false);
  });

  it('returns false when zones missing even if companion-v2 earned', () => {
    const { checkStudioMode } = requireFresh();
    const badgeState = { earned: { 'companion-v2': '2026-04-07T00:00:00.000Z' }, newThisSession: [] };
    expect(checkStudioMode({ binDir: path.join(tmpDir, 'no-bin') }, badgeState)).toBe(false);
  });
});

describe('checkAllZones', () => {
  it('mirrors zone-builder result (zones present -> true)', () => {
    const { checkAllZones, checkZoneBuilder, EXPECTED_ZONE_FILES } = requireFresh();
    for (const f of EXPECTED_ZONE_FILES) {
      fs.writeFileSync(path.join(tmpDir, f), "'use strict';");
    }
    const ctx = { binDir: tmpDir };
    expect(checkAllZones(ctx)).toBe(checkZoneBuilder(ctx));
  });
});

describe('checkCompanionV2', () => {
  it('returns true when expressions module has 6+ rule names and a resolver', () => {
    const { checkCompanionV2 } = requireFresh();
    const fakeExpr = path.join(tmpDir, 'hud-expressions.cjs');
    const rules = ['neutral','happy','focused','curious','sleepy','surprised','thinking','winking'].map(
      expr => ({ expr })
    );
    fs.writeFileSync(fakeExpr,
      `'use strict'; module.exports = { EXPRESSION_RULES: ${JSON.stringify(rules)}, getExpressionName: () => 'neutral' };`
    );
    expect(checkCompanionV2({ expressionsPath: fakeExpr })).toBe(true);
  });

  it('returns false when expressions module has fewer than 6 rule names', () => {
    const { checkCompanionV2 } = requireFresh();
    const fakeExpr = path.join(tmpDir, 'hud-expressions.cjs');
    const rules = ['neutral','happy','focused'].map(expr => ({ expr }));
    fs.writeFileSync(fakeExpr,
      `'use strict'; module.exports = { EXPRESSION_RULES: ${JSON.stringify(rules)}, getExpressionName: () => 'neutral' };`
    );
    expect(checkCompanionV2({ expressionsPath: fakeExpr })).toBe(false);
  });

  it('returns false when expressions file does not exist', () => {
    const { checkCompanionV2 } = requireFresh();
    expect(checkCompanionV2({ expressionsPath: path.join(tmpDir, 'no-expr.cjs') })).toBe(false);
  });

  it('returns false when getExpressionName export is missing', () => {
    const { checkCompanionV2 } = requireFresh();
    const fakeExpr = path.join(tmpDir, 'hud-expressions.cjs');
    const rules = ['neutral','happy','focused','curious','sleepy','surprised'].map(expr => ({ expr }));
    fs.writeFileSync(fakeExpr,
      `'use strict'; module.exports = { EXPRESSION_RULES: ${JSON.stringify(rules)} };`
    );
    expect(checkCompanionV2({ expressionsPath: fakeExpr })).toBe(false);
  });
});

describe('checkMemoryKeeper', () => {
  it('returns true when total >= 50', () => {
    const { checkMemoryKeeper } = requireFresh();
    const fp = tmpFile('.memory-stats.json');
    fs.writeFileSync(fp, JSON.stringify({ total: 73 }));
    expect(checkMemoryKeeper({ memoryStatsPath: fp })).toBe(true);
  });

  it('returns false when total < 50', () => {
    const { checkMemoryKeeper } = requireFresh();
    const fp = tmpFile('.memory-stats.json');
    fs.writeFileSync(fp, JSON.stringify({ total: 49 }));
    expect(checkMemoryKeeper({ memoryStatsPath: fp })).toBe(false);
  });

  it('returns true at exactly 50', () => {
    const { checkMemoryKeeper } = requireFresh();
    const fp = tmpFile('.memory-stats.json');
    fs.writeFileSync(fp, JSON.stringify({ count: 50 }));
    expect(checkMemoryKeeper({ memoryStatsPath: fp })).toBe(true);
  });

  it('supports total_memories field', () => {
    const { checkMemoryKeeper } = requireFresh();
    const fp = tmpFile('.memory-stats.json');
    fs.writeFileSync(fp, JSON.stringify({ total_memories: 100 }));
    expect(checkMemoryKeeper({ memoryStatsPath: fp })).toBe(true);
  });

  it('returns false when stats file does not exist', () => {
    const { checkMemoryKeeper } = requireFresh();
    expect(checkMemoryKeeper({ memoryStatsPath: tmpFile('.no-stats') })).toBe(false);
  });
});

// ============================================================
// checkBadges (integration)
// ============================================================

describe('checkBadges', () => {
  it('earns zone-builder when all zone files present', () => {
    const { checkBadges, EXPECTED_ZONE_FILES } = requireFresh();
    const zonesDir = path.join(tmpDir, 'bin');
    fs.mkdirSync(zonesDir);
    for (const f of EXPECTED_ZONE_FILES) {
      fs.writeFileSync(path.join(zonesDir, f), "'use strict';");
    }
    const fp = tmpFile('badges.json');
    const { badgeState, newlyEarned } = checkBadges(
      { binDir: zonesDir },
      { filePath: fp, dryRun: true },
    );
    expect(newlyEarned).toContain('zone-builder');
    expect(badgeState.earned['zone-builder']).toBeDefined();
  });

  it('earns all-zones simultaneously with zone-builder', () => {
    const { checkBadges, EXPECTED_ZONE_FILES } = requireFresh();
    const zonesDir = path.join(tmpDir, 'bin');
    fs.mkdirSync(zonesDir);
    for (const f of EXPECTED_ZONE_FILES) {
      fs.writeFileSync(path.join(zonesDir, f), "'use strict';");
    }
    const { newlyEarned } = checkBadges(
      { binDir: zonesDir },
      { filePath: tmpFile('b.json'), dryRun: true },
    );
    expect(newlyEarned).toContain('zone-builder');
    expect(newlyEarned).toContain('all-zones');
  });

  it('does not re-earn already-earned badges', () => {
    const { checkBadges, EXPECTED_ZONE_FILES } = requireFresh();
    const zonesDir = path.join(tmpDir, 'bin');
    fs.mkdirSync(zonesDir);
    for (const f of EXPECTED_ZONE_FILES) {
      fs.writeFileSync(path.join(zonesDir, f), "'use strict';");
    }
    const fp = tmpFile('badges-preearned.json');
    // Pre-earn zone-builder
    const preState = {
      earned: { 'zone-builder': '2026-01-01T00:00:00.000Z' },
      newThisSession: [],
    };
    fs.writeFileSync(fp, JSON.stringify(preState));

    const { newlyEarned } = checkBadges({ binDir: zonesDir }, { filePath: fp });
    expect(newlyEarned).not.toContain('zone-builder');
  });

  it('earns forge-master when 5+ HANDOFF files present', () => {
    const { checkBadges } = requireFresh();
    for (let i = 1; i <= 6; i++) {
      fs.writeFileSync(path.join(tmpDir, `HANDOFF-S${i}.md`), `# s${i}`);
    }
    const fp = tmpFile('b2.json');
    const { newlyEarned } = checkBadges(
      { runsDir: tmpDir },
      { filePath: fp, dryRun: true },
    );
    expect(newlyEarned).toContain('forge-master');
  });

  it('persists newly earned badges to file when dryRun is false', () => {
    const { checkBadges } = requireFresh();
    for (let i = 1; i <= 5; i++) {
      fs.writeFileSync(path.join(tmpDir, `HANDOFF-S${i}.md`), '');
    }
    const fp = tmpFile('persist.json');
    checkBadges({ runsDir: tmpDir }, { filePath: fp, dryRun: false });
    const saved = JSON.parse(fs.readFileSync(fp, 'utf8'));
    expect(saved.earned['forge-master']).toBeDefined();
  });

  it('does not write to disk on dryRun', () => {
    const { checkBadges } = requireFresh();
    for (let i = 1; i <= 5; i++) {
      fs.writeFileSync(path.join(tmpDir, `HANDOFF-S${i}.md`), '');
    }
    const fp = tmpFile('dry.json');
    checkBadges({ runsDir: tmpDir }, { filePath: fp, dryRun: true });
    expect(fs.existsSync(fp)).toBe(false);
  });

  it('handles empty context gracefully', () => {
    const { checkBadges } = requireFresh();
    // No ctx paths — all checks hit missing dirs and return false
    const fp = tmpFile('empty-ctx.json');
    const { newlyEarned } = checkBadges({}, { filePath: fp, dryRun: true });
    // We can't assert no badges earned (depends on actual env), but it must not throw
    expect(Array.isArray(newlyEarned)).toBe(true);
  });

  it('returns newlyEarned as empty array when nothing qualifies', () => {
    const { checkBadges } = requireFresh();
    // All ctx paths point to empty tmpDir — nothing will qualify
    const ctx = {
      runsDir: path.join(tmpDir, 'no-runs'),
      auditDir: path.join(tmpDir, 'no-audit'),
      binDir: path.join(tmpDir, 'no-bin'),
      deployMarker: path.join(tmpDir, 'no-ship'),
      repoRoot: path.join(tmpDir, 'no-repo'),
      testMarker: path.join(tmpDir, 'no-test'),
      exportDir: path.join(tmpDir, 'no-export'),
      expressionsPath: path.join(tmpDir, 'no-expr.cjs'),
      memoryStatsPath: path.join(tmpDir, 'no-stats'),
    };
    const fp = tmpFile('none.json');
    const { newlyEarned } = checkBadges(ctx, { filePath: fp, dryRun: true });
    expect(newlyEarned).toEqual([]);
  });
});

// ============================================================
// getBadgeState
// ============================================================

describe('getBadgeState', () => {
  it('returns empty state when no file exists', () => {
    const { getBadgeState } = requireFresh();
    const state = getBadgeState({ filePath: tmpFile('no-file.json') });
    expect(state.earned).toEqual({});
    expect(state.newThisSession).toEqual([]);
  });

  it('returns saved state', () => {
    const { getBadgeState, saveBadgeState } = requireFresh();
    const fp = tmpFile('get.json');
    saveBadgeState({
      earned: { 'test-green': '2026-04-07T00:00:00.000Z' },
      newThisSession: ['test-green'],
    }, fp);
    const state = getBadgeState({ filePath: fp });
    expect(state.earned['test-green']).toBeDefined();
    expect(state.newThisSession).toContain('test-green');
  });
});

// ============================================================
// BADGE_CHECKS registry
// ============================================================

describe('BADGE_CHECKS', () => {
  it('has entries for all 10 badge ids', () => {
    const { BADGE_CHECKS } = requireFresh();
    const expectedIds = [
      'forge-master', 'audit-clean', 'full-deploy', 'zone-builder',
      'test-green', 'export-ready', 'studio-mode', 'all-zones',
      'companion-v2', 'memory-keeper',
    ];
    for (const id of expectedIds) {
      expect(BADGE_CHECKS).toHaveProperty(id);
      expect(typeof BADGE_CHECKS[id]).toBe('function');
    }
  });

  it('each check function returns a boolean', () => {
    const { BADGE_CHECKS } = requireFresh();
    const emptyCtx = {
      runsDir: path.join(tmpDir, 'x'),
      auditDir: path.join(tmpDir, 'x'),
      binDir: path.join(tmpDir, 'x'),
      deployMarker: path.join(tmpDir, 'x'),
      repoRoot: path.join(tmpDir, 'x'),
      testMarker: path.join(tmpDir, 'x'),
      exportDir: path.join(tmpDir, 'x'),
      expressionsPath: path.join(tmpDir, 'x.cjs'),
      memoryStatsPath: path.join(tmpDir, 'x'),
    };
    const emptyBadgeState = { earned: {}, newThisSession: [] };
    for (const [id, fn] of Object.entries(BADGE_CHECKS)) {
      const result = fn(emptyCtx, emptyBadgeState);
      expect(typeof result, `${id} should return boolean`).toBe('boolean');
    }
  });
});
