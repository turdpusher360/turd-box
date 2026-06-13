#!/usr/bin/env node
// Hardening note: this file is prone to CC#42383 ghost reversion losing the
// 5 capability exports. If a test run reports only 2 exports, restore from HEAD.
/**
 * Shared utilities for Blueprint hooks.
 *
 * Provides readStdinJson() with a 5-second timeout to prevent Windows stdin hangs,
 * and parseToolInput() for safe access to tool_input fields.
 *
 * Usage:
 *   const { readStdinJson, parseToolInput } = require('./hook-utils.cjs');
 */

'use strict';

const path = require('path');
const fs = require('fs');

const MAX_STDIN = 1024 * 1024; // 1MB limit

// Session ID + cwd cache — populated by readStdinJson from BaseHookInput
let _cachedSessionId = null;
let _cachedCwd = null;

/**
 * Read and parse JSON from stdin with a configurable timeout.
 * Resolves to {} on timeout, error, or malformed input — hooks never crash.
 *
 * @param {object} [options]
 * @param {number} [options.timeoutMs=5000] - Milliseconds before timeout resolves
 * @param {number} [options.maxSize=1048576] - Max stdin bytes to buffer
 * @returns {Promise<object>}
 */
function readStdinJson(options = {}) {
  const { timeoutMs = 5000, maxSize = MAX_STDIN } = options;

  return new Promise((resolve) => {
    let data = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        process.stdin.removeAllListeners('data');
        process.stdin.removeAllListeners('end');
        process.stdin.removeAllListeners('error');
        if (process.stdin.unref) process.stdin.unref();
        try {
          const parsed = data.trim() ? JSON.parse(data) : {};
          if (parsed.session_id) _cachedSessionId = parsed.session_id;
          if (parsed.cwd) _cachedCwd = parsed.cwd;
          resolve(parsed);
        } catch {
          resolve({});
        }
      }
    }, timeoutMs);

    process.stdin.setEncoding('utf8');

    process.stdin.on('data', chunk => {
      if (data.length < maxSize) {
        data += chunk;
      }
    });

    process.stdin.on('end', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        const parsed = data.trim() ? JSON.parse(data) : {};
        if (parsed.session_id) _cachedSessionId = parsed.session_id;
        if (parsed.cwd) _cachedCwd = parsed.cwd;
        resolve(parsed);
      } catch {
        resolve({});
      }
    });

    process.stdin.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({});
    });
  });
}

/**
 * Safely extract a nested field from the parsed hook input.
 * Mirrors the tool_input?.field access pattern used throughout hooks.
 *
 * @param {object} input - Parsed stdin JSON
 * @param {string} field - Field name within tool_input
 * @param {*} [defaultValue=''] - Fallback if field is missing
 * @returns {*}
 */
function parseToolInput(input, field, defaultValue = '') {
  return (input && input.tool_input && input.tool_input[field] !== undefined)
    ? input.tool_input[field]
    : defaultValue;
}

/**
 * Hard-exit safety net. Ensures the hook process terminates even if
 * async work hangs. Uses setTimeout with .unref() so it doesn't
 * keep the event loop alive on its own.
 *
 * @param {number} ms - Milliseconds before forced exit
 */
function enforceTimeout(ms) {
  setTimeout(() => process.exit(0), ms).unref();
}

/**
 * Return a session-scoped file path under _runs/os/.session/.
 * The session ID and cwd are cached from the most recent readStdinJson() call.
 * Falls back to 'default' / process.cwd() if readStdinJson hasn't been called yet.
 *
 * @param {string} name - Category name (e.g., 'session-files', 'memory-stored')
 * @param {string} ext - File extension including dot (e.g., '.json')
 * @returns {string} Absolute path in <cwd>/_runs/os/.session/
 */
function sessionPath(name, ext) {
  const sessionId = _cachedSessionId || 'default';
  const cwd = _cachedCwd || process.cwd();
  const dir = path.join(cwd, '_runs', 'os', '.session');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* best-effort */ }
  return path.join(dir, `claude-${name}-${sessionId}${ext}`);
}

/**
 * Remove stale session files from _runs/os/.session/ matching a prefix.
 * Files older than 24 hours are deleted. Errors are silently ignored.
 *
 * @param {string} prefix - Filename prefix to match (e.g., 'claude-session-files-')
 */
