'use strict';

/**
 * threat-intel.cjs — AISLE Threat Intelligence Module
 *
 * Provides external data feeds for advanced scanners:
 *   - OSV.dev queries for vulnerability data (Scanner F)
 *   - IOC (Indicators of Compromise) refresh for egress monitoring (Scanner E)
 *   - Code pattern database refresh (Scanner B)
 *   - Staleness tracking with configurable TTLs
 *   - Concurrent session locking via proper-lockfile (ATK-8)
 *
 * All network calls are synchronous via spawnSync (P0-B compliance).
 * Timeout = use stale cache + mark degraded. Never fail-closed on
 * threat intel unavailability alone (spec Section 9.4).
 */

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OSV_API = 'https://api.osv.dev';
const OSV_BATCH_MAX = 1000;
const DEFAULT_TIMEOUT_MS = 5000;

const CACHE_DIR = path.resolve(__dirname, '../data/.cache');
const OSV_CACHE_FILE = path.join(CACHE_DIR, 'osv-cache.json');
const IOC_CACHE_FILE = path.join(CACHE_DIR, 'ioc-cache.json');
const PATTERN_CACHE_FILE = path.join(CACHE_DIR, 'pattern-cache.json');

const BUNDLED_IOCS_PATH = path.resolve(__dirname, '../data/egress-iocs.json');
const BUNDLED_PATTERNS_PATH = path.resolve(__dirname, '../data/code-patterns.json');

// Default TTLs in milliseconds
const DEFAULT_TTLS = {
  osv: 24 * 60 * 60 * 1000,        // 24 hours
  ioc: 7 * 24 * 60 * 60 * 1000,    // 7 days
  patterns: 7 * 24 * 60 * 60 * 1000, // 7 days
};

// Expired threshold: 7 days past TTL
const EXPIRED_MULTIPLIER = 7;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Ensure the cache directory exists.
 */
function ensureCacheDir() {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  } catch {
    // Ignore — may already exist or be read-only
  }
}

/**
 * Read and parse a JSON cache file. Returns null on any error.
 * @param {string} filePath
 * @returns {object|null}
 */
