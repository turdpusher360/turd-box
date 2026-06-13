'use strict';

/**
 * Deep merge two objects. Null values in override remove keys from base.
 * @param {Object} base
 * @param {Object} override
 * @returns {Object}
 */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function deepMerge(base, override) {
  if (!override || typeof override !== 'object') return base;
  if (!base || typeof base !== 'object') return override;

  const result = { ...base };
  for (const [key, val] of Object.entries(override)) {
    if (UNSAFE_KEYS.has(key)) continue;
    if (val === null) {
      delete result[key];
    } else if (typeof val === 'object' && !Array.isArray(val) && typeof result[key] === 'object' && !Array.isArray(result[key])) {
      result[key] = deepMerge(result[key], val);
    } else {
      result[key] = val;
    }
  }
  return result;
}

/**
 * 4-layer config merge: plugin defaults -> vertical defaults -> project config -> mode frontmatter.
 * When verticalDefaults is null/undefined, behavior is identical to the original 3-layer merge.
 * @param {Object} pluginDefaults - from wizard-defaults.json
 * @param {Object|null} verticalDefaults - from verticals/<name>/defaults.json (may be null)
 * @param {Object} projectConfig - from .4ge-wizard.json (may be null)
 * @param {Object} modeFrontmatter - from mode .md frontmatter overrides (may be null)
 * @returns {Object} resolved config
 */
function mergeConfig(pluginDefaults, verticalDefaults, projectConfig, modeFrontmatter) {
  // Backward compat: detect old 3-arg call pattern.
  // If called with 3 args where the 2nd arg looks like a project config (has 'version' or 'categories')
  // and the 3rd is a mode-like object or null, shift arguments.
  if (arguments.length === 3) {
    modeFrontmatter = projectConfig;
    projectConfig = verticalDefaults;
    verticalDefaults = null;
  }

  let merged = deepMerge({}, pluginDefaults || {});
  merged = deepMerge(merged, verticalDefaults || {});
  merged = deepMerge(merged, projectConfig || {});
  merged = deepMerge(merged, modeFrontmatter || {});
  return enforceSecurityFloors(merged);
}

/**
 * Apply non-overridable security minimums.
 * @param {Object} config
 * @returns {Object}
 */
function enforceSecurityFloors(config) {
  // Restore categories if nulled out (W5 DFE fix)
  if (!config.categories || typeof config.categories !== 'object') {
    config.categories = {};
  }

  const sec = config.categories.security;
  if (sec) {
    // Security cannot be disabled
    if (sec.enabled === false) sec.enabled = true;
    // Minimum pass threshold
    if (sec.pass_threshold !== undefined && sec.pass_threshold < 30) {
      sec.pass_threshold = 30;
    }
  } else {
    // Security category must exist
    config.categories.security = { enabled: true, weight: 1.5 };
  }

  // Reject wildcard suppress on security
  if (Array.isArray(config.suppress)) {
    config.suppress = config.suppress.filter(s =>
      !(s.category === 'security' && (s.pattern === '.*' || s.pattern === '(.+)'))
    );
  }

  // Security threshold overrides cannot weaken the deduction below a real
  // penalty. A floor that only guards `points` is bypassable via `max` (caps
  // total deduction at ~0) or `per` (makes deductions effectively never fire),
  // so reject any override field that neuters the security penalty. This is the
  // documented canonical override path (config-schema.md:127,153-164) and the
  // same path wizard-scan reads, so the floor is non-bypassable.
  const secThresholds = config.categories.security?.thresholds;
  if (secThresholds && typeof secThresholds === 'object') {
    for (const [id, entry] of Object.entries(secThresholds)) {
      if (!entry || typeof entry !== 'object') {
        delete secThresholds[id];
        continue;
      }
      // points weaker than -1 (closer to 0, zero, or positive) → reject
      const weakPoints = entry.points !== undefined && entry.points > -1;
      // max weaker than -1 (caps total security deduction near zero or flips
      // it into a bonus with a positive value) → reject
      const weakMax = entry.max !== undefined && entry.max > -1;
      // non-positive `per` (or a `per` large enough to swallow deductions is
      // still a real penalty per occurrence, so only guard the invalid case of
      // a per <= 0 which would break the floor/divide semantics) → reject
      const weakPer = entry.per !== undefined && (!(entry.per > 0));
      if (weakPoints || weakMax || weakPer) {
        delete secThresholds[id]; // reject the bypassing override entirely
      }
    }
  }

  return config;
}

/**
 * Validate suppress entries. Remove expired, reject invalid.
 * @param {Array} suppressEntries
 * @param {Date} now - current time for expiry checks
 * @returns {{ valid: Array, expired: Array, rejected: Array }}
 */
function validateSuppress(suppressEntries, now = new Date()) {
  const valid = [];
  const expired = [];
  const rejected = [];

  for (const entry of (suppressEntries || [])) {
    if (!entry || !entry.id) {
      rejected.push(entry);
      continue;
    }
    // Check expiry
    if (entry.expires) {
      const expiryDate = new Date(entry.expires);
      if (expiryDate < now) {
        expired.push(entry);
        continue;
      }
    }
    // Reject suppress on critical severity
    if (entry.severity === 'critical') {
      rejected.push(entry);
      continue;
    }
    valid.push(entry);
  }

  return { valid, expired, rejected };
}

/**
 * Merge threshold defaults with project overrides for a category.
 * @param {string} categoryName
 * @param {Array} defaults - from threshold-defaults.json
 * @param {Object} overrides - from project config { [thresholdId]: { points?, max?, per? } }
 * @returns {Array} merged thresholds
 */
function resolveThresholds(categoryName, defaults, overrides) {
  if (!defaults || !Array.isArray(defaults)) return [];
  if (!overrides || typeof overrides !== 'object') return [...defaults];

  return defaults.map(threshold => {
    const override = overrides[threshold.id];
    if (!override) return { ...threshold };
    return { ...threshold, ...override };
  });
}

module.exports = {
  deepMerge,
  mergeConfig,
  enforceSecurityFloors,
  validateSuppress,
  resolveThresholds,
};
