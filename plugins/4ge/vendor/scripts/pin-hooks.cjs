#!/usr/bin/env node
/**
 * pin-hooks.cjs -- Regenerate hook integrity manifest
 *
 * Hashes all security-critical files (hooks, settings, MCP config,
 * CLAUDE.md) and writes the manifest OUTSIDE the repo to:
 *   ~/.claude/projects/<project-id>/hook-pins.json
 *
 * Run after making legitimate changes to any pinned file.
 * Usage: node scripts/pin-hooks.cjs
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const os = require('os');

const PROJECT_ROOT = path.resolve(__dirname, '..');
// [4ge-vendor transform] Derived from the host project directory name
// (the source tree pins a fixed internal project id here).
const PROJECT_ID = path.basename(process.cwd()).replace(/[^a-zA-Z0-9-]/g, '-') || 'default';
const MANIFEST_PATH = path.join(
  os.homedir(), '.claude', 'projects', PROJECT_ID, 'hook-pins.json'
);

// AISLE state directory for HMAC secret
const AISLE_STATE_DIR = path.join(
  os.homedir(), '.claude', 'projects', PROJECT_ID, 'aisle'
);

function hashFile(absPath) {
  return crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
}

function collectFiles() {
  const files = {};

  // ---------------------------------------------------------------------------
  // 1. All hook .cjs files
  // ---------------------------------------------------------------------------
  const hookDir = path.join(PROJECT_ROOT, '.claude', 'hooks');
  if (fs.existsSync(hookDir)) {
    for (const f of fs.readdirSync(hookDir)) {
      if (f.endsWith('.cjs') && !f.startsWith('__')) {
        files[`.claude/hooks/${f}`] = hashFile(path.join(hookDir, f));
      }
    }

    // Check modules
    const checksDir = path.join(hookDir, 'checks');
    if (fs.existsSync(checksDir)) {
      for (const f of fs.readdirSync(checksDir)) {
        if (f.endsWith('.cjs')) {
          files[`.claude/hooks/checks/${f}`] = hashFile(path.join(checksDir, f));
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 2. Settings (hook wiring, permissions, env)
  // ---------------------------------------------------------------------------
  const settingsPath = path.join(PROJECT_ROOT, '.claude', 'settings.json');
  if (fs.existsSync(settingsPath)) {
    files['.claude/settings.json'] = hashFile(settingsPath);
  }

  // ---------------------------------------------------------------------------
  // 3. MCP config (server definitions)
  // ---------------------------------------------------------------------------
  const mcpPath = path.join(PROJECT_ROOT, '.mcp.json');
  if (fs.existsSync(mcpPath)) {
    files['.mcp.json'] = hashFile(mcpPath);
  }

  // ---------------------------------------------------------------------------
  // 4. Instruction files (social engineering surface)
  // ---------------------------------------------------------------------------
  for (const md of ['CLAUDE.md', '.claude/CLAUDE.md']) {
    const p = path.join(PROJECT_ROOT, md);
    if (fs.existsSync(p)) {
      files[md] = hashFile(p);
    }
  }

  // ---------------------------------------------------------------------------
  // 5. AISLE security modules (T13 perimeter expansion)
  // ---------------------------------------------------------------------------
  const aisleDir = path.join(PROJECT_ROOT, 'lib', 'aisle');
  if (fs.existsSync(aisleDir)) {
    collectDirRecursive(aisleDir, 'lib/aisle', files, ['.cjs', '.json']);
  }

  // Canary fixtures (any file type)
  const canaryDir = path.join(PROJECT_ROOT, 'lib', 'aisle', 'canaries');
  if (fs.existsSync(canaryDir)) {
    collectDirRecursive(canaryDir, 'lib/aisle/canaries', files);
  }

  // ---------------------------------------------------------------------------
  // 6. Plugin hooks (upstream CROSS-P1-A: plugins/4ge/hooks were previously unpinned,
  //    leaving Scanner D blind to the 11 plugin hook files that wire via
  //    ${CLAUDE_PLUGIN_ROOT}/hooks/*.cjs. Pin them from the repo copy at
  //    plugins/4ge/hooks/ so tampering is detected at boot.)
  // ---------------------------------------------------------------------------
  const pluginHooksDir = path.join(PROJECT_ROOT, 'plugins', '4ge', 'hooks');
  if (fs.existsSync(pluginHooksDir)) {
    collectDirRecursive(pluginHooksDir, 'plugins/4ge/hooks', files, ['.cjs', '.json']);
  }

  // ---------------------------------------------------------------------------
  // 7. Self-hash (ATK-6: pin-hooks.cjs includes itself)
  // ---------------------------------------------------------------------------
  const selfPath = path.join(PROJECT_ROOT, 'scripts', 'pin-hooks.cjs');
  if (fs.existsSync(selfPath)) {
    files['scripts/pin-hooks.cjs'] = hashFile(selfPath);
  }

  return files;
}

/**
 * Recursively collect files from a directory with optional extension filter.
 * @param {string} dir - Absolute directory path
 * @param {string} relPrefix - Relative path prefix for keys
 * @param {Object} files - Output map (mutated)
 * @param {string[]} [exts] - Optional extension filter (e.g. ['.cjs', '.json'])
 */