function cleanupStaleFiles(prefix) {
  const cwd = _cachedCwd || process.cwd();
  const sessionDir = path.join(cwd, '_runs', 'os', '.session');
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  try {
    const entries = fs.readdirSync(sessionDir);
    for (const entry of entries) {
      if (!entry.startsWith(prefix)) continue;
      const fullPath = path.join(sessionDir, entry);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.mtimeMs < cutoff) fs.unlinkSync(fullPath);
      } catch { /* skip individual file errors */ }
    }
  } catch { /* sessionDir read error — ignore */ }
}

/**
 * Build a hookSpecificOutput JSON string for capability hooks.
 * Callers write the return value to stdout:
 *   process.stdout.write(buildCapabilityOutput(...))
 *
 * @param {string} name - Capability/hook name (e.g., 'input-transform')
 * @param {string} event - Hook event type (e.g., 'PreToolUse')
 * @param {object} hookSpecificOutput - The hookSpecificOutput payload
 * @param {object} [meta={}] - Optional metadata logged to stderr for observability
 * @returns {string} JSON string for process.stdout.write()
 */
function buildCapabilityOutput(name, event, hookSpecificOutput, meta = {}) {
  if (meta && Object.keys(meta).length > 0) {
    process.stderr.write(`[${name}] ${event} ${JSON.stringify(meta)}\n`);
  }
  const payload = {
    hookEventName: event,
    ...hookSpecificOutput,
  };
  return JSON.stringify({ hookSpecificOutput: payload });
}

/**
 * Log a structured capability response to stderr.
 * Used by asyncRewake and other background hooks for observability.
 *
 * @param {string} name - Capability/hook name (e.g., 'bg-verify')
 * @param {string} event - Hook event type (e.g., 'PostToolUse')
 * @param {object} config - Capability config flags
 * @param {object} [meta={}] - Optional metadata context
 */
function logCapabilityResponse(name, event, config, meta = {}) {
  const payload = { event, config, ...meta };
  process.stderr.write(`[${name}] ${JSON.stringify(payload)}\n`);
}

// --- hook-timing.jsonl rolling trim ---
// In-memory counter per process so we only stat/count the file occasionally.
// Reset when the process exits (each hook invocation is a new process).
let _hookTimingAppendCount = 0;
const HOOK_TIMING_TRIM_CHECK = 500;  // check every N appends
const HOOK_TIMING_MAX_LINES   = 10_000;
const HOOK_TIMING_KEEP_LINES  = 5_000;

/**
 * Trim hook-timing.jsonl to the last KEEP_LINES lines.
 * Uses read-then-write via tmp+rename to avoid partial-write corruption.
 * @param {string} filePath
 */
function _trimHookTiming(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n').filter(l => l.length > 0);
    if (lines.length <= HOOK_TIMING_MAX_LINES) return; // nothing to trim
    const trimmed = lines.slice(lines.length - HOOK_TIMING_KEEP_LINES).join('\n') + '\n';
    const tmp = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, trimmed, 'utf8');
    fs.renameSync(tmp, filePath);
  } catch { /* best-effort — never block the hook */ }
}

/**
 * Report hook execution timing to _runs/os/hook-timing.jsonl.
 * Best-effort, non-blocking. Call at hook exit or use auto-instrumentation.
 * Trims the file to the last 5,000 lines when it exceeds 10,000 lines.
 */
function reportTiming(hookName, startMs) {
  const elapsed = Date.now() - startMs;
  try {
    const timingDir = path.join(process.cwd(), '_runs', 'os');
    fs.mkdirSync(timingDir, { recursive: true });
    const timingPath = path.join(timingDir, 'hook-timing.jsonl');
    const line = JSON.stringify({ hook: hookName, ms: elapsed, ts: new Date().toISOString() }) + '\n';
    fs.appendFileSync(timingPath, line);

    // Periodically check whether the file needs trimming.
    _hookTimingAppendCount += 1;
    if (_hookTimingAppendCount % HOOK_TIMING_TRIM_CHECK === 0) {
      _trimHookTiming(timingPath);
    }
  } catch { /* best-effort */ }
}

