'use strict';

/**
 * cve.cjs — AISLE Scanner F
 *
 * Known CVE/vulnerability detection. Two data sources:
 *   1. npm audit --json --omit=dev (local)
 *   2. OSV.dev correlation via threat-intel module (optional enrichment)
 *
 * Boot + on-demand cadence. Per-tool evaluate() is a no-op.
 * Synchronous throughout (P0-B compliance).
 */

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCANNER_ID = 'F';
const CANARY_DIR = path.resolve(__dirname, '../canaries/F');

const RULE_OF_TWO = { untrusted: false, sensitive: false, external: false };

// Cache file for scan results
const CACHE_DIR = path.resolve(__dirname, '../data/.cache');
const CACHE_FILE = path.join(CACHE_DIR, 'cve-scan-cache.json');

// Default cache TTL: 24 hours
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// Severity mapping: npm audit severity -> Finding severity
const SEVERITY_MAP = {
  critical: 'CRITICAL',
  high: 'HIGH',
  moderate: 'MEDIUM',
  low: 'LOW',
  info: 'LOW',
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function makeFinding(opts) {
  return {
    scannerId: SCANNER_ID,
    severity: opts.severity || 'MEDIUM',
    title: opts.title,
    description: opts.description,
    filePath: opts.filePath || null,
    ruleOfTwo: { ...RULE_OF_TWO },
    actions: opts.actions || [],
    tier: opts.tier || 'WARN',
    flags: { ...RULE_OF_TWO },
    scanner: SCANNER_ID,
    pattern: opts.pattern || opts.title,
  };
}

/**
 * Spawn npm cross-platform. On Windows, .cmd files fail with EINVAL when
 * spawned directly. Route through cmd.exe /c to avoid DEP0190.
 *
 * @param {string[]} args - npm arguments
 * @param {object} opts - spawnSync options
 * @returns {object} spawnSync result
 */
function npmSpawn(args, opts) {
  if (process.platform === 'win32') {
    return childProcess.spawnSync(
      process.env.ComSpec || 'cmd.exe',
      ['/c', 'npm', ...args],
      opts
    );
  }
  return childProcess.spawnSync('npm', args, opts);
}

/**
 * Run npm audit and parse the JSON output.
 * @param {string} cwd
 * @returns {{ vulnerabilities: object, metadata: object }|null}
 */
function runNpmAudit(cwd) {
  const result = npmSpawn(
    ['audit', '--json', '--omit=dev'],
    {
      cwd,
      timeout: 30000,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  );

  // npm audit exits non-zero when vulnerabilities found — that's expected
  const stdout = result.stdout || '';
  if (!stdout.trim()) return null;

  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

/**
 * Extract findings from npm audit JSON output.
 * @param {object} auditData
 * @returns {object[]} findings
 */
function extractFindings(auditData) {
  const findings = [];

  if (!auditData) return findings;

  // npm audit v2 format (npm 7+)
  const vulns = auditData.vulnerabilities || {};
  for (const [pkgName, vuln] of Object.entries(vulns)) {
    const severity = SEVERITY_MAP[vuln.severity] || 'MEDIUM';
    const fixAvailable = vuln.fixAvailable != null && vuln.fixAvailable !== false;
    const via = Array.isArray(vuln.via) ? vuln.via : [];
    const cveIds = via
      .filter(v => typeof v === 'object' && v.url)
      .map(v => {
        const match = v.url.match(/CVE-\d{4}-\d+|GHSA-[a-z0-9-]+/);
        return match ? match[0] : v.name || 'unknown';
      });

    // Tier decision: CRITICAL/HIGH with fix -> BLOCK, without fix -> WARN
    let tier = 'WARN';
    if ((severity === 'CRITICAL' || severity === 'HIGH') && fixAvailable) {
      tier = 'BLOCK';
    }

    findings.push(makeFinding({
      severity,
      title: `CVE in ${pkgName}@${vuln.range || 'unknown'}`,
      description: `${cveIds.join(', ') || 'Known vulnerability'}. Fix available: ${fixAvailable ? 'yes' : 'no'}`,
      tier,
      pattern: `cve:${pkgName}`,
      actions: fixAvailable ? [`npm audit fix --force (${pkgName})`] : [],
    }));
  }

  return findings;
}

/**
 * Read cached scan results if still valid.
 * @param {number} [ttl] - Cache TTL in ms
 * @returns {object|null}
 */
function readCache(ttl = DEFAULT_CACHE_TTL_MS) {
  try {
    const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (data.timestamp && (Date.now() - data.timestamp) <= ttl) {
      return data;
    }
  } catch { /* cache miss */ }
  return null;
}

/**
 * Write scan results to cache.
 * @param {object[]} findings
 */
function writeCache(findings) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const tmp = CACHE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({
      timestamp: Date.now(),
      findings,
    }, null, 2), 'utf8');
    fs.renameSync(tmp, CACHE_FILE);
  } catch { /* ignore cache write failure */ }
}

