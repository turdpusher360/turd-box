'use strict';

/**
 * boot.cjs — AISLE Boot Sequence
 *
 * 8-step synchronous boot sequence that initializes the AISLE security
 * capability, verifies integrity, seeds scanner caches, and returns a
 * health/state report.
 *
 * Design invariants:
 *   - Fully synchronous — no async/await, no Promises
 *   - 30s total timeout: skip remaining steps, mark incomplete scanners degraded
 *   - ATK-2: config tiers NOT applied until Step 3 verification passes
 *   - T13 decoupling: absent pin-hooks manifest = warning, not fail-closed
 *   - Scanner D canary failure = global fail-closed (CRITICAL)
 *   - Any uncaught exception = fail-closed + CRITICAL event
 */

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');

// ---------------------------------------------------------------------------
// Module-level lazy dependency loading
// ---------------------------------------------------------------------------

let _config = null;
let _eventBus = null;
let _registry = null;
let _healthMonitor = null;

function loadDeps() {
  _config = require('./config.cjs');
  _eventBus = require('../scanners/event-bus.cjs');
  _registry = require('./scanner-registry.cjs');
  _healthMonitor = require('./health-monitor.cjs');
}

// ---------------------------------------------------------------------------
// Boot timeout
// ---------------------------------------------------------------------------

const BOOT_TIMEOUT_MS = 30000;

function elapsed(startTime) {
  return Math.max(0, Date.now() - startTime);
}

// ---------------------------------------------------------------------------
// File hashing utilities
// ---------------------------------------------------------------------------

/**
 * Directories to exclude from integrity hashing.
 *
 * .claude/worktrees — ephemeral agent isolation directories (full repo copies).
 * Including them causes O(2500+ file) traversal on every boot, blowing the
 * hook's 9s enforceTimeout budget. Worktree contents are not security-critical
 * integrity targets; they are transient working copies managed by the harness.
 * node_modules inside any hashed dir — transitive deps, not integrity targets.
 */
const HASH_EXCLUDE_DIRS = new Set([
  path.join(process.cwd(), '.claude', 'worktrees'),
]);

/**
 * Recursively collect all files under a directory, skipping excluded dirs.
 * Returns empty array if directory does not exist.
 *
 * @param {string} dir
 * @returns {string[]} absolute paths
 */
function collectFiles(dir) {
  const files = [];
  if (!fs.existsSync(dir)) return files;
  if (HASH_EXCLUDE_DIRS.has(dir)) return files; // skip excluded dirs
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (HASH_EXCLUDE_DIRS.has(fullPath)) continue; // skip nested excluded dirs
      files.push(...collectFiles(fullPath));
    } else {
      files.push(fullPath);
    }
  }
  return files;
}

/**
 * SHA-256 hash a single file's contents.
 * P1-8 fix: delegate to pin-hooks.cjs hashFile to avoid duplicate implementations
 * that can diverge independently. pin-hooks.cjs is the canonical source.
 *
 * @param {string} filePath
 * @returns {string} hex digest
 */
function hashFile(filePath) {
  // Delegate to pin-hooks.cjs canonical implementation
  return require('../../../scripts/pin-hooks.cjs').hashFile(filePath);
}

/**
 * Build a hash map for all files in the given directories.
 * Keys are relative paths from process.cwd() using forward slashes (cross-platform).
 * P0-6 fix: normalize separators to forward slash so keys match pin-hooks.cjs
 * format on Windows where path.relative() returns backslashes.
 *
 * @param {string[]} dirs - absolute directory paths
 * @returns {Object.<string, string>}
 */
