import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULTS_PATH = join(__dirname, 'wizard-defaults.json');

function loadDefaults() {
  return JSON.parse(readFileSync(DEFAULTS_PATH, 'utf-8'));
}

describe('wizard-defaults.json', () => {
  it('parses as valid JSON with version 1.2.0', () => {
    const defaults = loadDefaults();
    expect(defaults).toBeDefined();
    expect(defaults.version).toBe('1.2.0');
  });

  it('has all 9 built-in categories', () => {
    const defaults = loadDefaults();
    const expected = [
      'branches', 'dependencies', 'agents', 'hooks',
      'tests', 'config', 'dead_code', 'docs', 'security'
    ];
    const actual = Object.keys(defaults.categories);
    expect(actual).toEqual(expect.arrayContaining(expected));
    expect(actual).toHaveLength(9);
  });

  it('every category has required fields with valid values', () => {
    const defaults = loadDefaults();
    for (const [name, cat] of Object.entries(defaults.categories)) {
      expect(cat.enabled, `${name}.enabled`).toBe(true);
      expect(typeof cat.pass_threshold, `${name}.pass_threshold type`).toBe('number');
      expect(cat.pass_threshold, `${name}.pass_threshold >= 30`).toBeGreaterThanOrEqual(30);
      expect(typeof cat.deep_dive_threshold, `${name}.deep_dive_threshold type`).toBe('number');
      expect(typeof cat.weight, `${name}.weight type`).toBe('number');
      expect(cat.weight, `${name}.weight > 0`).toBeGreaterThan(0);
    }
  });

  it('security category has weight 1.5 and deep_dive_threshold 40', () => {
    const defaults = loadDefaults();
    expect(defaults.categories.security.weight).toBe(1.5);
    expect(defaults.categories.security.deep_dive_threshold).toBe(40);
  });

  it('security floors are defined and non-overridable', () => {
    const defaults = loadDefaults();
    const floors = defaults.security_floors;
    expect(floors).toBeDefined();
    expect(floors.min_pass_threshold).toBe(30);
    expect(floors.enabled_locked).toBe(true);
    expect(floors.suppress_wildcard_blocked).toBe(true);
    expect(floors.auto_promote_max_tier).toBe('suggested');
  });

  it('research defaults use conservative sources (no web by default)', () => {
    const defaults = loadDefaults();
    expect(defaults.research.depth).toBe('standard');
    expect(defaults.research.confidence_threshold).toBe(0.80);
    expect(defaults.research.sources).toEqual(['memory', 'codebase']);
    expect(defaults.research.sources).not.toContain('web');
  });

  it('inbox auto_capture defaults to false with error sanitization', () => {
    const defaults = loadDefaults();
    expect(defaults.inbox.auto_capture).toBe(false);
    expect(defaults.inbox.sanitize_errors).toBe(true);
    expect(defaults.inbox.max_error_length).toBe(200);
  });

  it('verification commands match the project triad', () => {
    const defaults = loadDefaults();
    expect(defaults.verification.commands).toEqual([
      'npx tsc --noEmit',
      'npx eslint .',
      'npx vitest run'
    ]);
  });

  it('context budget warn threshold is 80K', () => {
    const defaults = loadDefaults();
    expect(defaults.context_budget.warn_threshold_tokens).toBe(80000);
    expect(defaults.context_budget.auto_safe_forced_depth).toBe('quick');
  });

  it('scan_exclude has sensible defaults', () => {
    const defaults = loadDefaults();
    expect(defaults.scan_exclude).toBeDefined();
    expect(Array.isArray(defaults.scan_exclude)).toBe(true);
    expect(defaults.scan_exclude).toContain('node_modules/');
  });

  it('thresholds block has source and pass_threshold', () => {
    const defaults = loadDefaults();
    expect(defaults.thresholds).toBeDefined();
    expect(defaults.thresholds.pass_threshold).toBe(80);
    expect(defaults.thresholds.overrides).toEqual({});
  });

  it('dfe block has solo_confidence_penalty', () => {
    const defaults = loadDefaults();
    expect(defaults.dfe).toBeDefined();
    expect(defaults.dfe.solo_confidence_penalty.tp).toBe(-10);
    expect(defaults.dfe.default_review_context).toBe('solo');
  });

  it('respawn block has decay settings', () => {
    const defaults = loadDefaults();
    expect(defaults.respawn).toBeDefined();
    expect(defaults.respawn.importance_threshold).toBe(0.3);
    expect(defaults.respawn.decay.session_floor).toBe(0.1);
    expect(defaults.respawn.decay.project_days).toBe(14);
  });

  it('ci block has score_threshold and output_format', () => {
    const defaults = loadDefaults();
    expect(defaults.ci).toBeDefined();
    expect(defaults.ci.score_threshold).toBe(70);
    expect(defaults.ci.output_format).toBe('json');
  });
});

