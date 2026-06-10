'use strict';

/**
 * AISLE Config Module
 *
 * Handles config load/save, path resolution, schema validation, and integrity
 * hashing for the AISLE security capability.
 *
 * All path resolution uses HOME_DIR + path.join() — never tilde expansion,
 * with HOME_DIR selected from safe candidates when os.homedir is unavailable.
 *
 * Config is loaded at boot Step 2 but tiers are NOT applied until Step 3
 * verification passes (ATK-2). The loadConfig() return value includes a `hash`
 * field for that verification.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

function getSafeHomeDir() {
  const candidates = [
    process.env.CLAUDE_HOME,
    process.env.HOME,
    os.homedir(),
    os.tmpdir(),
  ];

  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate.trim().length === 0) {
      continue;
    }
    const normalized = path.resolve(candidate);
    try {
      fs.mkdirSync(path.join(normalized, '.claude'), { recursive: true });
      return normalized;
    } catch (err) {
      if (['EACCES', 'EROFS', 'EEXIST'].includes(err.code)) {
        return normalized;
      }
      continue;
    }
  }

  const fallback = path.join(os.tmpdir(), '.claude-home-fallback');
  fs.mkdirSync(path.join(fallback, '.claude'), { recursive: true });
  return fallback;
}

const HOME_DIR = getSafeHomeDir();

// ---------------------------------------------------------------------------
// Internal schema — lightweight validator, no npm deps
// ---------------------------------------------------------------------------

const VALID_TIERS = new Set(['BLOCK', 'WARN', 'LOG']);
const REQUIRED_TIER_KEYS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'];
const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;

// ---------------------------------------------------------------------------
// Canonical list of AISLE stateDir subdirectories
// ---------------------------------------------------------------------------
//
// CROSS-P1-G (upstream): This list is the single source of truth for the
// directories AISLE expects to find under stateDir. Both setupWizard() (first
// boot) and boot() (every cold-start) reference it so they cannot drift.
//
// Prior to upstream the list lived only inside setupWizard(), which runs once at
// first boot. On every subsequent cold-start the 5 scanner subdirs
// (threat-intel, quarantine, quarantine/items, health, learning) were never
// recreated if they had been deleted or were missing from an old install,
// silently degrading Scanner C quarantine, Scanner E/F/I threat-intel, and
// the learning loop. boot.cjs now ensures all 8 subdirs exist on every boot
// via an idempotent mkdir loop keyed off this constant.
const STATE_SUBDIRS = Object.freeze([
  'events',
  'scanner-cache',
  'threat-intel',
  'quarantine',
  'quarantine/items',
  'health',
  'learning',
  'baselines',
]);

let _derivedProjectId = null;

/**
 * Validate a config object against the AISLE schema.
 * Lightweight inline validator — no npm dependency.
 *
 * @param {object} config
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateConfig(config) {
  const errors = [];

  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    errors.push('config must be a non-null object');
    return { valid: false, errors };
  }

  // --- Required: version ---
  if (!('version' in config)) {
    errors.push('missing required field: version');
  } else if (typeof config.version !== 'string' || !SEMVER_PATTERN.test(config.version)) {
    errors.push(`version must be a semver string (e.g., "1.0.0"), got: ${JSON.stringify(config.version)}`);
  }

  // --- Optional: stateDir (omitted = use default path) ---
  // P0-3 fix: wizard omits stateDir when using default, so missing key is valid.
  // Only validate if the key is actually present.
  if ('stateDir' in config) {
    if (typeof config.stateDir !== 'string' || config.stateDir.trim().length === 0) {
      errors.push('stateDir must be a non-empty string when provided');
    }
  }

  // --- Required: tiers ---
  if (!('tiers' in config)) {
    errors.push('missing required field: tiers');
  } else if (typeof config.tiers !== 'object' || config.tiers === null || Array.isArray(config.tiers)) {
    errors.push('tiers must be an object');
  } else {
    for (const key of REQUIRED_TIER_KEYS) {
      if (!(key in config.tiers)) {
        errors.push(`tiers is missing scanner key: ${key}`);
      } else if (!VALID_TIERS.has(config.tiers[key])) {
        errors.push(
          `tiers.${key} must be one of BLOCK, WARN, LOG — got: ${JSON.stringify(config.tiers[key])}`
        );
      }
    }
    // Reject unknown tier keys (e.g., QUARANTINE is an action, not a tier key)
    for (const key of Object.keys(config.tiers)) {
      if (!REQUIRED_TIER_KEYS.includes(key)) {
        errors.push(`tiers contains unknown scanner key: ${key}`);
      }
    }
  }

  // --- Optional: egressAllowlist ---
  if ('egressAllowlist' in config) {
    if (!Array.isArray(config.egressAllowlist)) {
      errors.push('egressAllowlist must be an array');
    } else {
      config.egressAllowlist.forEach((item, i) => {
        if (typeof item !== 'string') {
          errors.push(`egressAllowlist[${i}] must be a string`);
        }
      });
    }
  }

  // --- Optional: exceptions ---
  if ('exceptions' in config) {
    if (!Array.isArray(config.exceptions)) {
      errors.push('exceptions must be an array');
    }
  }

  // --- Optional: arSubscriptions (Phase D) ---
  if ('arSubscriptions' in config) {
    const ar = config.arSubscriptions;
    if (typeof ar !== 'object' || ar === null || Array.isArray(ar)) {
      errors.push('arSubscriptions must be a non-null object when provided');
    } else {
      // enabled must be boolean if present
      if ('enabled' in ar && typeof ar.enabled !== 'boolean') {
        errors.push('arSubscriptions.enabled must be a boolean');
      }
      // maxNudgePerEvent bounds [0, 0.02]
      if ('maxNudgePerEvent' in ar) {
        const v = ar.maxNudgePerEvent;
        if (typeof v !== 'number' || v < 0 || v > 0.02) {
          errors.push('arSubscriptions.maxNudgePerEvent must be a number in [0, 0.02]');
        }
      }
      // maxEventsPerScanner24h bounds [0, 100], integer
      if ('maxEventsPerScanner24h' in ar) {
        const v = ar.maxEventsPerScanner24h;
        if (!Number.isInteger(v) || v < 0 || v > 100) {
          errors.push('arSubscriptions.maxEventsPerScanner24h must be an integer in [0, 100]');
        }
      }
      // scanners: keys must be A-I only
      if ('scanners' in ar) {
        if (typeof ar.scanners !== 'object' || ar.scanners === null || Array.isArray(ar.scanners)) {
          errors.push('arSubscriptions.scanners must be an object');
        } else {
          const VALID_AR_SCANNER = /^[A-I]$/;
          for (const key of Object.keys(ar.scanners)) {
            if (!VALID_AR_SCANNER.test(key)) {
              errors.push(`arSubscriptions.scanners contains invalid scanner ID: "${key}" (must be A-I)`);
            } else {
              // Validate domains array items
              const scanner = ar.scanners[key];
              if (scanner && Array.isArray(scanner.domains)) {
                scanner.domains.forEach((domain, i) => {
                  if (!domain || typeof domain !== 'object') {
                    errors.push(`arSubscriptions.scanners.${key}.domains[${i}] must be an object`);
                    return;
                  }
                  if (typeof domain.domain !== 'string' || domain.domain.length === 0) {
                    errors.push(`arSubscriptions.scanners.${key}.domains[${i}].domain must be a non-empty string`);
                  }
                  if (domain.polarity !== 'direct' && domain.polarity !== 'inverse') {
                    errors.push(`arSubscriptions.scanners.${key}.domains[${i}].polarity must be "direct" or "inverse"`);
                  }
                  if ('weight' in domain) {
                    const w = domain.weight;
                    if (typeof w !== 'number' || w <= 0 || w > 1) {
                      errors.push(`arSubscriptions.scanners.${key}.domains[${i}].weight must be a number in (0, 1]`);
                    }
                  }
                });
              }
            }
          }
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Path resolution helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the absolute path of the aisle-config.json for a given project ID.
 * Uses HOME_DIR + path.join() — never tilde expansion.
 *
 * @param {string} projectId
 * @returns {string}
 */