function readCache(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Write a JSON cache file atomically (write to .tmp then rename).
 * @param {string} filePath
 * @param {object} data
 */
function writeCache(filePath, data) {
  ensureCacheDir();
  const tmp = filePath + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, filePath);
  } catch {
    // Cleanup temp file on failure
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

/**
 * Perform a synchronous HTTP request via spawnSync.
 * Returns parsed JSON or null on failure/timeout.
 *
 * @param {string} url
 * @param {object} [options]
 * @param {string} [options.method='GET']
 * @param {object} [options.body]
 * @param {number} [options.timeout=5000]
 * @returns {object|null}
 */
function syncFetch(url, options = {}) {
  const { method = 'GET', body = null, timeout = DEFAULT_TIMEOUT_MS } = options;

  const fetchScript = `
    const http = require(process.env._FETCH_PROTO);
    const data = process.env._FETCH_BODY || null;
    const opts = new URL(process.env._FETCH_URL);
    const req = http.request(opts, { method: process.env._FETCH_METHOD, headers: { 'Content-Type': 'application/json' } }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => process.stdout.write(body));
    });
    req.on('error', () => process.exit(1));
    if (data) req.write(data);
    req.end();
  `;

  const result = childProcess.spawnSync(
    process.execPath,
    ['-e', fetchScript],
    {
      env: {
        ...process.env,
        _FETCH_URL: url,
        _FETCH_PROTO: url.startsWith('https') ? 'https' : 'http',
        _FETCH_METHOD: method,
        _FETCH_BODY: body ? JSON.stringify(body) : '',
      },
      timeout,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  );

  if (result.status !== 0 || result.error) {
    return null;
  }

  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Locking (ATK-8: concurrent session safety)
// ---------------------------------------------------------------------------

let lockfile;
try {
  lockfile = require('proper-lockfile');
} catch {
  lockfile = null;
}

/**
 * Acquire exclusive lock for cache updates.
 * Second session acquiring lock gets read-only access (ATK-8).
 *
 * @param {string} cacheFile - Path to the file to lock
 * @returns {{ locked: boolean, readOnly: boolean, release?: function }}
 */
function acquireLock(cacheFile) {
  if (!lockfile) {
    // No lockfile module — proceed without locking (degraded)
    return { locked: true, readOnly: false, release: () => {} };
  }

  // Ensure the file exists (proper-lockfile requires it)
  ensureCacheDir();
  if (!fs.existsSync(cacheFile)) {
    try { fs.writeFileSync(cacheFile, '{}', 'utf8'); } catch { /* ignore */ }
  }

  try {
    const release = lockfile.lockSync(cacheFile, {
      stale: 30000,  // 30s stale threshold
      retries: 0,    // Don't retry — fail fast for read-only fallback
    });
    return { locked: true, readOnly: false, release };
  } catch {
    // Lock held by another session — read-only access
    return { locked: false, readOnly: true };
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Query OSV.dev for vulnerabilities affecting one or more packages.
 * Synchronous via spawnSync. Auto-chunks at 1000 packages per batch.
 *
 * @param {string|string[]} packages - Package name(s) to query
 * @returns {object[]} Vulnerability records
 */
function queryOSV(packages) {
  const pkgList = Array.isArray(packages) ? packages : [packages];

  if (pkgList.length === 0) return [];

  // Check cache first
  const cache = readCache(OSV_CACHE_FILE);
  const cached = cache ? (cache.results || {}) : {};
  const now = Date.now();
  const ttl = DEFAULT_TTLS.osv;

  // Filter to uncached/stale packages
  const needsQuery = pkgList.filter(pkg => {
    const entry = cached[pkg];
    if (!entry) return true;
    return (now - (entry.timestamp || 0)) > ttl;
  });

  if (needsQuery.length === 0) {
    // All cached and fresh
    return pkgList.flatMap(pkg => (cached[pkg] || {}).vulns || []);
  }

  // P2-4 fix: acquire lock BEFORE network fetch and cache mutation.
  // Previously the lock was acquired after reading cache and fetching data,
  // creating a read-before-lock race: two concurrent callers could both read
  // stale data, both fetch, and the second write would silently overwrite the
  // first. Lock is now held for the entire fetch+update window. readOnly
  // callers fall back to stale data only (no mutation path).
  const lock = acquireLock(OSV_CACHE_FILE);
  if (lock.readOnly) {
    // Another session owns the lock — return stale cached results only
    return pkgList.flatMap(pkg => (cached[pkg] || {}).vulns || []);
  }

  // Re-read cache under lock to get the freshest view
  const lockedCache = readCache(OSV_CACHE_FILE);
  const freshCached = lockedCache ? (lockedCache.results || {}) : cached;

  // Re-filter: another session may have populated some packages while we waited
  const needsQueryLocked = pkgList.filter(pkg => {
    const entry = freshCached[pkg];
    if (!entry) return true;
    return (now - (entry.timestamp || 0)) > ttl;
  });

  if (needsQueryLocked.length === 0) {
    if (lock.release) lock.release();
    return pkgList.flatMap(pkg => (freshCached[pkg] || {}).vulns || []);
  }

  // Chunk into batches of OSV_BATCH_MAX
  const allVulns = [];
  for (let i = 0; i < needsQueryLocked.length; i += OSV_BATCH_MAX) {
    const chunk = needsQueryLocked.slice(i, i + OSV_BATCH_MAX);
    const queries = chunk.map(name => ({ package: { name, ecosystem: 'npm' } }));

    const response = syncFetch(`${OSV_API}/v1/querybatch`, {
      method: 'POST',
      body: { queries },
    });

    if (response && response.results) {
      for (let j = 0; j < response.results.length; j++) {
        const vulns = response.results[j].vulns || [];
        const pkg = chunk[j];
        freshCached[pkg] = { vulns, timestamp: now };
        allVulns.push(...vulns);
      }
    } else {
      // Network failed — use stale cache for these packages
      for (const pkg of chunk) {
        if (freshCached[pkg]) {
          allVulns.push(...(freshCached[pkg].vulns || []));
        }
      }
    }
  }

  writeCache(OSV_CACHE_FILE, { results: freshCached, lastUpdated: now });
  if (lock.release) lock.release();

  return allVulns;
}

/**
 * Refresh IOC (Indicators of Compromise) list.
 * Sources: bundled egress-iocs.json + optional remote updates.
 *
 * @returns {{ updated: boolean, count: number }}
 */
function refreshIOC() {
  let bundled = [];
  try {
    bundled = JSON.parse(fs.readFileSync(BUNDLED_IOCS_PATH, 'utf8'));
    if (!Array.isArray(bundled)) bundled = bundled.domains || bundled.iocs || [];
  } catch {
    bundled = [];
  }

  const lock = acquireLock(IOC_CACHE_FILE);
  if (lock.readOnly) {
    // Another session owns this — use existing cache
    const existing = readCache(IOC_CACHE_FILE);
    const count = existing ? (existing.iocs || []).length : bundled.length;
    return { updated: false, count };
  }

  const cache = readCache(IOC_CACHE_FILE) || { iocs: [], lastUpdated: 0 };
  const existingSet = new Set(cache.iocs);

  // Merge bundled IOCs
  let added = 0;
  for (const ioc of bundled) {
    const domain = typeof ioc === 'string' ? ioc : ioc.domain;
    if (domain && !existingSet.has(domain)) {
      existingSet.add(domain);
      added++;
    }
  }

  const merged = Array.from(existingSet);
  writeCache(IOC_CACHE_FILE, { iocs: merged, lastUpdated: Date.now() });
  if (lock.release) lock.release();

  return { updated: added > 0, count: merged.length };
}

/**
 * Refresh code pattern database.
 * Sources: bundled code-patterns.json.
 *
 * @returns {{ updated: boolean, count: number }}
 */
function refreshPatterns() {
  let bundled = [];
  try {
    bundled = JSON.parse(fs.readFileSync(BUNDLED_PATTERNS_PATH, 'utf8'));
    if (!Array.isArray(bundled)) bundled = bundled.patterns || [];
  } catch {
    bundled = [];
  }

  const lock = acquireLock(PATTERN_CACHE_FILE);
  if (lock.readOnly) {
    const existing = readCache(PATTERN_CACHE_FILE);
    const count = existing ? (existing.patterns || []).length : bundled.length;
    return { updated: false, count };
  }

  writeCache(PATTERN_CACHE_FILE, { patterns: bundled, lastUpdated: Date.now() });
  if (lock.release) lock.release();

  return { updated: true, count: bundled.length };
}

/**
 * Check staleness of all data sources against TTL config.
 * Freshness states: fresh | stale | expired
 * Expired (>7 days past TTL): degrade affected scanners.
 *
 * @param {object} [config] - TTL overrides { osv, ioc, patterns } in ms
 * @returns {{ osv: string, ioc: string, patterns: string }}
 */
function checkStaleness(config = {}) {
  const ttls = {
    osv: config.osv || DEFAULT_TTLS.osv,
    ioc: config.ioc || DEFAULT_TTLS.ioc,
    patterns: config.patterns || DEFAULT_TTLS.patterns,
  };

  const now = Date.now();

  function classify(cacheFile, ttl) {
    const cache = readCache(cacheFile);
    if (!cache || !cache.lastUpdated) return 'expired';

    const age = now - cache.lastUpdated;
    if (age <= ttl) return 'fresh';
    if (age <= ttl * EXPIRED_MULTIPLIER) return 'stale';
    return 'expired';
  }

  return {
    osv: classify(OSV_CACHE_FILE, ttls.osv),
    ioc: classify(IOC_CACHE_FILE, ttls.ioc),
    patterns: classify(PATTERN_CACHE_FILE, ttls.patterns),
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  queryOSV,
  refreshIOC,
  refreshPatterns,
  checkStaleness,
  acquireLock,

  // Exposed for testing
  _internals: {
    syncFetch,
    readCache,
    writeCache,
    ensureCacheDir,
    get lockfile() { return lockfile; },
    set lockfile(v) { lockfile = v; },
    CACHE_DIR,
    OSV_CACHE_FILE,
    IOC_CACHE_FILE,
    PATTERN_CACHE_FILE,
    DEFAULT_TTLS,
    EXPIRED_MULTIPLIER,
    OSV_BATCH_MAX,
  },
};