describe('config merge logic', () => {
  it('deep merge: project overrides at leaf level', () => {
    const base = {
      categories: {
        branches: { enabled: true, stale_days: 30, weight: 1.0 },
        security: { enabled: true, weight: 1.5 }
      }
    };
    const project = {
      categories: {
        branches: { stale_days: 14 }
      }
    };

    const merged = deepMerge(base, project);
    expect(merged.categories.branches.enabled).toBe(true);
    expect(merged.categories.branches.stale_days).toBe(14);
    expect(merged.categories.branches.weight).toBe(1.0);
    expect(merged.categories.security.enabled).toBe(true);
    expect(merged.categories.security.weight).toBe(1.5);
  });

  it('arrays replace, not append', () => {
    const base = { research: { sources: ['memory', 'codebase'] } };
    const project = { research: { sources: ['memory', 'codebase', 'web', 'osv'] } };

    const merged = deepMerge(base, project);
    expect(merged.research.sources).toEqual(['memory', 'codebase', 'web', 'osv']);
    expect(merged.research.sources).toHaveLength(4);
  });

  it('null removes field', () => {
    const base = { categories: { branches: { enabled: true, stale_days: 30 } } };
    const project = { categories: { branches: { stale_days: null } } };

    const merged = deepMerge(base, project);
    expect(merged.categories.branches.enabled).toBe(true);
    expect(merged.categories.branches.stale_days).toBeUndefined();
  });

  it('security.enabled cannot be overridden to false', () => {
    const defaults = { categories: { security: { enabled: true, pass_threshold: 80 } } };
    const project = { categories: { security: { enabled: false } } };
    const floors = { min_pass_threshold: 30, enabled_locked: true };

    const merged = deepMerge(defaults, project);
    applySecurityFloors(merged, floors);
    expect(merged.categories.security.enabled).toBe(true);
  });

  it('security.pass_threshold cannot go below floor', () => {
    const defaults = { categories: { security: { enabled: true, pass_threshold: 80 } } };
    const project = { categories: { security: { pass_threshold: 10 } } };
    const floors = { min_pass_threshold: 30, enabled_locked: true };

    const merged = deepMerge(defaults, project);
    applySecurityFloors(merged, floors);
    expect(merged.categories.security.pass_threshold).toBe(30);
  });

  it('suppress catch-all equivalents on security are rejected', () => {
    const floors = { suppress_wildcard_blocked: true };
    const catchAlls = ['.*', '.+', '[\\s\\S]*', '(?:.*)', '.{0,}'];
    for (const pattern of catchAlls) {
      const suppress = [{ category: 'security', pattern, reason: 'bypass', expires_at: null }];
      const filtered = filterSuppressEntries(suppress, floors);
      expect(filtered, `pattern "${pattern}" should be blocked`).toHaveLength(0);
    }
  });

  it('suppress specific security patterns are allowed', () => {
    const suppress = [
      { category: 'security', pattern: 'pin-mismatch-lodash', reason: 'known', expires_at: '2026-12-31' }
    ];
    const floors = { suppress_wildcard_blocked: true };
    const filtered = filterSuppressEntries(suppress, floors);
    expect(filtered).toHaveLength(1);
  });

  it('suppress wildcard on security is rejected', () => {
    const suppress = [
      { category: 'dead_code', pattern: 'TODO in test files', reason: 'ok', expires_at: '2026-12-31' },
      { category: 'security', pattern: '.*', reason: 'bypass', expires_at: null }
    ];
    const floors = { suppress_wildcard_blocked: true };

    const filtered = filterSuppressEntries(suppress, floors);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].category).toBe('dead_code');
  });

  it('expired suppress entries are removed', () => {
    const suppress = [
      { category: 'dead_code', pattern: 'old', reason: 'expired', expires_at: '2020-01-01' },
      { category: 'hooks', pattern: 'valid', reason: 'still good', expires_at: '2030-12-31' },
      { category: 'config', pattern: 'permanent', reason: 'always', expires_at: null }
    ];

    const filtered = removeExpiredSuppressEntries(suppress);
    expect(filtered).toHaveLength(2);
    expect(filtered[0].category).toBe('hooks');
    expect(filtered[1].category).toBe('config');
  });
});

describe('grade assignment', () => {
  it('assigns correct grades at all boundaries', () => {
    expect(assignGrade(100)).toBe('A');
    expect(assignGrade(90)).toBe('A');
    expect(assignGrade(89)).toBe('B');
    expect(assignGrade(75)).toBe('B');
    expect(assignGrade(74)).toBe('C');
    expect(assignGrade(55)).toBe('C');
    expect(assignGrade(54)).toBe('D');
    expect(assignGrade(35)).toBe('D');
    expect(assignGrade(34)).toBe('F');
    expect(assignGrade(0)).toBe('F');
  });

  it('weighted_score=76 is grade B (DFE P0 regression test)', () => {
    expect(assignGrade(76)).toBe('B');
  });

  it('weighted_score=77 is grade B (DFE P0 regression test)', () => {
    expect(assignGrade(77)).toBe('B');
  });
});

