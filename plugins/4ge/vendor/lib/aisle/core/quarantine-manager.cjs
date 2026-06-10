'use strict';

/**
 * quarantine-manager.cjs — AISLE Quarantine Manager
 *
 * Manages file isolation, release, and the quarantine manifest.
 *
 * Design invariants:
 *   - isolate() max 5 calls per evaluation cycle (ATK-7 rate limit)
 *   - QUARANTINE_EXEMPT files are BLOCK-only — never moved to quarantine
 *   - release() is atomic: 3-step (restore, rebaseline, exception) with rollback
 *   - undoAll() requires explicit confirmation string 'CONFIRM-UNDO-ALL'
 *   - migrateManifest() imports the legacy .claude/hooks/quarantine-manifest.json
 *   - hashFile delegates to scripts/pin-hooks.cjs (single source of truth)
 *   - All FS operations are synchronous (readFileSync / writeFileSync / copyFileSync)
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_ISOLATE_PER_CYCLE = 5;
const EXCEPTION_TTL_MS = 24 * 60 * 60 * 1000; // 24h

const QUARANTINE_EXEMPT = new Set([
  'package.json',
  'package-lock.json',
  'CLAUDE.md',
  '.claude/CLAUDE.md',
  '.claude/settings.json',
]);

// ---------------------------------------------------------------------------
// Rate-limit counter (module-scoped, reset per require())
// ---------------------------------------------------------------------------

let _isolateCount = 0;

/**
 * Reset the per-evaluation rate-limit counter.
 * Called by AISLE boot between evaluations; also used by tests.
 */
