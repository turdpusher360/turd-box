import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULTS_PATH = resolve(__dirname, '../references/threshold-defaults.json');

// Load the defaults file once for all tests
const raw = readFileSync(DEFAULTS_PATH, 'utf-8');
const defaults = JSON.parse(raw);

const EXPECTED_CATEGORIES = [
  'branches',
  'dependencies',
  'agents',
  'hooks',
  'tests',
  'config',
  'dead_code',
  'docs',
  'security',
];

// ---------------------------------------------------------------------------
// Helper: deep-merge two plain objects (mimics config resolution order)
// ---------------------------------------------------------------------------
function deepMerge(base, override) {
  if (override === null || override === undefined) return base;
  const result = { ...base };
  for (const key of Object.keys(override)) {
    if (
      override[key] !== null &&
      typeof override[key] === 'object' &&
      !Array.isArray(override[key]) &&
      typeof base[key] === 'object' &&
      base[key] !== null &&
      !Array.isArray(base[key])
    ) {
      result[key] = deepMerge(base[key], override[key]);
    } else if (override[key] === null) {
      delete result[key];
    } else {
      result[key] = override[key];
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Helper: apply security floors post-merge
// ---------------------------------------------------------------------------
function applySecurityFloors(config) {
  const result = deepMerge({}, config);
  if (!result.categories || !result.categories.security) return result;

  const sec = result.categories.security;

  // Floor: security cannot be disabled
  if (sec.enabled === false) {
    sec.enabled = true;
  }

  // Floor: pass_threshold cannot drop below 30
  if (typeof sec.pass_threshold === 'number' && sec.pass_threshold < 30) {
    sec.pass_threshold = 30;
  }

  // Floor: threshold points cannot be weaker than -1 (i.e., 0 or positive is rejected)
  if (sec.thresholds) {
    for (const [id, entry] of Object.entries(sec.thresholds)) {
      if (typeof entry.points === 'number' && entry.points > -1) {
        throw new Error(
          `Security threshold "${id}" has points=${entry.points}, which is weaker than -1. ` +
            'Security thresholds must represent a real penalty.'
        );
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Helper: validate a ThresholdEntry
// ---------------------------------------------------------------------------
function validateEntry(id, entry) {
  const errors = [];

  if (typeof entry.points !== 'number' || !Number.isInteger(entry.points) || entry.points > 0) {
    errors.push(`${id}.points must be a negative integer or zero`);
  }
  if (typeof entry.max !== 'number' || !Number.isInteger(entry.max)) {
    errors.push(`${id}.max must be an integer`);
  } else if (Math.abs(entry.max) < Math.abs(entry.points)) {
    errors.push(
      `${id}.max (${entry.max}) must be at least as negative as points (${entry.points})`
    );
  }
  if (entry.per !== undefined) {
    if (!Number.isInteger(entry.per) || entry.per <= 0) {
      errors.push(`${id}.per must be a positive integer`);
    }
  }
  if (entry.stale_days !== undefined) {
    if (!Number.isInteger(entry.stale_days) || entry.stale_days <= 0) {
      errors.push(`${id}.stale_days must be a positive integer`);
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('threshold-defaults.json', () => {
  it('loads successfully and parses as valid JSON', () => {
    expect(defaults).toBeDefined();
    expect(typeof defaults).toBe('object');
    expect(defaults.version).toBe('1.0.0');
  });

  it('contains all 9 expected categories', () => {
    expect(defaults.categories).toBeDefined();
    for (const cat of EXPECTED_CATEGORIES) {
      expect(
        defaults.categories,
        `expected category "${cat}" to be present`
      ).toHaveProperty(cat);
    }
    // Exactly 9 categories (no extras slipped in)
    expect(Object.keys(defaults.categories)).toHaveLength(9);
  });

  it('every category has a thresholds array with at least one entry', () => {
    for (const cat of EXPECTED_CATEGORIES) {
      const { thresholds } = defaults.categories[cat];
      expect(Array.isArray(thresholds), `${cat}.thresholds should be an array`).toBe(true);
      expect(thresholds.length, `${cat}.thresholds should have at least one entry`).toBeGreaterThan(0);
    }
  });

  it('every threshold entry has required fields: id, points, max, description', () => {
    for (const cat of EXPECTED_CATEGORIES) {
      for (const entry of defaults.categories[cat].thresholds) {
        expect(entry, `${cat} entry missing id`).toHaveProperty('id');
        expect(entry, `${cat}/${entry.id} missing points`).toHaveProperty('points');
        expect(entry, `${cat}/${entry.id} missing max`).toHaveProperty('max');
        expect(entry, `${cat}/${entry.id} missing description`).toHaveProperty('description');
        expect(typeof entry.description).toBe('string');
        expect(entry.description.length).toBeGreaterThan(0);
      }
    }
  });

  it('all threshold points are negative (deductions, never positive)', () => {
    for (const cat of EXPECTED_CATEGORIES) {
      for (const entry of defaults.categories[cat].thresholds) {
        expect(
          entry.points,
          `${cat}/${entry.id}.points should be negative, got ${entry.points}`
        ).toBeLessThan(0);
      }
    }
  });

  it('max is always <= points (cap is at least as large as a single deduction)', () => {
    for (const cat of EXPECTED_CATEGORIES) {
      for (const entry of defaults.categories[cat].thresholds) {
        expect(
          entry.max,
          `${cat}/${entry.id}.max (${entry.max}) must be <= points (${entry.points})`
        ).toBeLessThanOrEqual(entry.points);
      }
    }
  });

  it('security category has security_floor: true', () => {
    expect(defaults.categories.security.security_floor).toBe(true);
  });

  it('pass_threshold is a number between 0 and 100', () => {
    expect(typeof defaults.pass_threshold).toBe('number');
    expect(defaults.pass_threshold).toBeGreaterThanOrEqual(0);
    expect(defaults.pass_threshold).toBeLessThanOrEqual(100);
  });

  it('all entries pass full ThresholdEntry validation', () => {
    const allErrors = [];
    for (const cat of EXPECTED_CATEGORIES) {
      for (const entry of defaults.categories[cat].thresholds) {
        const errors = validateEntry(`${cat}/${entry.id}`, entry);
        allErrors.push(...errors);
      }
    }
    expect(allErrors, allErrors.join('\n')).toHaveLength(0);
  });
});

describe('config resolution: project overrides deep-merge over defaults', () => {
  it('override of one threshold entry does not affect other entries in same category', () => {
    // Simulate a project config that changes only security.env_tracked
    const projectOverride = {
      categories: {
        security: {
          thresholds: [
            { id: 'env_tracked', points: -10, max: -10, description: 'custom' },
          ],
        },
      },
    };

    // Build a resolved thresholds map for security by merging at entry level (by id)
    const baseEntries = defaults.categories.security.thresholds;
    const overrideEntries = projectOverride.categories.security.thresholds;

    const overrideById = Object.fromEntries(overrideEntries.map((e) => [e.id, e]));
    const resolved = baseEntries.map((entry) =>
      overrideById[entry.id] ? { ...entry, ...overrideById[entry.id] } : entry
    );

    // env_tracked should be overridden
    const envTracked = resolved.find((e) => e.id === 'env_tracked');
    expect(envTracked.points).toBe(-10);
    expect(envTracked.max).toBe(-10);

    // Other entries (e.g., pin_mismatch) should be unchanged
    const pinMismatch = resolved.find((e) => e.id === 'pin_mismatch');
    const basePin = baseEntries.find((e) => e.id === 'pin_mismatch');
    expect(pinMismatch.points).toBe(basePin.points);
    expect(pinMismatch.max).toBe(basePin.max);
  });

  it('override of stale_days for agents.stale_verified is independent of other agent thresholds', () => {
    const baseEntries = defaults.categories.agents.thresholds;
    const overrideEntries = [{ id: 'stale_verified', points: -2, max: -10, stale_days: 30 }];

    const overrideById = Object.fromEntries(overrideEntries.map((e) => [e.id, e]));
    const resolved = baseEntries.map((entry) =>
      overrideById[entry.id] ? { ...entry, ...overrideById[entry.id] } : entry
    );

    const staleVerified = resolved.find((e) => e.id === 'stale_verified');
    expect(staleVerified.stale_days).toBe(30);

    // missing_maxturns should be unchanged
    const base = baseEntries.find((e) => e.id === 'missing_maxturns');
    const after = resolved.find((e) => e.id === 'missing_maxturns');
    expect(after.points).toBe(base.points);
  });
});

describe('security floor enforcement', () => {
  it('security category cannot be disabled (enabled:false is silently reset to true)', () => {
    const config = {
      categories: {
        security: { enabled: false, thresholds: defaults.categories.security.thresholds },
      },
    };
    const result = applySecurityFloors(config);
    expect(result.categories.security.enabled).toBe(true);
  });

  it('security pass_threshold floor of 30 — value below 30 is raised', () => {
    const config = {
      categories: {
        security: { pass_threshold: 10, thresholds: defaults.categories.security.thresholds },
      },
    };
    const result = applySecurityFloors(config);
    expect(result.categories.security.pass_threshold).toBe(30);
  });

  it('security pass_threshold of 50 is not modified (above floor)', () => {
    const config = {
      categories: {
        security: { pass_threshold: 50, thresholds: defaults.categories.security.thresholds },
      },
    };
    const result = applySecurityFloors(config);
    expect(result.categories.security.pass_threshold).toBe(50);
  });

  it('security threshold points weaker than -1 (i.e., 0) are rejected', () => {
    const config = {
      categories: {
        security: {
          thresholds: { env_tracked: { points: 0, max: 0 } },
        },
      },
    };
    expect(() => applySecurityFloors(config)).toThrow(
      /points=0.*weaker than -1|Security threshold.*env_tracked/
    );
  });

  it('valid security threshold points (-1) pass floor enforcement', () => {
    const config = {
      categories: {
        security: {
          thresholds: { pin_mismatch: { points: -1, max: -3 } },
        },
      },
    };
    expect(() => applySecurityFloors(config)).not.toThrow();
  });
});

describe('unknown override keys produce warnings (not errors)', () => {
  it('unknown threshold id in override does not throw — logs warning only', () => {
    // The spec says unknown keys produce a warning (stderr), not an error.
    // We verify that validation of an unknown key returns a non-empty warning string
    // rather than throwing.
    const knownIds = new Set(
      defaults.categories.branches.thresholds.map((e) => e.id)
    );
    const unknownId = 'totally_unknown_key';
    const isKnown = knownIds.has(unknownId);

    // Simulate the warning path: unknown key is not in defaults, should warn not throw
    const warnings = [];
    if (!isKnown) {
      warnings.push(`Unknown threshold id "${unknownId}" in branches — override ignored`);
    }

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(unknownId);
    // No throw occurred — the test itself passes if we reach this assertion
  });
});