/**
 * Platform-aware binary resolver for Windows .cmd shims.
 * execFileSync on Win32 (Git Bash) cannot find .cmd extensions on PATH without shell:true.
 * Returns the right binary name; callers should also pass shell: isWin to be safe.
 *
 * Canonical pattern lives in bg-verify.cjs lines 60-70; this centralises it to avoid drift.
 * upstream P0-1 fix across task-completed-verify, bg-verify, post-edit-typecheck, post-edit-format,
 * plus components/hooks/task-completed-verify (Blueprint mirror).
 *
 * @param {string} bin - Bare binary name (e.g., 'npx', 'npm', 'tsc')
 * @returns {string} Platform-appropriate binary name
 */
const SHIMMABLE_BINS = new Set(['npx', 'npm', 'yarn', 'pnpm', 'vitest', 'eslint', 'tsc', 'jest', 'mocha', 'pytest']);
const isWin = process.platform === 'win32';
function resolvePlatformBin(bin) {
  if (!isWin) return bin;
  if (SHIMMABLE_BINS.has(bin)) return bin + '.cmd';
  return bin;
}

// --- deriveSessionNumber mtime cache ---
// Keyed by runsDir path. Each entry: { mtime: number, result: number }.
// A single hook process is short-lived so this is effectively a single-call
// optimization for os-accounting.cjs which calls deriveSessionNumber on every
// PostToolUse invocation.
const _sessionNumCache = new Map();

/**
 * Derive current session number from _runs/HANDOFF-S*.md filenames.
 * Returns max(parsed S-numbers) + 1. Letter suffixes (S312b) ignored.
 * Falls back to 1 if no handoffs exist.
 *
 * Caches result keyed by _runs/ directory mtime — if the directory has not
 * been modified since last call, the cached value is returned without a
 * readdirSync.  This makes repeated calls within a single hook invocation
 * (or across very rapid successive invocations while _runs/ is unchanged)
 * O(1) after the first call.
 *
 * Source-of-truth: shipped handoff files are immutable work-product markers.
 * Current session = next-after-most-recent. Resilient to mid-session
 * disconnects, /clear, and CC's session_id churn — replaces the prior
 * 30-min DEDUP_WINDOW heuristic which drifted on multi-day sessions.
 *
 * @param {string} [repoRoot=process.cwd()] - Project root containing _runs/
 * @returns {number} Current session number
 */
function deriveSessionNumber(repoRoot) {
  const root = repoRoot || process.cwd();
  const runsDir = path.join(root, '_runs');

  // Check _runs/ mtime — if unchanged, return cached result.
  try {
    const stat = fs.statSync(runsDir);
    const mtime = stat.mtimeMs;
    const cached = _sessionNumCache.get(runsDir);
    if (cached && cached.mtime === mtime) {
      return cached.result;
    }
  } catch { /* _runs dir missing — fall through to full scan */ }

  // Full scan
  let maxShipped = 0;
  try {
    const entries = fs.readdirSync(runsDir);
    for (const entry of entries) {
      const m = entry.match(/^HANDOFF-S(\d+)/);
      if (m) {
        const n = parseInt(m[1], 10);
        if (Number.isFinite(n) && n > maxShipped) maxShipped = n;
      }
    }
    // Store result only if stat succeeded (we need the mtime key).
    try {
      const mtime = fs.statSync(runsDir).mtimeMs;
      _sessionNumCache.set(runsDir, { mtime, result: maxShipped + 1 });
    } catch { /* best-effort cache write */ }
  } catch { /* no _runs dir or read error */ }
  return maxShipped + 1;
}

// Auto-instrument: any hook that requires hook-utils gets timed automatically.
// Hook name derived from the requiring script's filename.
const _hookTimingStart = Date.now();
process.on('exit', () => {
  const caller = process.argv[1] || '';
  const hookName = path.basename(caller, '.cjs') || 'unknown';
  // Only report if this looks like a hook invocation (not a test runner or CLI)
  if (caller.includes('hooks') || caller.includes('hook')) {
    reportTiming(hookName, _hookTimingStart);
  }
});

module.exports = {
  readStdinJson,
  parseToolInput,
  enforceTimeout,
  sessionPath,
  cleanupStaleFiles,
  buildCapabilityOutput,
  logCapabilityResponse,
  reportTiming,
  isWin,
  resolvePlatformBin,
  deriveSessionNumber,
};