function resetCycleCounter() {
  _isolateCount = 0;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Compute SHA-256 hex of a file. Delegates to pin-hooks.cjs. */
function hashFile(absPath) {
  return require('../../../scripts/pin-hooks.cjs').hashFile(absPath);
}

/** Generate a short random quarantine ID: q-<8 hex chars>. */
function generateId() {
  return 'q-' + crypto.randomBytes(4).toString('hex');
}

/** Resolve manifest path within stateDir. */
function manifestPath(stateDir) {
  return path.join(stateDir, 'quarantine', 'manifest.json');
}

/** Resolve quarantine item directory for a given id. */
function itemDir(stateDir, id) {
  return path.join(stateDir, 'quarantine', 'items', id);
}

/** Resolve baselines/file-hashes.json path. */
function baselinePath(stateDir) {
  return path.join(stateDir, 'baselines', 'file-hashes.json');
}

/**
 * Load the quarantine manifest from disk.
 * Returns [] if the file does not exist or is empty.
 */
function loadManifest(stateDir) {
  const mp = manifestPath(stateDir);
  if (!fs.existsSync(mp)) return [];
  try {
    const raw = fs.readFileSync(mp, 'utf8').trim();
    if (!raw) return [];
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

/**
 * Persist the quarantine manifest to disk.
 * Creates parent directory if needed.
 */
function saveManifest(stateDir, entries) {
  const mp = manifestPath(stateDir);
  fs.mkdirSync(path.dirname(mp), { recursive: true });
  fs.writeFileSync(mp, JSON.stringify(entries, null, 2), 'utf8');
}

/**
 * Load baselines/file-hashes.json.
 * Returns { hashes: {}, createdAt: ... } structure.
 */
function loadBaseline(stateDir) {
  const bp = baselinePath(stateDir);
  if (!fs.existsSync(bp)) return { hashes: {}, createdAt: Date.now() };
  try {
    const raw = fs.readFileSync(bp, 'utf8');
    const parsed = JSON.parse(raw);
    return { hashes: parsed.hashes || parsed, createdAt: parsed.createdAt || Date.now() };
  } catch {
    return { hashes: {}, createdAt: Date.now() };
  }
}

/**
 * Persist updated baselines/file-hashes.json.
 */
function saveBaseline(stateDir, data) {
  const bp = baselinePath(stateDir);
  fs.mkdirSync(path.dirname(bp), { recursive: true });
  fs.writeFileSync(bp, JSON.stringify(data, null, 2), 'utf8');
}

/**
 * Emit a QUARANTINE or SYSTEM event to the event bus if it has been
 * initialized. Silently skips if event-bus init() was never called.
 */
function tryEmit(event) {
  try {
    const bus = require('../scanners/event-bus.cjs');
    bus.emit(event);
  } catch {
    // event-bus may not be initialized in tests or isolated contexts
  }
}

/**
 * Normalize a file path to a relative forward-slash key for baseline lookup.
 */
function normalizeToRelative(filePath) {
  const cwd = process.cwd();
  let rel = filePath;
  if (path.isAbsolute(filePath)) {
    rel = path.relative(cwd, filePath);
  }
  return rel.split(path.sep).join('/');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Isolate a file by moving it into the quarantine directory.
 *
 * Rate limit: max 5 calls per evaluation cycle (ATK-7).
 * Exempt files: BLOCK only (never moved).
 *
 * @param {string} filePath       - Absolute or relative path to quarantine
 * @param {object} finding        - Scanner finding object (includes scanner, message, etc.)
 * @param {string} stateDir       - AISLE state directory
 * @returns {{ success: boolean, quarantineId: string, error?: string, exempt?: boolean }}
 */
function isolate(filePath, finding, stateDir) {
  // --- Rate limit check (ATK-7) ---
  if (_isolateCount >= MAX_ISOLATE_PER_CYCLE) {
    return {
      success: false,
      quarantineId: null,
      error: `Rate limit reached: max ${MAX_ISOLATE_PER_CYCLE} quarantines per evaluation cycle`,
    };
  }

  // --- Exempt check: BLOCK only, never quarantine ---
  const relPath = normalizeToRelative(filePath);
  const basename = path.basename(filePath);
  // Check both the relative path and the basename against the exempt set
  if (QUARANTINE_EXEMPT.has(relPath) || QUARANTINE_EXEMPT.has(basename)) {
    return {
      success: false,
      quarantineId: null,
      exempt: true,
      error: `File is quarantine-exempt (BLOCK only): ${relPath}`,
    };
  }

  // --- Verify file exists ---
  const absPath = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
  if (!fs.existsSync(absPath)) {
    return {
      success: false,
      quarantineId: null,
      error: `File not found: ${filePath}`,
    };
  }

  // --- Compute hash before moving ---
  let fileHash;
  try {
    fileHash = hashFile(absPath);
  } catch (err) {
    fileHash = null;
  }

  // --- Generate quarantine ID and destination ---
  const id = generateId();
  const destDir = itemDir(stateDir, id);
  const destFile = path.join(destDir, path.basename(absPath));

  try {
    fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(absPath, destFile);
    fs.unlinkSync(absPath);
  } catch (err) {
    // Clean up partial move
    try { if (fs.existsSync(destFile)) fs.unlinkSync(destFile); } catch {}
    try { if (fs.existsSync(destDir)) fs.rmSync(destDir, { recursive: true }); } catch {}
    return {
      success: false,
      quarantineId: null,
      error: `Failed to move file to quarantine: ${err.message}`,
    };
  }

  // --- Build manifest entry ---
  const entry = {
    id,
    originalPath: relPath,
    finding: finding || null,
    timestamp: Date.now(),
    hash: fileHash,
  };

  // --- Update manifest ---
  const entries = loadManifest(stateDir);
  entries.push(entry);
  saveManifest(stateDir, entries);

  // --- Increment rate-limit counter ---
  _isolateCount += 1;

  // --- Emit event ---
  tryEmit({
    type: 'QUARANTINE',
    scanner: (finding && finding.scanner) || 'D',
    tool: 'quarantine-manager',
    finding: `Isolated ${relPath} [id=${id}]`,
    decision: 'quarantine',
  });

  return { success: true, quarantineId: id };
}

/**
 * List all quarantined items.
 *
 * @param {string} stateDir - AISLE state directory
 * @returns {Array<object>} QuarantineEntry[]
 */
function list(stateDir) {
  return loadManifest(stateDir);
}

/**
 * Release a quarantined file back to its original location.
 *
 * Atomic 3-step process:
 *   Step 1 (RESTORE): Copy file back to original path.
 *   Step 2 (REBASELINE): Update baselines/file-hashes.json with current hash.
 *   Step 3 (EXCEPTION): Add a 24h time-limited exception to the config.
 * Any failure rolls back all completed steps.
 *
 * @param {string} quarantineId - ID from the manifest entry
 * @param {string} reason       - Human-readable reason for release
 * @param {string} stateDir     - AISLE state directory
 * @returns {{ success: boolean, error?: string }}
 */
function release(quarantineId, reason, stateDir) {
  // --- Find entry in manifest ---
  const entries = loadManifest(stateDir);
  const idx = entries.findIndex(e => e.id === quarantineId);
  if (idx === -1) {
    return { success: false, error: `Quarantine ID not found: ${quarantineId}` };
  }

  const entry = entries[idx];
  const srcFile = path.join(itemDir(stateDir, quarantineId), path.basename(entry.originalPath));

  if (!fs.existsSync(srcFile)) {
    return { success: false, error: `Quarantine item file missing: ${srcFile}` };
  }

  const absOriginal = path.isAbsolute(entry.originalPath)
    ? entry.originalPath
    : path.join(process.cwd(), entry.originalPath);

  // ---------------------------------------------------------------------------
  // Step 1: RESTORE — copy file back to original path
  // ---------------------------------------------------------------------------
  let step1Done = false;
  let priorFileContent = null;

  try {
    // Capture prior file if it exists (for rollback)
    if (fs.existsSync(absOriginal)) {
      priorFileContent = fs.readFileSync(absOriginal);
    }
    fs.mkdirSync(path.dirname(absOriginal), { recursive: true });
    fs.copyFileSync(srcFile, absOriginal);
    step1Done = true;
  } catch (err) {
    return { success: false, error: `Step 1 (restore) failed: ${err.message}` };
  }

  // ---------------------------------------------------------------------------
  // Step 2: REBASELINE — update baselines/file-hashes.json
  // ---------------------------------------------------------------------------
  let step2Done = false;
  let priorBaselineData = null;

  try {
    priorBaselineData = loadBaseline(stateDir);
    const newHash = hashFile(absOriginal);
    const relKey = normalizeToRelative(absOriginal);

    const updatedData = {
      ...priorBaselineData,
      hashes: {
        ...priorBaselineData.hashes,
        [relKey]: newHash,
      },
    };
    saveBaseline(stateDir, updatedData);
    step2Done = true;
  } catch (err) {
    // Rollback Step 1
    if (step1Done) {
      try {
        if (priorFileContent !== null) {
          fs.writeFileSync(absOriginal, priorFileContent);
        } else {
          fs.unlinkSync(absOriginal);
        }
      } catch {}
    }
    return { success: false, error: `Step 2 (rebaseline) failed: ${err.message}` };
  }

  // ---------------------------------------------------------------------------
  // Step 3: EXCEPTION — add time-limited exception to config
  // ---------------------------------------------------------------------------
  try {
    const exceptionEntry = {
      id: quarantineId,
      path: entry.originalPath,
      reason: reason || 'manual release',
      releasedAt: Date.now(),
      expiresAt: Date.now() + EXCEPTION_TTL_MS,
    };

    const exceptionsPath = path.join(stateDir, 'exceptions.json');
    let exceptions = [];
    if (fs.existsSync(exceptionsPath)) {
      try {
        exceptions = JSON.parse(fs.readFileSync(exceptionsPath, 'utf8'));
        if (!Array.isArray(exceptions)) exceptions = [];
      } catch {
        exceptions = [];
      }
    }
    exceptions.push(exceptionEntry);
    fs.writeFileSync(exceptionsPath, JSON.stringify(exceptions, null, 2), 'utf8');
  } catch (err) {
    // Rollback Step 2 and Step 1
    if (step2Done && priorBaselineData !== null) {
      try { saveBaseline(stateDir, priorBaselineData); } catch {}
    }
    if (step1Done) {
      try {
        if (priorFileContent !== null) {
          fs.writeFileSync(absOriginal, priorFileContent);
        } else {
          fs.unlinkSync(absOriginal);
        }
      } catch {}
    }
    return { success: false, error: `Step 3 (exception) failed: ${err.message}` };
  }

  // --- Remove from manifest ---
  entries.splice(idx, 1);
  saveManifest(stateDir, entries);

  // --- Emit event ---
  tryEmit({
    type: 'SYSTEM',
    scanner: 'D',
    tool: 'quarantine-manager',
    finding: `Released quarantine ${quarantineId} for ${entry.originalPath}: ${reason}`,
    decision: 'release',
  });

  return { success: true };
}

/**
 * Emergency bulk release of all quarantined items.
 *
 * @param {string} confirmation - Must be 'CONFIRM-UNDO-ALL' to proceed
 * @param {string} stateDir     - AISLE state directory
 * @returns {{ released: number, failed: number }}
 */
function undoAll(confirmation, stateDir) {
  if (confirmation !== 'CONFIRM-UNDO-ALL') {
    return { released: 0, failed: 0 };
  }

  const entries = loadManifest(stateDir);
  let released = 0;
  let failed = 0;

  for (const entry of entries) {
    const result = release(entry.id, 'emergency bulk release (undoAll)', stateDir);
    if (result.success) {
      released += 1;
    } else {
      failed += 1;
    }
  }

  return { released, failed };
}

/**
 * Migrate the legacy .claude/hooks/quarantine-manifest.json into AISLE format.
 *
 * Reads the legacy manifest and imports each quarantined_component entry
 * as a synthetic AISLE manifest entry (without moving any files).
 * Skips entries that are already in the AISLE manifest.
 *
 * @param {string} stateDir - AISLE state directory
 * @returns {{ migrated: number, errors: string[] }}
 */
function migrateManifest(stateDir) {
  const legacyPath = path.join(process.cwd(), '.claude', 'hooks', 'quarantine-manifest.json');
  const errors = [];
  let migrated = 0;

  if (!fs.existsSync(legacyPath)) {
    errors.push(`Legacy manifest not found: ${legacyPath}`);
    return { migrated, errors };
  }

  let legacy;
  try {
    legacy = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
  } catch (err) {
    errors.push(`Failed to parse legacy manifest: ${err.message}`);
    return { migrated, errors };
  }

  const components = Array.isArray(legacy.quarantined_components)
    ? legacy.quarantined_components
    : [];

  const existingEntries = loadManifest(stateDir);
  const existingNames = new Set(existingEntries.map(e => e.originalPath));

  for (const comp of components) {
    const syntheticPath = `legacy:${comp.type}:${comp.name}`;
    if (existingNames.has(syntheticPath)) {
      continue; // already migrated
    }

    const id = generateId();
    const entry = {
      id,
      originalPath: syntheticPath,
      finding: {
        scanner: 'migration',
        reason: comp.reason || 'migrated from legacy quarantine-manifest.json',
        type: comp.type,
        name: comp.name,
        blockedBy: comp.blocked_by || [],
        quarantinedAt: comp.quarantined_at || null,
      },
      timestamp: comp.quarantined_at
        ? new Date(comp.quarantined_at).getTime() || Date.now()
        : Date.now(),
      hash: null,
      migrated: true,
    };

    existingEntries.push(entry);
    existingNames.add(syntheticPath);
    migrated += 1;
  }

  if (migrated > 0) {
    saveManifest(stateDir, existingEntries);
  }

  return { migrated, errors };
}

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------

module.exports = {
  isolate,
  list,
  release,
  undoAll,
  migrateManifest,
  // Exported for tests / boot cycle reset
  resetCycleCounter,
  // Exposed for introspection
  QUARANTINE_EXEMPT,
};
