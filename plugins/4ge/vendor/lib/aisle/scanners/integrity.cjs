'use strict';

/**
 * integrity.cjs — AISLE Scanner D
 *
 * Infrastructure tampering detection via protected-path policy enforcement
 * (fast path, evaluate()) and full hash comparison (slow path, scan()).
 *
 * Design invariants:
 *   - evaluate() is path-policy ONLY — no SHA-256 hashing, must complete <10ms
 *   - scan() is the only place SHA-256 hashes are computed
 *   - Bash redirect interception (ATK-6): checks redirect operators targeting
 *     protected paths; also performs substring match for complex commands
 *   - Scanner D degradation = global fail-closed (enforced by scanner-registry)
 *   - Synchronous only — readFileSync, no async
 *   - hashFile delegated to scripts/pin-hooks.cjs (single source of truth, P1-8)
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Protected path patterns (compiled once at module load)
// Relative paths from project root, forward slashes.
// ---------------------------------------------------------------------------

const PROTECTED_PATTERNS = [
  /^\.claude\/hooks\/.*\.cjs$/,
  /^\.claude\/agents\/.*\.md$/,
  /^\.claude\/rules\/.*\.md$/,
  /^\.claude\/settings\.json$/,
  /^scripts\/pin-hooks\.cjs$/,
];

// upstream: Source code paths that should WARN (not BLOCK) on direct edit.
// These are development source files the lead session legitimately modifies.
// Hooks, agents, rules, and settings remain BLOCK — they are the enforcement
// mechanism itself, and subagent tampering there disables security.
const WARN_PATTERNS = [
  /^lib\/os\/.*\.cjs$/,
  /^lib\/aisle\/.*/,
];

// Fast substring fragments for the secondary Bash substring scan.
// Any command containing one of these verbatim strings gets flagged.
const PROTECTED_SUBSTRINGS = [
  '.claude/hooks/',
  '.claude/agents/',
  '.claude/rules/',
  '.claude/settings.json',
  'lib/os/',
  'lib/aisle/',
  'scripts/pin-hooks.cjs',
];

// upstream: Read-only command prefixes exempt from the substring check.
// These commands legitimately reference protected path strings as arguments
// (e.g., `git diff lib/aisle/server.cjs`, `wc -l .claude/hooks/*.cjs`)
// and are not write operations. Redirecting output to a protected path IS
// still caught by extractRedirectTargets() which runs before this check.
const READ_ONLY_PREFIXES = [
  // git read operations
  'git diff', 'git log', 'git status', 'git show', 'git blame',
  'git ls-files', 'git describe', 'git shortlog', 'git reflog',
  'git rev-parse', 'git branch', 'git remote', 'git stash list',
  'git worktree list', 'git tag', 'git fetch',
  // file inspection (read-only — redirect writes caught by step 1)
  'wc ', 'head ', 'tail ', 'cat ', 'less ', 'more ', 'file ',
  'stat ', 'ls ', 'find ', 'diff ', 'sort ', 'grep ', 'rg ',
  'md5sum ', 'sha256sum ', 'sha1sum ',
  // gh read operations
  'gh pr view', 'gh pr list', 'gh issue view', 'gh issue list',
  'gh api', 'gh repo view', 'gh run view', 'gh run list',
  // shell builtins that can only produce output (redirect writes caught by step 1)
  'echo ', 'printf ', 'true', 'false',
];

// QUARANTINE_EXEMPT: these paths trigger BLOCK only — never quarantine.
// Used downstream by policy-engine, stored on findings.
const QUARANTINE_EXEMPT_PATHS = new Set([
  'package.json',
  'package-lock.json',
  'CLAUDE.md',
  '.claude/CLAUDE.md',
  '.claude/settings.json',
]);

// ---------------------------------------------------------------------------
// Bash redirect operator patterns (ATK-6)
// Each regex captures the destination path in the last capture group.
// ---------------------------------------------------------------------------