describe('weighted score calculation', () => {
  it('produces correct weighted score for default weights', () => {
    const scores = {
      branches: 18, dependencies: 8, agents: 15, hooks: 16,
      tests: 12, config: 6, dead_code: 14, docs: 17, security: 19
    };
    const weights = {
      branches: 1.0, dependencies: 1.2, agents: 0.8, hooks: 1.0,
      tests: 1.0, config: 1.0, dead_code: 0.8, docs: 0.6, security: 1.5
    };

    const weighted = calculateWeightedScore(scores, weights);
    // Numerator: 18 + 9.6 + 12 + 16 + 12 + 6 + 11.2 + 10.2 + 28.5 = 123.5
    // Denominator: 20 * 8.9 = 178
    // Result: 123.5 / 178 * 100 = 69.38
    expect(weighted).toBeCloseTo(69.4, 0);
  });

  it('excludes disabled categories from denominator', () => {
    const scores = { branches: 20, security: 20 };
    const weights = { branches: 1.0, security: 1.5 };

    const weighted = calculateWeightedScore(scores, weights);
    expect(weighted).toBe(100);
  });

  it('excludes weight=0 categories from both numerator and denominator', () => {
    const scores = { branches: 20, security: 20, docs: 10 };
    const weights = { branches: 1.0, security: 1.5, docs: 0 };

    const weighted = calculateWeightedScore(scores, weights);
    // docs excluded: numerator = 20*1.0 + 20*1.5 = 50, denominator = 20*1.0 + 20*1.5 = 50
    expect(weighted).toBe(100);
  });

  it('handles all-zero scores correctly', () => {
    const scores = { branches: 0, dependencies: 0 };
    const weights = { branches: 1.0, dependencies: 1.0 };

    const weighted = calculateWeightedScore(scores, weights);
    expect(weighted).toBe(0);
  });

  it('handles empty input', () => {
    const weighted = calculateWeightedScore({}, {});
    expect(weighted).toBe(0);
  });
});

// --- Reference implementations matching SKILL.md algorithm specs ---
// These functions implement the wizard's config merge, security floor enforcement,
// grade assignment, and weighted scoring logic. They are the canonical reference
// implementations -- the LLM executes this logic at skill runtime by following
// SKILL.md prose instructions. If SKILL.md changes these algorithms (e.g., grade
// boundaries, merge rules, scoring formula), update these helpers to match.

function deepMerge(base, override) {
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === null) {
      delete result[key];
    } else if (Array.isArray(value)) {
      result[key] = value;
    } else if (
      typeof value === 'object' && value !== null &&
      typeof result[key] === 'object' && result[key] !== null &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(result[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function applySecurityFloors(config, floors) {
  const sec = config.categories?.security;
  if (!sec) return;
  if (floors.enabled_locked && sec.enabled === false) {
    sec.enabled = true;
  }
  if (floors.min_pass_threshold != null && sec.pass_threshold < floors.min_pass_threshold) {
    sec.pass_threshold = floors.min_pass_threshold;
  }
}

function filterSuppressEntries(suppress, floors) {
  return suppress.filter(entry => {
    if (floors.suppress_wildcard_blocked && entry.category === 'security') {
      // Block exact '.*' and common catch-all equivalents that bypass the security floor
      const catchAllPatterns = ['.*', '.+', '[\\s\\S]*', '[\\s\\S]+', '(?:.*)', '.{0,}', '(.*)'];
      if (catchAllPatterns.includes(entry.pattern)) {
        return false;
      }
      // Functional check: if the regex matches both empty string and a long arbitrary string,
      // it is effectively a catch-all
      try {
        const re = new RegExp(entry.pattern);
        if (re.test('') && re.test('arbitrary-long-string-for-catch-all-detection-xyz')) {
          return false;
        }
      } catch {
        // Invalid regex -- reject to be safe
        return false;
      }
    }
    return true;
  });
}

function removeExpiredSuppressEntries(suppress) {
  const now = new Date();
  return suppress.filter(entry => {
    if (entry.expires_at === null) return true;
    return new Date(entry.expires_at) > now;
  });
}

function assignGrade(weightedScore) {
  if (weightedScore >= 90) return 'A';
  if (weightedScore >= 75) return 'B';
  if (weightedScore >= 55) return 'C';
  if (weightedScore >= 35) return 'D';
  return 'F';
}

function calculateWeightedScore(scores, weights) {
  let numerator = 0;
  let denominator = 0;
  for (const [category, score] of Object.entries(scores)) {
    const weight = weights[category] ?? 1.0;
    if (weight === 0) continue; // Disabled categories excluded from both numerator and denominator
    numerator += score * weight;
    denominator += 20 * weight;
  }
  if (denominator === 0) return 0;
  return (numerator / denominator) * 100;
}