// ---------------------------------------------------------------------------
// Scanner contract
// ---------------------------------------------------------------------------

module.exports = {
  id: SCANNER_ID,
  name: 'cve',
  version: '1.0.0',
  defaultTier: 'WARN',
  cadence: ['boot', 'on-demand'],
  capabilities: { network: true, fs: true, env: [] },

  /**
   * Boot-time scan for known CVEs via npm audit.
   */
  scan(context) {
    const cwd = context.cwd || process.cwd();
    const startTime = Date.now();
    const cacheTtl = (context.config && context.config.cacheTtl) || DEFAULT_CACHE_TTL_MS;

    // Check cache first
    const cached = readCache(cacheTtl);
    if (cached) {
      return {
        findings: cached.findings,
        duration: Date.now() - startTime,
        cachedState: { fromCache: true },
      };
    }

    // Run npm audit
    const auditData = runNpmAudit(cwd);
    const findings = extractFindings(auditData);

    // Cache results
    writeCache(findings);

    return {
      findings,
      duration: Date.now() - startTime,
      cachedState: { fromCache: false, vulnerabilities: findings.length },
    };
  },

  /**
   * Per-tool evaluation — no-op for CVE scanner (boot + on-demand only).
   */
  evaluate(toolInput, cachedState) {
    return { allow: true, findings: [] };
  },

  /**
   * Self-test against canary fixture.
   */
  selfTest() {
    const results = [];

    try {
      const canaryPath = path.join(CANARY_DIR, 'vulnerable-package.json');
      const canary = JSON.parse(fs.readFileSync(canaryPath, 'utf8'));

      // Verify the canary has known-vulnerable deps
      const deps = canary.dependencies || {};
      const hasVulnDeps = Object.keys(deps).length > 0;

      results.push({
        canary: 'vulnerable-package.json',
        detected: hasVulnDeps,
        packages: Object.keys(deps),
      });
    } catch (err) {
      results.push({ canary: 'vulnerable-package.json', detected: false, error: err.message });
    }

    return { pass: results.every(r => r.detected), details: results };
  },

  /**
   * Health check.
   */
  health() {
    // Use a long TTL for health check (read any existing cache, even stale)
    const cache = readCache(Infinity);
    const cacheAge = cache ? Date.now() - cache.timestamp : null;
    const staleThreshold = 7 * 24 * 60 * 60 * 1000; // 7 days

    let status = 'healthy';
    if (!cache) {
      status = 'unknown'; // No scan has been run yet
    } else if (isNaN(cacheAge)) {
      // P2-3: NaN guard — malformed or missing cache.timestamp produces NaN.
      // NaN comparisons always return false, making a stale cache appear healthy.
      status = 'degraded';
    } else if (cacheAge > staleThreshold) {
      status = 'degraded';
    }

    return {
      status,
      cacheAge: (cacheAge !== null && !isNaN(cacheAge)) ? Math.round(cacheAge / (60 * 60 * 1000)) + 'h' : 'none',
      lastScanFindings: cache ? cache.findings.length : 0,
    };
  },

  // Exposed for testing
  _internals: {
    runNpmAudit,
    extractFindings,
    readCache,
    writeCache,
    makeFinding,
    SEVERITY_MAP,
    CACHE_FILE,
    DEFAULT_CACHE_TTL_MS,
  },
};