function buildHashMap(dirs) {
  const cwd = process.cwd();
  const map = {};
  for (const dir of dirs) {
    for (const filePath of collectFiles(dir)) {
      try {
        // P0-6 fix: normalize to forward slashes so keys match on Windows
        const rel = path.relative(cwd, filePath).split(path.sep).join('/');
        map[rel] = hashFile(filePath);
      } catch (_err) {
        // unreadable file — skip
      }
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Agent contract parsing
// ---------------------------------------------------------------------------

/**
 * Parse YAML frontmatter from agent .md files.
 * Extracts everything between the first pair of `---` delimiters.
 *
 * @param {string} content - file content
 * @returns {Object.<string, string>} parsed key-value pairs (strings only)
 */
function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const frontmatter = match[1];
  const result = {};
  for (const line of frontmatter.split(/\r?\n/)) {
    const colonIdx = line.indexOf(':');
    if (colonIdx < 0) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (key) result[key] = value;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Intel cache refresh script
// ---------------------------------------------------------------------------

const INTEL_FETCH_SCRIPT = `
'use strict';
const fs = require('fs');
const path = require('path');
const stateDir = process.env.AISLE_STATE_DIR;
if (!stateDir) { process.exit(1); }
const cacheDir = path.join(stateDir, 'scanner-cache');
fs.mkdirSync(cacheDir, { recursive: true });
const intelPath = path.join(cacheDir, 'intel.json');
const intel = {
  refreshedAt: Date.now(),
  sources: [],
  indicators: []
};
fs.writeFileSync(intelPath, JSON.stringify(intel, null, 2));
process.exit(0);
`;

// ---------------------------------------------------------------------------
// getState(stateDir) — disk-based state inference
// ---------------------------------------------------------------------------

/**
 * Infer AISLE boot state from disk artifacts.
 * Called by hook subprocesses that cannot see in-memory state.
 *
 * @param {string} stateDir - Absolute path to AISLE state directory
 * @returns {'setup-required'|'initializing'|'operational'|'degraded'|'fail-closed'}
 */
function getState(stateDir) {
  const configPath = path.join(stateDir, 'aisle-config.json');
  if (!fs.existsSync(configPath)) return 'setup-required';

  // P2-8 fix: read the boot marker `state` field and honour non-operational states.
  // Previously getState() only checked file existence + cache dir presence, meaning
  // a boot that ended in 'fail-closed' or 'degraded' would appear 'operational'.
  // Fix: trust non-operational states from the marker immediately; for 'operational'
  // still verify the filesystem (cache dir must exist and have files) to catch
  // post-boot filesystem corruption. Unreadable/malformed markers fall through.
  let markerState = null;
  try {
    const marker = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (marker && typeof marker.state === 'string') {
      markerState = marker.state;
    }
  } catch {
    // Unreadable or non-JSON — fall through to filesystem inference
  }

  // If marker says degraded/fail-closed, trust it immediately
  if (markerState === 'degraded' || markerState === 'fail-closed') return markerState;

  // For 'operational' or unknown marker state, verify filesystem corroborates it
  const cacheDir = path.join(stateDir, 'scanner-cache');
  if (!fs.existsSync(cacheDir)) return 'degraded';

  const cacheFiles = fs.readdirSync(cacheDir).filter(f => f.endsWith('.json'));
  if (cacheFiles.length === 0) return 'degraded';

  return 'operational';
}

// ---------------------------------------------------------------------------
// boot(os, stateDir, sessionId)
// ---------------------------------------------------------------------------

/**
 * Run the 8-step AISLE boot sequence synchronously.
 *
 * @param {object} osContext   - OS context (unused directly; for future capability hooks)
 * @param {string} stateDir    - Absolute path to AISLE state directory (from config.resolveStateDir())
 * @param {string} sessionId   - Current Claude Code session ID
 * @returns {{ health: object, state: string, bootTimeMs: number }}
 */
function boot(osContext, stateDir, sessionId) {
  const startTime = Date.now();
  let bootState = 'operational';
  let pendingConfig = null;
  let pendingHash = null;
  let integrityVerified = false;
  let _appliedTiers = false;

  // Load upstream modules — validate CJS loadability (Step 1 check)
  const depsResult = checkDeps();
  if (!depsResult.ok) {
    return {
      health: {
        state: 'degraded',
        steps: { 'deps-check': 'deps-missing' },
        errors: depsResult.errors,
      },
      state: 'degraded',
      bootTimeMs: elapsed(startTime),
    };
  }

  loadDeps();

  const steps = {};
  const errors = [];
  const warnings = [];

  // -------------------------------------------------------------------------
  // CROSS-P1-G (upstream): Ensure stateDir subdirectories exist on every boot.
  //
  // The canonical list lives in config.STATE_SUBDIRS and is shared with
  // setupWizard() (first-boot path). Prior to upstream the mkdir loop only ran
  // during the first-boot wizard — on subsequent cold-starts the 5 scanner
  // subdirs (threat-intel, quarantine, quarantine/items, health, learning)
  // were silently missing, degrading Scanner C quarantine, Scanner E/F/I
  // threat-intel, and the learning loop. fs.mkdirSync({recursive: true}) is
  // idempotent so this is a no-op on already-initialized installs.
  //
  // Best-effort: a mkdir failure is a warning, not fail-closed — later steps
  // that actually need a specific subdir will still create it themselves.
  // -------------------------------------------------------------------------
  try {
    for (const subdir of _config.STATE_SUBDIRS) {
      fs.mkdirSync(path.join(stateDir, subdir), { recursive: true });
    }
  } catch (err) {
    warnings.push(`stateDir subdir ensure failed: ${err.message}`);
  }

  // Initialize event bus
  try {
    fs.mkdirSync(path.join(stateDir, 'events'), { recursive: true });
    _eventBus.init(stateDir, sessionId || 'boot', Date.now());
  } catch (err) {
    warnings.push(`event-bus init failed: ${err.message}`);
  }

  // Wrap entire boot in try/catch for uncaught exception -> fail-closed
  try {

    // -------------------------------------------------------------------------
    // Step 1: Dependency Check
    // -------------------------------------------------------------------------
    steps['deps-check'] = 'deps-ok';
    emitSafe({ type: 'BOOT_STEP', step: 1, result: 'deps-ok' });

    if (elapsed(startTime) > BOOT_TIMEOUT_MS) {
      bootState = 'degraded';
      warnings.push('boot timeout after Step 1');
      return buildResult(bootState, steps, errors, warnings, startTime, null);
    }

    // -------------------------------------------------------------------------
    // Step 2: Configuration (LOAD ONLY — do NOT apply tiers yet, ATK-2)
    // -------------------------------------------------------------------------
    let configResult;
    try {
      const projectId = _config.deriveProjectId();
      configResult = _config.loadConfig(projectId);
    } catch (err) {
      errors.push(`Step 2 config load failed: ${err.message}`);
      steps['config-load'] = 'config-load-failed';
      bootState = 'fail-closed';
      emitSafe({ type: 'BOOT_STEP', step: 2, result: 'config-load-failed', error: err.message });
      return buildResult(bootState, steps, errors, warnings, startTime, null);
    }

    if (configResult === null) {
      steps['config-load'] = 'setup-required';
      bootState = 'setup-required';
      emitSafe({ type: 'BOOT_STEP', step: 2, result: 'setup-required' });
      return buildResult(bootState, steps, errors, warnings, startTime, null);
    }

    // Validate config — fail-closed on invalid
    const validation = _config.validateConfig(configResult.config);
    if (!validation.valid) {
      errors.push(`Step 2 config invalid: ${validation.errors.join(', ')}`);
      steps['config-load'] = 'config-invalid';
      bootState = 'fail-closed';
      emitSafe({ type: 'BOOT_STEP', step: 2, result: 'config-invalid', errors: validation.errors });
      return buildResult(bootState, steps, errors, warnings, startTime, null);
    }

    // Store in pending — NOT applied yet (ATK-2)
    pendingConfig = configResult.config;
    pendingHash = configResult.hash;

    steps['config-load'] = 'config-loaded-pending';
    emitSafe({ type: 'BOOT_STEP', step: 2, result: 'config-loaded-pending' });

    if (elapsed(startTime) > BOOT_TIMEOUT_MS) {
      bootState = 'degraded';
      warnings.push('boot timeout after Step 2');
      return buildResult(bootState, steps, errors, warnings, startTime, pendingConfig);
    }

    // -------------------------------------------------------------------------
    // Step 3: File Integrity + Config Verification
    // -------------------------------------------------------------------------
    // P0-2 fix: use MANIFEST_PATH from pin-hooks.cjs (out-of-repo ~/.claude/projects/…)
    // boot.cjs was reading from scripts/hook-pins.json (in-repo) but pin-hooks.cjs
    // writes to ~/.claude/projects/<projectId>/hook-pins.json. Unified here.
    const pinHooks = require('../../../scripts/pin-hooks.cjs');
    const manifestPath = pinHooks.MANIFEST_PATH;
    const manifestExists = fs.existsSync(manifestPath);

    if (manifestExists) {
      // Verify AISLE files against pin-hooks manifest
      let manifest;
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      } catch (err) {
        errors.push(`Step 3 manifest read failed: ${err.message}`);
        steps['integrity'] = 'integrity-failed';
        bootState = 'fail-closed';
        emitSafe({ type: 'BOOT_STEP', step: 3, result: 'integrity-failed', error: err.message });
        return buildResult(bootState, steps, errors, warnings, startTime, null);
      }

      // P1-3 fix: verify HMAC signature before trusting manifest contents
      // pin-hooks.cjs stores signature at top level; manifest body = { ...manifest minus signature }
      // Pass stateDir so verifyManifest reads the correct per-project HMAC secret
      if (manifest.signature) {
        const { signature, ...manifestBody } = manifest;
        if (!pinHooks.verifyManifest(manifestBody, signature, stateDir)) {
          errors.push('Step 3 HMAC invalid — manifest may be tampered');
          steps['integrity'] = 'integrity-failed';
          bootState = 'fail-closed';
          emitSafe({ type: 'BOOT_STEP', step: 3, result: 'integrity-failed', reason: 'hmac-invalid' });
          return buildResult(bootState, steps, errors, warnings, startTime, null);
        }
      }

      // P0-1 fix: manifest wraps file hashes under manifest.files (not top-level)
      // pin-hooks.cjs writes { generated, generator, project, fileCount, files: {...}, signature }
      const filesToCheck = manifest.files || manifest;

      // Verify files listed in manifest against current hashes
      let mismatch = false;
      const mismatchFiles = [];
      for (const [filePath, expectedHash] of Object.entries(filesToCheck)) {
        const absPath = path.resolve(process.cwd(), filePath);
        if (!fs.existsSync(absPath)) {
          mismatch = true;
          mismatchFiles.push(`${filePath}: missing`);
          continue;
        }
        try {
          const actualHash = hashFile(absPath);
          if (actualHash !== expectedHash) {
            mismatch = true;
            mismatchFiles.push(`${filePath}: hash mismatch`);
          }
        } catch (_err) {
          mismatch = true;
          mismatchFiles.push(`${filePath}: read error`);
        }
      }

      if (mismatch) {
        errors.push(`Step 3 integrity mismatch: ${mismatchFiles.join('; ')}`);
        steps['integrity'] = 'integrity-failed';
        bootState = 'fail-closed';
        emitSafe({ type: 'BOOT_STEP', step: 3, result: 'integrity-failed', files: mismatchFiles });
        return buildResult(bootState, steps, errors, warnings, startTime, null);
      }

      integrityVerified = true;
    } else {
      // Manifest missing — T13 decoupling: warn, don't fail-closed
      warnings.push('hook-pins.json not found — skipping integrity verification');
      integrityVerified = false;
      emitSafe({ type: 'BOOT_STEP', step: 3, result: 'integrity-unverified', reason: 'manifest-missing' });
    }

    // Apply config tiers from pending state (ATK-2: only after Step 3)
    _appliedTiers = true;
    const activeConfig = pendingConfig;

    if (!integrityVerified) {
      // T13 decoupling: missing manifest is a warning, not a degraded state.
      // boot.cjs header and Step 3 comment both say "warn, don't fail-closed".
      // Degraded is stronger than a warning — removing this line aligns code
      // with stated design intent (FIND-004 fix).
      warnings.push('integrity-unverified: tiers applied without hook-pins manifest verification');
      steps['integrity'] = 'integrity-unverified';
    } else {
      steps['integrity'] = 'baseline-created';
    }

    // Hash files for baseline.
    // Skip rebuild when integrity was unverified (no manifest) and the existing
    // baseline is fresh (< 24h). Rehashing 400+ files costs ~1.5s per boot;
    // without a manifest there is nothing to compare against, so incremental
    // rebuilds on every cold boot add latency with no security benefit.
    // When a manifest is present, always rebuild so the baseline stays current.
    const baselinesDir = path.join(stateDir, 'baselines');
    const baselinePath = path.join(baselinesDir, 'file-hashes.json');
    const BASELINE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
    let skipBaseline = false;
    if (!integrityVerified && fs.existsSync(baselinePath)) {
      try {
        const stat = fs.statSync(baselinePath);
        if (Date.now() - stat.mtimeMs < BASELINE_TTL_MS) {
          skipBaseline = true;
          // Mark as skipped but not failed — still fine for manifest-less installs
          if (steps['integrity'] !== 'baseline-updated' && steps['integrity'] !== 'baseline-created') {
            steps['integrity'] = 'integrity-unverified'; // unchanged; just skip the rebuild
          }
        }
      } catch { /* stat failed — fall through to rebuild */ }
    }

    try {
      if (skipBaseline) {
        // Baseline is fresh and no manifest to verify against — skip the hash pass
        warnings.push('baseline rebuild skipped (fresh, no manifest)');
      } else {
      const cwd = process.cwd();
      const dirsToHash = [
        path.join(cwd, '.claude'),
        path.join(cwd, 'lib', 'os'),
        path.join(cwd, 'lib', 'aisle'),
        path.join(cwd, 'settings.json'),
      ].filter(d => {
        try { fs.statSync(d); return true; } catch { return false; }
      });

      const hashMap = buildHashMap(dirsToHash.filter(d => {
        try { return fs.statSync(d).isDirectory(); } catch { return false; }
      }));

      // Also hash settings.json if it's a file
      const settingsPath = path.join(cwd, 'settings.json');
      if (fs.existsSync(settingsPath)) {
        try {
          hashMap['settings.json'] = hashFile(settingsPath);
        } catch (_err) {
          // unreadable
        }
      }

      fs.mkdirSync(baselinesDir, { recursive: true });
      const baselineData = {
        createdAt: Date.now(),
        hashes: hashMap,
      };

      if (fs.existsSync(baselinePath)) {
        fs.writeFileSync(baselinePath, JSON.stringify(baselineData, null, 2));
        if (steps['integrity'] === 'baseline-created') steps['integrity'] = 'baseline-updated';
      } else {
        fs.writeFileSync(baselinePath, JSON.stringify(baselineData, null, 2));
      }
      } // end else (not skipBaseline)
    } catch (err) {
      warnings.push(`baseline write failed: ${err.message}`);
    }

    emitSafe({ type: 'BOOT_STEP', step: 3, result: steps['integrity'] });

    if (elapsed(startTime) > BOOT_TIMEOUT_MS) {
      bootState = 'degraded';
      warnings.push('boot timeout after Step 3');
      return buildResult(bootState, steps, errors, warnings, startTime, activeConfig);
    }

    // -------------------------------------------------------------------------
    // Step 4: Code Pattern Scan (synchronous)
    // -------------------------------------------------------------------------
    const scannerCacheDir = path.join(stateDir, 'scanner-cache');
    fs.mkdirSync(scannerCacheDir, { recursive: true });

    const scannerB = getScannerById('B');
    if (scannerB) {
      try {
        const result = scannerB.scan({ cadence: 'boot' });
        fs.writeFileSync(
          path.join(scannerCacheDir, 'B.json'),
          JSON.stringify(result, null, 2)
        );
        steps['scanner-B'] = 'scanned';
        emitSafe({ type: 'BOOT_STEP', step: 4, scanner: 'B', result: 'scanned' });
      } catch (err) {
        warnings.push(`Step 4 Scanner B failed: ${err.message}`);
        steps['scanner-B'] = 'scan-failed';
        if (bootState === 'operational') bootState = 'degraded';
        emitSafe({ type: 'BOOT_STEP', step: 4, scanner: 'B', result: 'scan-failed', error: err.message });
      }
    } else {
      warnings.push('Step 4: Scanner B not registered, skipping');
      steps['scanner-B'] = 'skipped';
      emitSafe({ type: 'BOOT_STEP', step: 4, scanner: 'B', result: 'skipped' });
    }

    // Step 4b: Scanner A supply-chain baseline (boot-time scan)
    // Note: Scanner A.scan() runs npm audit which can take up to 30s at boot.
    // This populates _cachedState.lockfilePackages so per-tool evaluate() works.
    // Timeout guard: boot total budget is 30s; skip gracefully if exceeded.
    const scannerA = getScannerById('A');
    if (scannerA) {
      try {
        const projectRoot = process.cwd();
        // Pass timeoutMs=5000 so npm audit fails fast to degraded (lockfile-only)
        // mode rather than consuming the hook's full 9s enforceTimeout budget.
        // REF-AISLE-002: Scanner A is WARN-only on timeout — no fail-closed risk.
        scannerA.scan({ cwd: projectRoot, timeoutMs: 5000 });
        steps['scanner-A'] = 'scanned';
        emitSafe({ type: 'BOOT_STEP', step: 4, scanner: 'A', result: 'scanned' });
      } catch (err) {
        warnings.push(`Step 4 Scanner A failed: ${err.message}`);
        steps['scanner-A'] = 'scan-failed';
        emitSafe({ type: 'BOOT_STEP', step: 4, scanner: 'A', result: 'scan-failed', error: err.message });
      }
    } else {
      warnings.push('Step 4: Scanner A not registered, skipping');
      steps['scanner-A'] = 'skipped';
      emitSafe({ type: 'BOOT_STEP', step: 4, scanner: 'A', result: 'skipped' });
    }

    if (elapsed(startTime) > BOOT_TIMEOUT_MS) {
      bootState = 'degraded';
      warnings.push('boot timeout after Step 4');
      return buildResult(bootState, steps, errors, warnings, startTime, activeConfig);
    }

    // -------------------------------------------------------------------------
    // Step 5: Agent Contract Audit (synchronous)
    // -------------------------------------------------------------------------
    try {
      const agentsDir = path.join(process.cwd(), '.claude', 'agents');
      const contracts = {};

      if (fs.existsSync(agentsDir)) {
        const agentFiles = fs.readdirSync(agentsDir).filter(f => f.endsWith('.md'));
        for (const agentFile of agentFiles) {
          try {
            const content = fs.readFileSync(path.join(agentsDir, agentFile), 'utf8');
            contracts[agentFile] = parseFrontmatter(content);
          } catch (_err) {
            // unreadable — skip
          }
        }
      }

      const baselinesDir = path.join(stateDir, 'baselines');
      fs.mkdirSync(baselinesDir, { recursive: true });
      fs.writeFileSync(
        path.join(baselinesDir, 'agent-contracts.json'),
        JSON.stringify({ createdAt: Date.now(), contracts }, null, 2)
      );
      steps['agent-contracts'] = 'stored';
    } catch (err) {
      warnings.push(`Step 5 agent contracts failed: ${err.message}`);
      steps['agent-contracts'] = 'failed';
    }

    const scannerC = getScannerById('C');
    if (scannerC) {
      try {
        const result = scannerC.scan({ cadence: 'boot' });
        fs.writeFileSync(
          path.join(scannerCacheDir, 'C.json'),
          JSON.stringify(result, null, 2)
        );
        steps['scanner-C'] = 'scanned';
        emitSafe({ type: 'BOOT_STEP', step: 5, scanner: 'C', result: 'scanned' });
      } catch (err) {
        warnings.push(`Step 5 Scanner C failed: ${err.message}`);
        steps['scanner-C'] = 'scan-failed';
        if (bootState === 'operational') bootState = 'degraded';
        emitSafe({ type: 'BOOT_STEP', step: 5, scanner: 'C', result: 'scan-failed', error: err.message });
      }
    } else {
      steps['scanner-C'] = 'skipped';
      emitSafe({ type: 'BOOT_STEP', step: 5, scanner: 'C', result: 'skipped' });
    }

    if (elapsed(startTime) > BOOT_TIMEOUT_MS) {
      bootState = 'degraded';
      warnings.push('boot timeout after Step 5');
      return buildResult(bootState, steps, errors, warnings, startTime, activeConfig);
    }

    // -------------------------------------------------------------------------
    // Step 6: Egress Surface Map (synchronous)
    // -------------------------------------------------------------------------
    const scannerE = getScannerById('E');
    if (scannerE) {
      try {
        const result = scannerE.scan({ cadence: 'boot' });
        fs.writeFileSync(
          path.join(scannerCacheDir, 'E.json'),
          JSON.stringify(result, null, 2)
        );
        steps['scanner-E'] = 'scanned';
        emitSafe({ type: 'BOOT_STEP', step: 6, scanner: 'E', result: 'scanned' });
      } catch (err) {
        warnings.push(`Step 6 Scanner E failed: ${err.message}`);
        steps['scanner-E'] = 'scan-failed';
        if (bootState === 'operational') bootState = 'degraded';
        emitSafe({ type: 'BOOT_STEP', step: 6, scanner: 'E', result: 'scan-failed', error: err.message });
      }
    } else {
      warnings.push('Step 6: Scanner E not registered, skipping');
      steps['scanner-E'] = 'skipped';
      emitSafe({ type: 'BOOT_STEP', step: 6, scanner: 'E', result: 'skipped' });
    }

    if (elapsed(startTime) > BOOT_TIMEOUT_MS) {
      bootState = 'degraded';
      warnings.push('boot timeout after Step 6');
      return buildResult(bootState, steps, errors, warnings, startTime, activeConfig);
    }

    // -------------------------------------------------------------------------
    // Step 7: Threat Intel Cache (synchronous)
    // -------------------------------------------------------------------------
    const intelCachePath = path.join(scannerCacheDir, 'intel.json');
    const INTEL_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

    let intelFresh = false;
    if (fs.existsSync(intelCachePath)) {
      try {
        const stat = fs.statSync(intelCachePath);
        const ageMs = Date.now() - stat.mtimeMs;
        intelFresh = ageMs < INTEL_TTL_MS;
      } catch (_err) {
        intelFresh = false;
      }
    }

    if (intelFresh) {
      steps['intel-cache'] = 'cache-fresh';
      emitSafe({ type: 'BOOT_STEP', step: 7, result: 'cache-fresh' });
    } else {
      // Refresh via spawnSync with 5s timeout
      // P1-6 fix: use process.execPath instead of bare 'node' — PATH may not include
      // Node.js on Windows. Also add stdio: 'pipe' to capture output properly.
      try {
        const spawnResult = childProcess.spawnSync(
          process.execPath,
          ['-e', INTEL_FETCH_SCRIPT],
          {
            timeout: 5000,
            stdio: 'pipe',
            env: Object.assign({}, process.env, { AISLE_STATE_DIR: stateDir }),
          }
        );

        if (spawnResult.status === 0 && !spawnResult.error) {
          steps['intel-cache'] = 'cache-refreshed';
          emitSafe({ type: 'BOOT_STEP', step: 7, result: 'cache-refreshed' });
        } else {
          // Timeout or error — use stale cache if it exists, else empty
          const reason = spawnResult.error
            ? spawnResult.error.message
            : `exit code ${spawnResult.status}`;
          warnings.push(`Step 7 intel refresh failed: ${reason}`);

          if (!fs.existsSync(intelCachePath)) {
            // Write empty intel cache
            fs.writeFileSync(
              intelCachePath,
              JSON.stringify({ refreshedAt: null, sources: [], indicators: [], unavailable: true }, null, 2)
            );
          }
          steps['intel-cache'] = 'intel-unavailable';
          if (bootState === 'operational') bootState = 'degraded';
          emitSafe({ type: 'BOOT_STEP', step: 7, result: 'intel-unavailable', reason });
        }
      } catch (err) {
        warnings.push(`Step 7 intel refresh error: ${err.message}`);
        steps['intel-cache'] = 'intel-unavailable';
        if (bootState === 'operational') bootState = 'degraded';
        emitSafe({ type: 'BOOT_STEP', step: 7, result: 'intel-unavailable', error: err.message });
      }
    }

    if (elapsed(startTime) > BOOT_TIMEOUT_MS) {
      bootState = 'degraded';
      warnings.push('boot timeout after Step 7');
      return buildResult(bootState, steps, errors, warnings, startTime, activeConfig);
    }

    // -------------------------------------------------------------------------
    // Step 8: Canary Self-Test
    // -------------------------------------------------------------------------
    let canaryResults = {};
    let allCanariesPass = true;
    let scannerDFailed = false;

    try {
      const canaryReport = _healthMonitor.runCanaries(_registry);
      canaryResults = canaryReport.results;
      allCanariesPass = canaryReport.allPass;

      // Check if Scanner D failed
      if (canaryResults['D'] === 'fail') {
        scannerDFailed = true;
        bootState = 'fail-closed';
        errors.push('Step 8: Scanner D canary failed — global fail-closed');
        emitSafe({ type: 'BOOT_STEP', step: 8, result: 'fail-closed', reason: 'scanner-D-canary-fail' });
      } else if (!allCanariesPass) {
        if (bootState === 'operational') bootState = 'degraded';
        emitSafe({ type: 'BOOT_STEP', step: 8, result: 'degraded', canaries: canaryResults });
      } else {
        emitSafe({ type: 'BOOT_STEP', step: 8, result: 'pass', canaries: canaryResults });
      }
    } catch (err) {
      warnings.push(`Step 8 canary run failed: ${err.message}`);
      steps['canaries'] = 'canary-error';
      if (bootState === 'operational') bootState = 'degraded';
      emitSafe({ type: 'BOOT_STEP', step: 8, result: 'canary-error', error: err.message });
    }

    // P0-4 fix: guard the assignment so 'canary-error' set in catch block is not overwritten
    // Previously this line ran unconditionally, overwriting the catch-set 'canary-error' value
    if (steps['canaries'] !== 'canary-error') {
      steps['canaries'] = scannerDFailed ? 'fail-closed' : (allCanariesPass ? 'pass' : 'degraded');
    }

    // Fix 1 (P1): Reset fail-closed flag ONLY after all canaries pass.
    // Moved from boot preamble — premature reset wiped the flag before Step 3
    // integrity checks ran, meaning a hard early failure left bootState='fail-closed'
    // but the registry flag was already cleared. Now: only clear if canaries
    // confirm the gate is actually healthy.
    if (allCanariesPass && !scannerDFailed) {
      try {
        if (typeof _registry._resetFailClosed === 'function') {
          _registry._resetFailClosed();
        }
      } catch (_err) {
        // non-fatal if registry doesn't support this method
      }
    }

    // Write scanner caches for passing canaries
    if (!scannerDFailed) {
      for (const scanner of _registry.getAll()) {
        if (canaryResults[scanner.id] === 'pass') {
          const cacheFile = path.join(scannerCacheDir, `${scanner.id}.json`);
          // Only write if not already written by earlier steps
          if (!fs.existsSync(cacheFile)) {
            try {
              fs.writeFileSync(
                cacheFile,
                JSON.stringify({ scannerId: scanner.id, canaryPass: true, timestamp: Date.now() }, null, 2)
              );
            } catch (_err) {
              // non-fatal
            }
          }
        }
      }
    }

    // Final posture from health monitor
    const posture = _healthMonitor.getPosture(_registry, activeConfig);

    if (bootState === 'operational' && posture.overall === 'critical') {
      bootState = 'fail-closed';
    } else if (bootState === 'operational' && posture.overall === 'degraded') {
      bootState = 'degraded';
    }

    // Write aisle-config.json marker to stateDir (for getState())
    try {
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, 'aisle-config.json'),
        JSON.stringify({ bootedAt: Date.now(), state: bootState, configHash: pendingHash }, null, 2)
      );
    } catch (err) {
      warnings.push(`state marker write failed: ${err.message}`);
    }

    emitSafe({ type: 'BOOT_COMPLETE', state: bootState, bootTimeMs: elapsed(startTime) });

    return buildResult(bootState, steps, errors, warnings, startTime, activeConfig, canaryResults, posture);

  } catch (uncaught) {
    // Uncaught exception — fail-closed
    errors.push(`Uncaught exception: ${uncaught.message}`);
    bootState = 'fail-closed';
    try {
      emitSafe({ type: 'BOOT_CRITICAL', error: uncaught.message });
    } catch (_err) {
      // event bus itself failed
    }
    return buildResult(bootState, steps, errors, warnings, startTime, null);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Safely emit an event without throwing.
 */
function emitSafe(event) {
  try {
    if (_eventBus) _eventBus.emit(event);
  } catch (_err) {
    // non-fatal
  }
}

/**
 * Look up a scanner by ID from the registry.
 * Returns null if registry not loaded or scanner not registered.
 *
 * @param {string} id
 * @returns {object|null}
 */
function getScannerById(id) {
  if (!_registry) return null;
  try {
    return _registry.getAll().find(s => s.id === id) || null;
  } catch (_err) {
    return null;
  }
}

/**
 * Build the standard boot result object.
 */
function buildResult(state, steps, errors, warnings, startTime, config, canaryResults, posture) {
  return {
    health: {
      state,
      steps,
      errors,
      warnings,
      canaries: canaryResults || {},
      posture: posture || null,
      configHash: null, // populated by caller if needed
    },
    state,
    bootTimeMs: elapsed(startTime),
  };
}

/**
 * Step 1 dependency check — verify CJS modules loadable and Node.js >= 18.
 *
 * @returns {{ ok: boolean, errors: string[] }}
 */
function checkDeps() {
  const errors = [];

  // Check Node.js version >= 18
  const major = parseInt(process.version.replace('v', '').split('.')[0], 10);
  if (major < 18) {
    errors.push(`Node.js >= 18 required, got ${process.version}`);
  }

  // Verify required CJS modules are loadable
  const modulePaths = [
    { name: 'config.cjs', path: path.join(__dirname, 'config.cjs') },
    { name: 'event-bus.cjs', path: path.join(__dirname, '..', 'scanners', 'event-bus.cjs') },
    { name: 'scanner-registry.cjs', path: path.join(__dirname, 'scanner-registry.cjs') },
  ];

  for (const mod of modulePaths) {
    try {
      require(mod.path);
    } catch (err) {
      errors.push(`${mod.name} not loadable: ${err.message}`);
    }
  }

  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { boot, getState };