function collectDirRecursive(dir, relPrefix, files, exts) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    const relPath = `${relPrefix}/${entry.name}`;
    if (entry.isDirectory()) {
      collectDirRecursive(fullPath, relPath, files, exts);
    } else if (!exts || exts.some(ext => entry.name.endsWith(ext))) {
      files[relPath] = hashFile(fullPath);
    }
  }
}

// ---------------------------------------------------------------------------
// HMAC signing (P0-C: file-based secret)
// ---------------------------------------------------------------------------

/**
 * Read HMAC secret from AISLE state directory.
 * Reads <stateDir>/hmac-secret (generated by wizard via setupWizard()).
 *
 * P1-4 fix: removed weak fallback to hostname:username. That fallback was
 * enumerable by any local process, making HMAC trivially forgeable.
 * Callers must catch ENOENT and surface: "Run /aisle setup first."
 *
 * @param {string} [stateDir] - AISLE state directory (defaults to AISLE_STATE_DIR)
 * @returns {string} HMAC secret
 * @throws {Error} If hmac-secret file is missing (AISLE not initialized)
 */
function getHmacSecret(stateDir) {
  const dir = stateDir || AISLE_STATE_DIR;
  const secretPath = path.join(dir, 'hmac-secret');
  // P1-4 fix: no fallback — throws ENOENT if AISLE not initialized.
  // Caller in verifyManifest returns false; caller in signManifest surfaces error.
  return fs.readFileSync(secretPath, 'utf8').trim();
}

/**
 * HMAC-sign a manifest object.
 * @param {object} manifest - The manifest to sign
 * @param {string} [stateDir] - AISLE state directory
 * @returns {string} hex HMAC-SHA256 signature
 */
function signManifest(manifest, stateDir) {
  const secret = getHmacSecret(stateDir);
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(JSON.stringify(manifest));
  return hmac.digest('hex');
}

/**
 * Verify a manifest HMAC signature.
 * Uses timing-safe comparison with length guard (P1 fix: timingSafeEqual
 * throws ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH on length mismatch).
 *
 * P1-4 fallout: getHmacSecret() now throws if hmac-secret file is missing.
 * verifyManifest() handles this by returning false — AISLE not initialized
 * means we cannot verify, which is a security failure (not a crash).
 *
 * @param {object} manifest - The manifest to verify
 * @param {string} signature - Hex HMAC signature to check
 * @param {string} [stateDir] - AISLE state directory
 * @returns {boolean} true if signature is valid
 */
function verifyManifest(manifest, signature, stateDir) {
  let expected;
  try {
    expected = signManifest(manifest, stateDir);
  } catch (_err) {
    // P1-4 fallout: getHmacSecret threw (AISLE not initialized) — cannot verify
    return false;
  }
  const expectedBuf = Buffer.from(expected, 'hex');
  const sigBuf = Buffer.from(signature, 'hex');
  // Length guard: timingSafeEqual throws on length mismatch
  if (expectedBuf.length !== sigBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, sigBuf);
}

// ---------------------------------------------------------------------------
// Main (when run directly)
// ---------------------------------------------------------------------------

if (require.main === module) {
  const files = collectFiles();
  const manifest = {
    generated: new Date().toISOString(),
    generator: 'scripts/pin-hooks.cjs',
    project: PROJECT_ID,
    fileCount: Object.keys(files).length,
    files,
  };

  // Sign manifest with HMAC (graceful degradation if AISLE not initialized)
  let signature = null;
  try {
    signature = signManifest(manifest);
  } catch (_err) {
    process.stderr.write('[pin-hooks] HMAC secret not found — manifest unsigned (run AISLE wizard to enable)\n');
  }

  const output = { ...manifest, ...(signature ? { signature } : {}) };

  fs.mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(output, null, 2));

  console.log(`[pin-hooks] Pinned ${manifest.fileCount} files to:`);
  console.log(`  ${MANIFEST_PATH}`);

  // Summary by category
  const hooks = Object.keys(files).filter((f) => f.includes('/hooks/'));
  const aisle = Object.keys(files).filter((f) => f.startsWith('lib/aisle/'));
  const other = Object.keys(files).filter((f) => !f.includes('/hooks/') && !f.startsWith('lib/aisle/'));
  console.log(`  Hooks: ${hooks.length}`);
  console.log(`  AISLE modules: ${aisle.length}`);
  console.log(`  Config/instructions: ${other.length}`);
  console.log(`  HMAC signed: ${signature ? 'yes' : 'no (secret missing — run AISLE wizard to enable)'}`);
}

// ---------------------------------------------------------------------------
// Exports (for boot.cjs verification)
// ---------------------------------------------------------------------------

/**
 * _setManifestPathForTesting — test-only escape hatch.
 * Redirects MANIFEST_PATH to a temp path so tests never touch the real
 * production manifest at ~/.claude/projects/<project-id>/hook-pins.json.
 *
 * Usage (in test beforeEach):
 *   pinHooks._setManifestPathForTesting(path.join(os.tmpdir(), 'test-hook-pins.json'));
 * Restore (in test afterEach):
 *   pinHooks._setManifestPathForTesting(null);  // reverts to production path
 */
const _exports = {
  hashFile,
  collectFiles,
  getHmacSecret,
  signManifest,
  verifyManifest,
  MANIFEST_PATH,
  _setManifestPathForTesting(overridePath) {
    _exports.MANIFEST_PATH = overridePath !== null && overridePath !== undefined
      ? overridePath
      : MANIFEST_PATH;
  },
};

module.exports = _exports;
