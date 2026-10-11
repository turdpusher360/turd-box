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

/** Staleness window of .claude/hooks/check-agent-staleness.cjs, in days. */
const AGENT_STALE_DAYS = 14;
/** Bytes read from each agent file. The hook reads whole files; agent files run to ~10 KiB. */
const AGENT_READ_CAP = 64 * 1024;

/**
 * Read the first AGENT_READ_CAP bytes of a regular file as UTF-8. Returns null for
 * anything else (a directory, FIFO or device named *.md, or a read error), so no
 * entry in a scanned repo can block the scan.
 * @param {string} filePath
 * @returns {string|null}
 */
function readAgentHead(filePath) {
  let fd;
  try {
    if (!fs.statSync(filePath).isFile()) return null;
    // O_NONBLOCK and the fstat recheck cover a swap to a FIFO between stat and open.
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0));
    if (!fs.fstatSync(fd).isFile()) return null;
    const buf = Buffer.alloc(AGENT_READ_CAP);
    let n = 0;
    while (n < AGENT_READ_CAP) {
      const got = fs.readSync(fd, buf, n, AGENT_READ_CAP - n, n);
      if (got === 0) break;
      n += got;
    }
    return buf.toString('utf8', 0, n);
  } catch (_) {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (_) { /* already closed */ }
    }
  }
}

/**
 * agent-staleness has no autoresearch measure: its signal is the enforced
 * agent-staleness constraint-register check, .claude/hooks/check-agent-staleness.cjs.
 * The wizard scans repos it does not own, so it never runs or loads that hook. It
 * reads .claude/agents/*.md itself with the hook's rules: a line starting
 * `last-verified: YYYY-MM-DD` anywhere in the file, stale when more than 14 whole
 * days old, missing when there is no such line. It returns the share of agents
 * neither stale nor missing (0-100, for the map's score_invert type). The parity
 * test in __tests__/wizard-scan-autoresearch.test.js runs the real hook on the same
 * fixture to catch drift between the two.
 *
 * Only regular files are read, and only their first 64 KiB, so a FIFO, directory
 * or oversized file named *.md counts as missing instead of stalling the scan.
 *
 * Returns null (unmeasured) when the hook file is absent, as in a repo without
 * this rig's .claude/ tree (its presence marks a repo that follows the
 * last-verified convention; it is checked for, never run), or when .claude/agents
 * is absent, unreadable or holds no .md files.
 * @param {string} projectRoot
 * @param {Object} [opts]
 * @param {number} [opts.now] - current time in epoch ms (default Date.now()), for tests
 * @returns {number|null}
 */
function readAgentStaleness(projectRoot, opts = {}) {
  if (!fs.existsSync(path.join(projectRoot, '.claude', 'hooks', 'check-agent-staleness.cjs'))) return null;
  const agentsDir = path.join(projectRoot, '.claude', 'agents');
  let files;
  try {
    files = fs.readdirSync(agentsDir).filter(f => f.endsWith('.md'));
  } catch (_) {
    return null;
  }
  const total = files.length;
  if (total === 0) return null;

  const now = opts.now !== undefined ? Number(opts.now) : Date.now();
  let notFresh = 0;
  for (const file of files) {
    const content = readAgentHead(path.join(agentsDir, file));
    const match = content === null ? null : content.match(/^last-verified:\s*(\d{4}-\d{2}-\d{2})/m);
    if (!match) {
      notFresh++; // missing last-verified
      continue;
    }
    // The hook's own expression. An impossible date such as 2026-13-45 parses to
    // Invalid Date, gives NaN here and so counts as fresh, exactly as in the hook.
    const daysOld = Math.floor((now - new Date(match[1])) / (1000 * 60 * 60 * 24));
    if (daysOld > AGENT_STALE_DAYS) notFresh++;
  }
  return Math.round((100 * Math.max(0, total - notFresh)) / total);
}

/**
 * Domains read from a constraint-register check at scan time instead of from
 * experiments.jsonl. A domain-map entry opts in with "source": "register:<id>".
 */
const REGISTER_SOURCES = {
  'register:agent-staleness': readAgentStaleness,
};

/**
 * Record one domain's current metric as a signal or as findings.
 * @param {string} projectRoot
 * @param {string} domain
 * @param {Object} domainConfig - { category, thresholdId, type }
 * @param {number} metric
 * @param {boolean} isFresh
 * @param {Object} findings - mutated
 * @param {Array} signals - mutated
 */
function recordMetric(projectRoot, domain, domainConfig, metric, isFresh, findings, signals) {
  const { category, thresholdId, type } = domainConfig;

  if (type === 'signal_only') {
    // Load domain config for metric label
    const config = loadDomainConfig(projectRoot, domain);
    const label = (config && config.metric && config.metric.name) ? config.metric.name : domain;
    signals.push({ domain, metric, label, fresh: isFresh });
    return;
  }

  const count = translateMetric(type, metric);
  if (count === null) return;

  if (thresholdId === null) return; // no threshold to record against

  // Merge into findings[category][thresholdId]
  if (!findings[category]) {
    findings[category] = {};
  }
  findings[category][thresholdId] = (findings[category][thresholdId] || 0) + count;
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
    if (domainConfig.source) {
      const read = REGISTER_SOURCES[domainConfig.source];
      const metric = read ? read(projectRoot) : null;
      if (metric === null) continue; // unmeasured — skip, as for a domain with no data
      recordMetric(projectRoot, domain, domainConfig, metric, true, findings, signals);
      continue;
    }

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
    recordMetric(projectRoot, domain, domainConfig, metric, isFresh, findings, signals);
  }

  return { findings, signals, stale };
}

module.exports = { scanAutoresearch, readAgentStaleness };
