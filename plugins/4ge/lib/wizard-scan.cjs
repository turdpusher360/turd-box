'use strict';

const { readInbox } = require('./wizard-inbox-reader.cjs');
const { scanAutoresearch } = require('./wizard-scan-autoresearch.cjs');
const { scanAisle } = require('./wizard-scan-aisle.cjs');
const { scanOs } = require('./wizard-scan-os.cjs');
const { scoreCategory, computeOverall } = require('./wizard-scoring.cjs');
const { resolveThresholds } = require('./wizard-config.cjs');

const domainMap = require('./domain-threshold-map.json');

// Synthetic threshold injected into every category for inbox deductions
const INBOX_THRESHOLD = {
  id: 'inbox_open',
  points: -1,
  max: -4,
  description: 'Open /fix inbox item',
};

/**
 * Merge two findings objects for the same category.
 * Sums counts for the same thresholdId.
 * @param {Object} base - { [thresholdId]: number }
 * @param {Object} patch - { [thresholdId]: number }
 * @returns {Object}
 */
function mergeFindings(base, patch) {
  const result = { ...base };
  for (const [id, count] of Object.entries(patch)) {
    result[id] = (result[id] || 0) + count;
  }
  return result;
}

/**
 * Orchestrate all readers, merge findings, score every category, and return
 * a complete ScanResult.
 *
 * @param {string} projectRoot - absolute path to project root
 * @param {Object} config - merged wizard config (from wizard-config.cjs mergeConfig)
 * @param {Object} thresholdDefaults - contents of threshold-defaults.json
 * @returns {Object} ScanResult
 */
function scan(projectRoot, config, thresholdDefaults, opts = {}) {
  const warnings = [];

  // ------------------------------------------------------------------
  // 1. Read all data sources (each wrapped so one failure doesn't abort)
  // ------------------------------------------------------------------

  let inbox = { categories: {}, total: 0, entries: [] };
  try {
    inbox = readInbox(projectRoot);
  } catch (err) {
    warnings.push({ source: 'inbox', message: err.message });
  }

  let autoresearch = { findings: {}, signals: [], stale: [] };
  try {
    autoresearch = scanAutoresearch(projectRoot, domainMap, { staleDays: 7, maxStaleDays: 30 });
  } catch (err) {
    warnings.push({ source: 'autoresearch', message: err.message });
  }

  let aisle = { healthy: false, scanners: [], findings: { security: {} } };
  try {
    aisle = scanAisle(opts.aisleStateDir ? { stateDir: opts.aisleStateDir } : {});
  } catch (err) {
    warnings.push({ source: 'aisle', message: err.message });
  }

  let osData = null;
  try {
    osData = scanOs(projectRoot);
  } catch (err) {
    warnings.push({ source: 'os', message: err.message });
  }

  // ------------------------------------------------------------------
  // 2. Merge all findings per category
  // ------------------------------------------------------------------

  // Start with autoresearch findings (already grouped by category)
  const mergedFindings = {};
  for (const [category, categoryFindings] of Object.entries(autoresearch.findings)) {
    mergedFindings[category] = { ...categoryFindings };
  }

  // Merge AISLE security findings into the security category
  const aisleSecurityFindings = (aisle.findings && aisle.findings.security) || {};
  if (Object.keys(aisleSecurityFindings).length > 0) {
    mergedFindings.security = mergeFindings(mergedFindings.security || {}, aisleSecurityFindings);
  }

  // ------------------------------------------------------------------
  // 3. Inject inbox deductions as synthetic findings per category
  // ------------------------------------------------------------------

  for (const [category, count] of Object.entries(inbox.categories)) {
    if (!mergedFindings[category]) {
      mergedFindings[category] = {};
    }
    mergedFindings[category].inbox_open = (mergedFindings[category].inbox_open || 0) + count;
  }

  // ------------------------------------------------------------------
  // 4. Score each category defined in thresholdDefaults
  // ------------------------------------------------------------------

  const categoryResults = {};
  const categories = (thresholdDefaults && thresholdDefaults.categories) || {};

  for (const [categoryName, categoryDef] of Object.entries(categories)) {
    const defaultThresholds = Array.isArray(categoryDef.thresholds) ? categoryDef.thresholds : [];

    // Canonical override location is the DOCUMENTED path
    // `categories.<name>.thresholds.<id>` (config-schema.md:100,127). This is
    // the same path enforceSecurityFloors guards, so documented overrides take
    // effect AND the security floors are non-bypassable.
    const overrides =
      (config.categories &&
        config.categories[categoryName] &&
        config.categories[categoryName].thresholds) ||
      {};

    const categoryThresholds = resolveThresholds(categoryName, defaultThresholds, overrides);

    // Inject the synthetic inbox_open threshold
    categoryThresholds.push({ ...INBOX_THRESHOLD });

    const rawCategoryConfig = (config.categories && config.categories[categoryName]) || {};
    // Apply defaults first, then let project config override
    const categoryConfig = {
      weight: 1.0,
      enabled: true,
      ...rawCategoryConfig,
    };

    const findings = mergedFindings[categoryName] || {};
    categoryResults[categoryName] = scoreCategory(
      categoryName,
      findings,
      categoryThresholds,
      categoryConfig,
    );
  }

  // ------------------------------------------------------------------
  // 5. Compute overall score
  // ------------------------------------------------------------------

  const overall = computeOverall(categoryResults);

  // ------------------------------------------------------------------
  // 6. Return ScanResult
  // ------------------------------------------------------------------

  const result = {
    categories: categoryResults,
    overall,
    signals: autoresearch.signals,
    stale: autoresearch.stale,
    inbox: { total: inbox.total, categories: inbox.categories },
    os: osData,
    aisle: { healthy: aisle.healthy, scanners: aisle.scanners },
    meta: {
      scannedAt: new Date().toISOString(),
      staleDays: 7,
      dataSourcesRead: ['autoresearch', 'inbox', 'aisle', 'os'],
    },
  };

  if (warnings.length > 0) {
    result.meta.warnings = warnings;
  }

  return result;
}

module.exports = { scan };
