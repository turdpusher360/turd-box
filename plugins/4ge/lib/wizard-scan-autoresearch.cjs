'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Extract the current metric value from a kept/baseline JSONL entry.
 * Kept entries may carry metric_after (the post-improvement value).
 * Baseline entries always carry metric directly.
 * @param {Object} entry
 * @returns {number|null}
 */
function extractMetric(entry) {
  if (entry.metric_after !== undefined && entry.metric_after !== null) {
    return entry.metric_after;
  }
  if (entry.metric !== undefined && entry.metric !== null) {
    return entry.metric;
  }
  return null;
}

/**
 * Translate a raw metric value to a finding count based on translation type.
 * @param {string} type - "count" | "score_invert" | "boolean" | "signal_only"
 * @param {number} metric
 * @returns {number|null} null means signal_only (no finding)
 */
function translateMetric(type, metric) {
  // Defense-in-depth: AR measures may emit negative sentinels ({metric:-1, skip|error})
  // per the contract SDK. The harness filters these to status:error before JSONL write,
  // so they should not reach this function. If one does (malformed entry, historical
  // data, future measure bypass), treat as "unable to measure" → null (no finding).
  if (typeof metric !== 'number' || !Number.isFinite(metric) || metric < 0) {
    return null;
  }
  switch (type) {
    case 'count':
      return metric;
    case 'score_invert':
      return Math.ceil(Math.max(0, 100 - metric) / 20);
    case 'boolean':
      return metric > 0 ? 1 : 0;
    case 'signal_only':
      return null;
    default:
      return null;
  }
}

/**
 * Load a domain config file from scripts/autoresearch/domains/<domain>.json.
 * Returns null if the file is missing or unparseable.
 * @param {string} projectRoot
 * @param {string} domain
 * @returns {Object|null}
 */
function loadDomainConfig(projectRoot, domain) {
  const configPath = path.join(projectRoot, 'scripts', 'autoresearch', 'domains', `${domain}.json`);
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

/**
 * Read and parse experiments.jsonl for a domain. Returns parsed entries.
 * Returns null if the file is missing.
 * @param {string} projectRoot
 * @param {string} domain
 * @returns {Object[]|null}
 */
function readExperiments(projectRoot, domain) {
  const filePath = path.join(projectRoot, '_runs', 'autoresearch', domain, 'experiments.jsonl');
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (_) {
    return null; // file missing — skip domain
  }

  const entries = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch (_) {
      // skip malformed lines
    }
  }
  return entries;
}

/**
 * Scan autoresearch experiment data for all domains in the domain map.
 *
 * @param {string} projectRoot - absolute path to project root
 * @param {Object} domainMap - domain name -> { category, thresholdId, type }
 * @param {Object} [opts]
 * @param {number} [opts.staleDays=7] - age (days) at which data is considered stale
 * @param {number} [opts.maxStaleDays=30] - age (days) beyond which data is excluded entirely
 * @returns {{ findings: Object, signals: Array, stale: string[] }}
 */
function scanAutoresearch(projectRoot, domainMap, opts = {}) {
  const staleDays = typeof opts.staleDays === 'number' ? opts.staleDays : 7;
  const maxStaleDays = typeof opts.maxStaleDays === 'number' ? opts.maxStaleDays : 30;
  const now = Date.now();

  const findings = {};
  const signals = [];
  const stale = [];

  for (const [domain, domainConfig] of Object.entries(domainMap)) {
    const entries = readExperiments(projectRoot, domain);
    if (entries === null) continue; // file missing — skip

    if (entries.length === 0) continue; // empty file — skip

    // Find the last entry with status "kept" or "baseline"
    let currentEntry = null;
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.status === 'kept' || e.status === 'baseline') {
        currentEntry = e;
        break;
      }
    }

    if (!currentEntry) continue; // no valid entry found

    const metric = extractMetric(currentEntry);
    if (metric === null) continue; // entry has no usable metric

    // Compute age in days
    const ageInDays = (now - Date.parse(currentEntry.timestamp)) / 86400000;

    // Staleness checks
    if (ageInDays > maxStaleDays) {
      stale.push(domain);
      continue; // exclude from results
    }

    if (ageInDays > staleDays) {
      stale.push(domain);
      // still include in results below (just marked stale)
    }

    const isFresh = ageInDays <= staleDays;
    const { category, thresholdId, type } = domainConfig;

    if (type === 'signal_only') {
      // Load domain config for metric label
      const config = loadDomainConfig(projectRoot, domain);
      const label = (config && config.metric && config.metric.name) ? config.metric.name : domain;
      signals.push({ domain, metric, label, fresh: isFresh });
      continue;
    }

    const count = translateMetric(type, metric);
    if (count === null) continue;

    if (thresholdId === null) continue; // no threshold to record against

    // Merge into findings[category][thresholdId]
    if (!findings[category]) {
      findings[category] = {};
    }
    findings[category][thresholdId] = (findings[category][thresholdId] || 0) + count;
  }

  return { findings, signals, stale };
}

module.exports = { scanAutoresearch };