function resolveConfigPath(projectId) {
  return path.join(HOME_DIR, '.claude', 'projects', projectId, 'aisle-config.json');
}

// ---------------------------------------------------------------------------
// Exported module
// ---------------------------------------------------------------------------

module.exports = {

  /**
   * Canonical list of AISLE stateDir subdirectories.
   * upstream CROSS-P1-G: shared between setupWizard() (first boot) and boot.cjs
   * (every cold-start) to prevent drift and silent subdir loss.
   */
  STATE_SUBDIRS,

  /**
   * Derive a project ID from the current working directory.
   * Matches the CC slug format used in ~/.claude/projects/.
   * Replaces path separators, colons, whitespace, and underscores with dashes.
   * Strips leading dashes.
   *
   * Example: 'C:\My_Project' -> 'C--My-Project'
   * (backslash -> dash, colon -> dash, underscore -> dash)
   *
   * Memoized per process-lifetime: `git worktree list` costs ~140ms and is
   * called 4+ times during AISLE boot. CWD and repo root are constant for
   * a given hook process invocation.
   *
   * @returns {string} project slug
   */
  deriveProjectId() {
    if (_derivedProjectId !== null) return _derivedProjectId;
    // Use git to resolve the main worktree path (not cwd, which may be a linked worktree)
    let root;
    try {
      const result = require('child_process').spawnSync(
        'git', ['worktree', 'list', '--porcelain'],
        { encoding: 'utf8', timeout: 3000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
      );
      if (result.stdout) {
        const match = result.stdout.match(/^worktree\s+(.+)/m);
        if (match) root = match[1].trim();
      }
    } catch { /* fall through to cwd */ }
    root = root || process.cwd();
    // P0-5 fix: include underscore in replacement class to match CC slug format
    _derivedProjectId = root.replace(/[\\/:\s_]/g, '-').replace(/^-+/, '');
    return _derivedProjectId;
  },

  /**
   * Load config from disk.
   * Path: path.join(HOME_DIR, '.claude', 'projects', projectId, 'aisle-config.json')
   * Returns null on missing file. Throws on malformed JSON.
   *
   * @param {string} projectId
   * @returns {{ config: object, hash: string } | null}
   */
  loadConfig(projectId) {
    const configPath = resolveConfigPath(projectId);
    if (!fs.existsSync(configPath)) {
      return null;
    }
    const raw = fs.readFileSync(configPath, 'utf8');
    const config = JSON.parse(raw);
    const hash = crypto.createHash('sha256').update(raw).digest('hex');
    return { config, hash };
  },

  /**
   * Save config to disk with schema validation.
   * Refuses to write if validation fails.
   * Creates parent directories as needed.
   *
   * @param {string} projectId
   * @param {object} config
   * @returns {boolean} true on success, false on validation failure
   */
  saveConfig(projectId, config) {
    const validation = validateConfig(config);
    if (!validation.valid) {
      return false;
    }
    const configPath = resolveConfigPath(projectId);
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
    return true;
  },

  /**
   * Validate config object against the AISLE JSON schema.
   * Inline lightweight validator — no npm dependency.
   *
   * @param {object} config
   * @returns {{ valid: boolean, errors: string[] }}
   */
  validateConfig,

  /**
   * Return true if no config file exists for this project (first boot).
   *
   * @param {string} projectId
   * @returns {boolean}
   */
  isFirstBoot(projectId) {
    return !fs.existsSync(resolveConfigPath(projectId));
  },

  /**
   * Compute SHA-256 hash of config file contents for integrity checking.
   * Used by boot Step 3 and per-evaluate() freshness checks.
   *
   * Optimization: uses fs.statSync() mtime as cheap first check.
   * Full hash recomputation only when mtime changes (or on first call).
   *
   * NOTE: In hook subprocesses this cache is subprocess-scoped. Each hook
   * invocation starts with _lastMtime = null, so the cache never hits across
   * tool calls. Accept 2-5ms per invocation or persist to stateDir for true
   * cross-invocation caching (future optimization).
   *
   * @param {string} configPath - Absolute path to config file
   * @returns {string} hex SHA-256 hash
   */
  computeConfigHash(configPath) {
    const stat = fs.statSync(configPath);
    const mtimeMs = stat.mtimeMs;
    if (this._lastMtime === mtimeMs && this._lastHash !== null) {
      return this._lastHash;
    }
    const content = fs.readFileSync(configPath, 'utf8');
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    this._lastMtime = mtimeMs;
    this._lastHash = hash;
    return hash;
  },

  /**
   * Resolve the absolute config file path using HOME_DIR + path.join().
   * Never uses tilde expansion.
   *
   * @param {string} projectId
   * @returns {string}
   */
  resolveConfigPath,

  /**
   * Resolve the state directory path.
   * Default: path.join(HOME_DIR, '.claude', 'projects', <projectId>, 'aisle')
   * If config provides a custom stateDir, validates the resolved path stays
   * within the user home directory (boundary validation against traversal).
   *
   * @param {object|null} config - Parsed config (may contain stateDir override)
   * @returns {string} absolute resolved state directory path
   * @throws {Error} if resolved path is outside the home directory
   */
  resolveStateDir(config, opts = {}) {
    const projectId = this.deriveProjectId();
    const defaultDir = path.join(HOME_DIR, '.claude', 'projects', projectId, 'aisle');
    const rawDir = (config && config.stateDir) ? config.stateDir : defaultDir;
    const resolved = path.resolve(rawDir);

    // Setup-mode can initialize a custom stateDir outside home during test/
    // bootstrap workflows. Keep the production boundary check for regular
    // config-driven calls, and explicitly opt out only when requested.
    if (!opts.skipHomeBoundaryCheck) {
      const homeDir = HOME_DIR;
      // P1-2 fix: require separator boundary to prevent prefix-match traversal
      // e.g., /home/alice-evil/ must NOT pass a check for /home/alice
      const sep = path.sep;
      const boundary = homeDir.endsWith(sep) ? homeDir : homeDir + sep;
      if (!resolved.startsWith(boundary) && resolved !== homeDir) {
        throw new Error(
          `stateDir escapes home directory — resolved: ${resolved}, home: ${homeDir}`
        );
      }
    }
    return resolved;
  },

  /**
   * Create initial AISLE config with default tier settings.
   * Used by the first-boot wizard when no config exists.
   *
   * @param {string} projectId
   * @param {object} options
   * @param {string} [options.stateDir] - Custom stateDir (null for default)
   * @returns {{ config: object, configPath: string, stateDir: string }}
   */
  setupWizard(projectId, options = {}) {
    const configPath = resolveConfigPath(projectId);
    const stateDir = this.resolveStateDir(
      options.stateDir ? { stateDir: options.stateDir } : null,
      { skipHomeBoundaryCheck: true }
    );

    // Default config with all tiers at WARN for Phase 0
    // P0-3 fix: omit stateDir when using default path (null causes validateConfig to reject)
    const config = {
      version: '1.0.0',
      tiers: {
        A: 'WARN', B: 'WARN', C: 'WARN', D: 'WARN', E: 'WARN',
        F: 'WARN', G: 'WARN', H: 'WARN', I: 'WARN',
      },
      ...(options.stateDir ? { stateDir: options.stateDir } : {}),
      createdAt: new Date().toISOString(),
    };

    // Create config directory and write config
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

    // Create state directory with required subdirectories.
    // upstream CROSS-P1-G: list moved to module-level STATE_SUBDIRS so boot.cjs
    // can reuse the same canonical list on every cold-start (defensive ensure,
    // not just first-boot). setupWizard still runs this on genuine first boot.
    for (const subdir of STATE_SUBDIRS) {
      fs.mkdirSync(path.join(stateDir, subdir), { recursive: true });
    }

    // Generate HMAC secret (P0-C: 32-byte random, file-based)
    const hmacSecret = crypto.randomBytes(32).toString('hex');
    const hmacPath = path.join(stateDir, 'hmac-secret');
    fs.writeFileSync(hmacPath, hmacSecret, { mode: 0o600 });

    return { config, configPath, stateDir };
  },

  // Internal mtime cache for computeConfigHash optimization.
  // Subprocess-scoped: resets to null on each hook invocation.
  _lastMtime: null,
  _lastHash: null,
};