const REDIRECT_PATTERNS = [
  { re: />>?\s*(['"]?)([^\s'";&|]+)\1/, group: 2, label: 'redirect' },
  { re: /\|\s*tee\s+(['"]?)([^\s'";&|]+)\1/, group: 2, label: 'tee' },
  { re: /\bmv\s+\S+\s+(['"]?)([^\s'";&|]+)\1/, group: 2, label: 'mv' },
  { re: /\bcp\s+(?:-[^\s]+\s+)?\S+\s+(['"]?)([^\s'";&|]+)\1/, group: 2, label: 'cp' },
  { re: /\brm\s+(?:-[a-zA-Z]+\s+)*(['"]?)([^\s'";&|]+)\1/, group: 2, label: 'rm' },
  { re: /\bdd\s+.*\bof=(['"]?)([^\s'";&|]+)\1/, group: 2, label: 'dd' },
  { re: /\binstall\s+.*\s+(['"]?)([^\s'";&|]+)\1\s*$/, group: 2, label: 'install' },
  { re: /\bln\s+(?:-[a-zA-Z]+\s+)*\S+\s+(['"]?)([^\s'";&|]+)\1/, group: 2, label: 'ln' },
];

// ---------------------------------------------------------------------------
// Stale baseline threshold
// ---------------------------------------------------------------------------

const BASELINE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a file path to a relative, forward-slash key suitable for
 * comparison against PROTECTED_PATTERNS.
 *
 * @param {string} filePath - raw path from tool_input (may be absolute or relative)
 * @returns {string} normalized relative path with forward slashes
 */
function normalizePath(filePath, opts = {}) {
  if (!filePath) return '';
  const cwd = process.cwd();
  let rel = filePath;
  const resolveSymlink = opts.resolveSymlink !== false;
  // P1-10: Resolve symlinks to catch bypass via symlinked paths. Direct
  // protected paths can skip this expensive filesystem call in evaluate().
  if (resolveSymlink) {
    try {
      const resolved = fs.realpathSync(filePath);
      if (resolved !== filePath) rel = resolved;
    } catch { /* target may not exist yet — use original */ }
  }
  if (path.isAbsolute(rel)) {
    rel = path.relative(cwd, rel);
  }
  // Normalize separators to forward slash + P1-9: lowercase on Windows
  rel = rel.split(path.sep).join('/');
  if (process.platform === 'win32') rel = rel.toLowerCase();
  return rel;
}

function normalizePathForPolicy(filePath) {
  const lexical = normalizePath(filePath, { resolveSymlink: false });
  if (isProtectedPath(lexical) || isWarnPath(lexical)) return lexical;
  return normalizePath(filePath);
}

/**
 * Check if a normalized relative path matches any protected pattern.
 *
 * @param {string} normalizedPath
 * @returns {boolean}
 */
function isProtectedPath(normalizedPath) {
  if (!normalizedPath) return false;
  return PROTECTED_PATTERNS.some(re => re.test(normalizedPath));
}

/**
 * Check if a normalized relative path matches a warn-only pattern.
 * These paths are monitored but edits produce WARN findings, not BLOCK.
 *
 * @param {string} normalizedPath
 * @returns {boolean}
 */
function isWarnPath(normalizedPath) {
  if (!normalizedPath) return false;
  return WARN_PATTERNS.some(re => re.test(normalizedPath));
}

/**
 * Extract the destination path from a Bash command string by checking each
 * redirect operator pattern.
 *
 * Returns an array of { dest, label } objects for each matched redirect
 * that targets a protected path.
 *
 * @param {string} command
 * @returns {Array<{dest: string, label: string}>}
 */
function extractRedirectTargets(command) {
  const hits = [];
  for (const { re, group, label } of REDIRECT_PATTERNS) {
    const match = re.exec(command);
    if (match) {
      const dest = match[group];
      if (dest) {
        const normalized = normalizePathForPolicy(dest);
        // upstream: Bash redirects BLOCK for both protected AND warn paths.
        // A redirect bypasses Write/Edit tool permissions, so it's always
        // more dangerous than a direct Write/Edit (which only WARNs).
        if (isProtectedPath(normalized) || isWarnPath(normalized)) {
          hits.push({ dest, label });
        }
      }
    }
  }
  return hits;
}

/**
 * Secondary substring check for Bash commands: if the command string contains
 * any protected path substring, flag it (catches multi-token / complex commands
 * that the regex patterns may not fully parse).
 *
 * @param {string} command
 * @returns {string|null} first matching substring, or null
 */
function findProtectedSubstringInCommand(command) {
  if (!command) return null;

  // upstream: Skip substring check for read-only commands that legitimately
  // reference protected path strings as arguments. Redirects from these
  // commands (e.g., `git diff > lib/aisle/x`) are still caught by
  // extractRedirectTargets() before this function is reached.
  //
  // upstream fix: commands often arrive as `cd /path && actual-command`. Strip the
  // cd prefix to expose the actual command for prefix matching. Also handle
  // compound commands joined with && — if ALL segments are read-only, skip.
  const segments = command.split(/\s*&&\s*/);
  const allReadOnly = segments.every((seg) => {
    const trimmed = seg.trimStart();
    // Empty segments (trailing &&) are harmless
    if (!trimmed) return true;
    // cd is always read-only
    if (trimmed.startsWith('cd ')) return true;
    // Check against read-only prefix list
    return READ_ONLY_PREFIXES.some(prefix => trimmed.startsWith(prefix));
  });
  if (allReadOnly) return null;

  for (const sub of PROTECTED_SUBSTRINGS) {
    if (command.includes(sub)) return sub;
  }
  return null;
}

/**
 * Build a Finding object for integrity violations.
 *
 * @param {string} message
 * @param {object} opts
 * @returns {object}
 */
function makeFinding(message, opts = {}) {
  return {
    scanner: 'D',
    tier: opts.tier || 'BLOCK',
    message,
    path: opts.path || null,
    evidence: opts.evidence || null,
    flags: {
      untrusted: false,
      sensitive: true,
      external: false,
    },
    quarantineExempt: QUARANTINE_EXEMPT_PATHS.has(opts.path || ''),
  };
}

// ---------------------------------------------------------------------------
// hashFile — delegates to pin-hooks.cjs (P1-8: single source of truth)
// ---------------------------------------------------------------------------

function hashFile(absPath) {
  return require('../../../scripts/pin-hooks.cjs').hashFile(absPath);
}

// ---------------------------------------------------------------------------
// Resolve stateDir from environment (for scan/health when not passed directly)
// ---------------------------------------------------------------------------

function resolveStateDir() {
  return process.env.AISLE_STATE_DIR || null;
}

// ---------------------------------------------------------------------------
// Scanner D public interface
// ---------------------------------------------------------------------------

const scanner = {
  id: 'D',
  name: 'integrity',
  version: '1.0.0',
  defaultTier: 'BLOCK',
  cadence: ['boot', 'per-tool'],
  capabilities: { network: false, fs: true, env: [] },

  // -------------------------------------------------------------------------
  // evaluate(toolInput, cachedState)
  //
  // FAST PATH: path-policy check only (<10ms).
  // Does NOT compute SHA-256 hashes — that is scan()'s job.
  //
  // Handles:
  //   - Write/Edit tool_input: checks file_path
  //   - Bash tool_input: checks command for redirect operators targeting
  //     protected paths; falls back to substring scan
  //
  // Returns: { allow: boolean, findings: Finding[] }
  // -------------------------------------------------------------------------

  evaluate(toolInput, _cachedState) {
    const findings = [];

    if (!toolInput || typeof toolInput !== 'object') {
      return { allow: true, findings };
    }

    const toolName = toolInput._toolName || toolInput.tool_name;

    // -- Write or Edit: check file_path --
    if (toolInput.file_path !== undefined) {
      const normalized = normalizePathForPolicy(toolInput.file_path);
      if (isProtectedPath(normalized)) {
        findings.push(makeFinding(
          `Write/Edit to protected path: ${normalized}`,
          { path: normalized }
        ));
      } else if (isWarnPath(normalized)) {
        findings.push(makeFinding(
          `Write/Edit to monitored source path: ${normalized}`,
          { path: normalized, tier: 'WARN' }
        ));
      }
      return { allow: findings.length === 0, findings };
    }

    // -- Bash: parse command for redirect operators + substring match --
    if (toolInput.command !== undefined) {
      const command = String(toolInput.command || '');

      // 1. Redirect operator check
      const redirectHits = extractRedirectTargets(command);
      for (const { dest, label } of redirectHits) {
        const normalized = normalizePath(dest);
        findings.push(makeFinding(
          `Bash redirect (${label}) targeting protected path: ${normalized}`,
          { path: normalized, evidence: command.slice(0, 200) }
        ));
      }

      // 2. Blanket git staging protection (absorbed from guard-git-scope.cjs)
      // Match only the dangerous patterns: `git add .` (dot), `git add -A` (exact flag),
      // `git add --all` (long form). Do NOT match `git add -f`, `git add -p`, etc. —
      // those are targeted adds with force/patch flags, not blanket staging.
      if (/git\s+add\s+\.(?=\s|$)|git\s+add\s+-A\b|git\s+add\s+--all\b|git\s+commit\s+-a\b/.test(command)) {
        findings.push(makeFinding(
          'Blanket git staging blocked — use specific file paths instead',
          { evidence: command.slice(0, 200) }
        ));
      }

      // 3. Force push to main/master protection
      if (/git\s+push\s+.*--force(?!-with-lease).*\b(main|master)\b/.test(command)) {
        findings.push(makeFinding(
          'Force push to main/master blocked',
          { evidence: command.slice(0, 200) }
        ));
      }

      // 4. Secondary substring match (catches complex/multi-token commands)
      // Only if redirect check didn't already fire on the same substring
      if (findings.length === 0) {
        const sub = findProtectedSubstringInCommand(command);
        if (sub) {
          findings.push(makeFinding(
            `Bash command contains protected path substring: ${sub}`,
            { evidence: command.slice(0, 200) }
          ));
        }
      }

      return { allow: findings.length === 0, findings };
    }

    return { allow: true, findings };
  },

  // -------------------------------------------------------------------------
  // scan(context)
  //
  // SLOW PATH: full SHA-256 hash computation.
  // Walks protected paths, compares against baseline in stateDir.
  // Also performs self-monitoring of AISLE's own files.
  //
  // Returns: { findings, duration, cachedState: { protectedPaths: string[] } }
  // -------------------------------------------------------------------------

  scan(context) {
    const startTime = Date.now();
    const findings = [];
    const stateDir = (context && context.stateDir) || resolveStateDir();

    const cwd = process.cwd();

    // Directories to walk for integrity scanning
    const dirsToScan = [
      path.join(cwd, '.claude', 'hooks'),
      path.join(cwd, '.claude', 'agents'),
      path.join(cwd, '.claude', 'rules'),
      path.join(cwd, 'lib', 'os'),
      path.join(cwd, 'lib', 'aisle'),
    ];

    // Individual files
    const filesToScan = [
      path.join(cwd, '.claude', 'settings.json'),
      path.join(cwd, 'scripts', 'pin-hooks.cjs'),
    ];

    // Build current hash map
    const currentHashes = {};

    for (const dir of dirsToScan) {
      if (!fs.existsSync(dir)) continue;
      try {
        const entries = walkDir(dir);
        for (const absPath of entries) {
          const rel = path.relative(cwd, absPath).split(path.sep).join('/');
          try {
            currentHashes[rel] = hashFile(absPath);
          } catch {
            // unreadable
          }
        }
      } catch {
        // unreadable dir
      }
    }

    for (const absPath of filesToScan) {
      if (!fs.existsSync(absPath)) continue;
      const rel = path.relative(cwd, absPath).split(path.sep).join('/');
      try {
        currentHashes[rel] = hashFile(absPath);
      } catch {
        // unreadable
      }
    }

    // Compare against baseline if stateDir is available
    if (stateDir) {
      const baselinePath = path.join(stateDir, 'baselines', 'file-hashes.json');
      if (fs.existsSync(baselinePath)) {
        let baseline;
        try {
          const raw = fs.readFileSync(baselinePath, 'utf8');
          const parsed = JSON.parse(raw);
          baseline = parsed.hashes || parsed;
        } catch {
          findings.push(makeFinding('Baseline read/parse failed — cannot verify integrity', {
            evidence: baselinePath,
          }));
          baseline = null;
        }

        if (baseline) {
          for (const [relPath, expectedHash] of Object.entries(baseline)) {
            const currentHash = currentHashes[relPath];
            if (currentHash === undefined) {
              // File in baseline but not found on disk
              findings.push(makeFinding(`Protected file missing: ${relPath}`, {
                path: relPath,
              }));
            } else if (currentHash !== expectedHash) {
              findings.push(makeFinding(`Hash mismatch for protected file: ${relPath}`, {
                path: relPath,
                evidence: `expected=${expectedHash.slice(0, 16)}… got=${currentHash.slice(0, 16)}…`,
              }));
            }
          }
        }
      }
    }

    const duration = Date.now() - startTime;

    return {
      findings,
      duration,
      scannedAt: Date.now(),
      fileCount: Object.keys(currentHashes).length,
      cachedState: {
        protectedPaths: Object.keys(currentHashes),
        scannedAt: Date.now(),
      },
    };
  },

  // -------------------------------------------------------------------------
  // selfTest()
  //
  // Verify canary fixtures behave as expected:
  //   1. tampered-hook.cjs: its hash should NOT match a "clean" baseline
  //      (the file is intentionally modified — tampered = true marker)
  //   2. ghost-reversion.json: content should represent an old reverted state
  //
  // Returns: { pass: boolean, details: object }
  // -------------------------------------------------------------------------

  selfTest() {
    const canaryDir = path.join(__dirname, '..', 'canaries', 'D');
    const results = {};

    // -- Canary 1: tampered-hook.cjs --
    const tamperedPath = path.join(canaryDir, 'tampered-hook.cjs');
    if (!fs.existsSync(tamperedPath)) {
      results['tampered-hook'] = { pass: false, reason: 'canary file missing' };
    } else {
      try {
        const content = fs.readFileSync(tamperedPath, 'utf8');
        // The canary must contain the TAMPERED marker to be a valid tamper simulation
        const isTampered = content.includes('TAMPERED:') || content.includes('"tampered": true');
        results['tampered-hook'] = {
          pass: isTampered,
          reason: isTampered
            ? 'tampered marker present — detection would fire on hash mismatch'
            : 'tampered marker missing — canary is not a valid tamper simulation',
        };
      } catch (err) {
        results['tampered-hook'] = { pass: false, reason: `read failed: ${err.message}` };
      }
    }

    // -- Canary 2: ghost-reversion.json --
    const ghostPath = path.join(canaryDir, 'ghost-reversion.json');
    if (!fs.existsSync(ghostPath)) {
      results['ghost-reversion'] = { pass: false, reason: 'canary file missing' };
    } else {
      try {
        const raw = fs.readFileSync(ghostPath, 'utf8');
        const parsed = JSON.parse(raw);
        const hasCanaryMetadata = parsed._aisle_canary && parsed._aisle_canary.id === 'D-ghost-reversion';
        const representsOldState = parsed.version && parsed.version.includes('REVERTED');
        const pass = hasCanaryMetadata && representsOldState;
        results['ghost-reversion'] = {
          pass,
          reason: pass
            ? 'ghost-reversion canary valid — represents old reverted state'
            : 'ghost-reversion canary invalid — missing expected metadata or version marker',
        };
      } catch (err) {
        results['ghost-reversion'] = { pass: false, reason: `read/parse failed: ${err.message}` };
      }
    }

    const allPass = Object.values(results).every(r => r.pass);

    return {
      pass: allPass,
      details: results,
    };
  },

  // -------------------------------------------------------------------------
  // health()
  //
  // Check if baseline is fresh and stateDir is accessible.
  // Returns: { status: 'healthy'|'degraded', reason?: string, baselineAgeMs?: number }
  // -------------------------------------------------------------------------

  health() {
    const stateDir = resolveStateDir();

    if (!stateDir) {
      return {
        status: 'degraded',
        reason: 'AISLE_STATE_DIR not set — cannot verify baseline freshness',
      };
    }

    const baselinePath = path.join(stateDir, 'baselines', 'file-hashes.json');

    if (!fs.existsSync(baselinePath)) {
      return {
        status: 'degraded',
        reason: 'baseline file-hashes.json not found — run boot to initialize',
      };
    }

    try {
      const raw = fs.readFileSync(baselinePath, 'utf8');
      const parsed = JSON.parse(raw);
      const createdAt = parsed.createdAt;

      if (!createdAt) {
        return { status: 'degraded', reason: 'baseline missing createdAt timestamp' };
      }

      const ageMs = Date.now() - createdAt;
      const isStale = ageMs > BASELINE_TTL_MS;

      return {
        status: isStale ? 'degraded' : 'healthy',
        baselineAgeMs: ageMs,
        reason: isStale ? `baseline is stale (${Math.round(ageMs / 3600000)}h old, TTL=24h)` : undefined,
      };
    } catch (err) {
      return {
        status: 'degraded',
        reason: `baseline read/parse failed: ${err.message}`,
      };
    }
  },
};

// ---------------------------------------------------------------------------
// walkDir — recursively collect all files under a directory
// ---------------------------------------------------------------------------

function walkDir(dir) {
  const results = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...walkDir(fullPath));
      } else {
        results.push(fullPath);
      }
    }
  } catch {
    // unreadable
  }
  return results;
}

module.exports = scanner;
