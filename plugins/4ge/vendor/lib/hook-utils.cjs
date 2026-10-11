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
 * Determine whether a SessionEnd / PreCompact hook input describes a REAL
 * interactive session, as opposed to an ephemeral utility session.
 *
 * On CC v2.1.212 a `claude update` run from a repo cwd spins an ephemeral
 * session that fires the project SessionEnd hook chain on exit with no real
 * transcript. Left unguarded, that fire let session-cartridge-writer.cjs
 * clobber a committed cartridge working copy (upstream incident). This predicate
 * lets both SessionEnd hooks bail before writing anything.
 *
 * Returns true ONLY when stdin's `transcript_path` points to a readable,
 * non-empty transcript containing at least one genuine user or assistant
 * conversation turn. Absent, unreadable, empty, or turnless transcripts return
 * false — the failure mode being guarded is a destructive continuity write by a
 * no-op session, so uncertainty resolves to "do not write."
 *
 * Transcript JSONL shape (verified against real transcripts on this rig in
 * ~/.claude/projects/<slug>/<session>.jsonl):
 *   { type: 'user'|'assistant'|'system'|..., message: { role, content }, ... }
 * A line counts as a real turn when its top-level `type` is 'user'/'assistant'
 * OR its `message.role` is 'user'/'assistant' — unless the record is flagged
 * `isMeta: true` (harness-injected records never count, whatever their shape).
 * Meta-only records (mode, permission-mode, system, bridge-session,
 * attachment, last-prompt) never match.
 *
 * @param {object|null} input - Parsed SessionEnd stdin (BaseHookInput)
 * @param {object} [opts]
 * @param {number} [opts.maxBytes=20971520] - Files larger than this are treated
 *   as unambiguously real without a full read (never ephemeral).
 * @returns {boolean}
 */
function sessionHasRealTranscript(input, opts = {}) {
  const { maxBytes = 20 * 1024 * 1024 } = opts;
  try {
    const transcriptPath = input && input.transcript_path;
    if (!transcriptPath || typeof transcriptPath !== 'string') return false;

    let stat;
    try { stat = fs.statSync(transcriptPath); } catch { return false; }
    if (!stat.isFile() || stat.size === 0) return false;
    // A transcript this large is unambiguously a real session — skip the read.
    if (stat.size > maxBytes) return true;

    const raw = fs.readFileSync(transcriptPath, 'utf8');
    // Manual line scan with early return: real turns appear near the top of a
    // transcript, so this short-circuits without allocating a full line array.
    let idx = 0;
    const len = raw.length;
    while (idx < len) {
      let nl = raw.indexOf('\n', idx);
      if (nl === -1) nl = len;
      const line = raw.slice(idx, nl);
      idx = nl + 1;
      if (!line) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      if (!obj || typeof obj !== 'object') continue;
      // Meta-wrapped records (harness-injected caveats, summaries, etc.) can
      // carry type 'user' or a message.role without being a genuine turn
      // (review 211-2) — never let them mark a transcript as real.
      if (obj.isMeta === true) continue;
      if (obj.type === 'user' || obj.type === 'assistant') return true;
      const msg = obj.message;
      if (msg && typeof msg === 'object' && (msg.role === 'user' || msg.role === 'assistant')) return true;
    }
    return false;
  } catch {
    // Any unexpected error resolves to "not a real transcript" — the safe
    // direction is to bail rather than risk a destructive write.
    return false;
  }
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
const HOOK_TIMING_MAX_LINES   = 10_000;
const HOOK_TIMING_KEEP_LINES  = 5_000;
// Byte gate for the (more expensive) line-count trim. Each timing line is
// ~75 bytes, so 10k lines is roughly 750KB; a 1MB gate keeps the precise
// line-count trim rare while bounding the file. This REPLACES the old
// per-process append counter (`_hookTimingAppendCount % 500`), which was dead
// code: every hook runs in its own short-lived process and appends exactly ONE
// line before exit, so the counter never reached 500 and the trim never fired —
// the file grew unbounded to 29.8MB / 431k lines (upstream hook-perf audit).
// statSync is sub-ms and, unlike the counter, is stateless across processes.
const HOOK_TIMING_MAX_BYTES   = 1024 * 1024;

/**
 * Trim hook-timing.jsonl to the last KEEP_LINES lines.
 * Uses read-then-write via tmp+rename to avoid partial-write corruption.
 * @param {string} filePath
 */
function _trimHookTiming(filePath) {
  const tmp = `${filePath}.${process.pid}.tmp`;
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n').filter(l => l.length > 0);
    if (lines.length <= HOOK_TIMING_MAX_LINES) return; // nothing to trim
    const trimmed = lines.slice(lines.length - HOOK_TIMING_KEEP_LINES).join('\n') + '\n';
    fs.writeFileSync(tmp, trimmed, 'utf8');
    fs.renameSync(tmp, filePath);
  } catch {
    // Best-effort: never block the hook. A failed write or rename must not
    // strand the per-pid tmp file (36 orphans had piled up in _runs/os).
    try { fs.unlinkSync(tmp); } catch { /* never created, or already gone */ }
  }
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

    // Trim when the file's ACTUAL size crosses the threshold. Gating on a
    // stateless statSync (not the old per-process counter) is the fix — see
    // HOOK_TIMING_MAX_BYTES above. The statSync adds one sub-ms syscall to each
    // hook exit, negligible beside the mkdirSync + appendFileSync already here.
    try {
      if (fs.statSync(timingPath).size > HOOK_TIMING_MAX_BYTES) {
        _trimHookTiming(timingPath);
      }
    } catch { /* stat may fail on the very first write — ignore */ }
  } catch { /* best-effort */ }
}

/**
 * Sanctioned JSONL append with stateless size-gated rotation.
 *
 * The single source of truth for bounded JSONL growth is lib/os/jsonl-rotate.cjs
 * (appendJsonl: rotate-if-over-limit THEN append; byte + entry-count gates; keeps N
 * rotated files). It already existed before this re-export — an upstream teammate refused
 * to duplicate it, and the upstream diagnosis's claim that "appendJsonl lives in
 * lib/hook-utils.cjs" was itself record-drift (Class 4). Rather than add a SECOND
 * rotation implementation (the duplication disease the upstream welds exist to kill), we
 * re-export the canonical one here so hooks — which already require hook-utils — have a
 * single obvious sanctioned append path. Lazy-required so hooks that never append pay
 * nothing at load. Enforced by scripts/check-wiring-liveness.cjs (raw-append gate).
 *
 * @param {string} filePath — absolute path to the .jsonl file
 * @param {object} entry — JSON-serializable record
 * @param {object} [opts] — {maxEntries=10000, maxBytes=5MB, maxRotated=3}
 */
function appendJsonl(filePath, entry, opts) {
  return require('./os/jsonl-rotate.cjs').appendJsonl(filePath, entry, opts);
}

/**
 * Force a rotation check on a JSONL file (delegates to lib/os/jsonl-rotate.cjs).
 * @param {string} filePath
 * @param {object} [opts]
 * @returns {boolean} whether a rotation was performed
 */
function rotateIfNeeded(filePath, opts) {
  return require('./os/jsonl-rotate.cjs').rotateIfNeeded(filePath, opts);
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

// --- deriveNextHandoffNumber mtime cache ---
// Keyed by runsDir path. Each entry: { mtime: number, result: number }.
// A single hook process is short-lived so this is effectively a single-call
// optimization for os-accounting.cjs which checks the handoff number on every
// PostToolUse invocation.
const _nextHandoffNumCache = new Map();

// A shipped handoff name: HANDOFF-S<N>.md (optional letter suffix, S312b) or
// HANDOFF-S<N>-<8 hex session id>.md (optional -R<k> round). Wrap, notes and
// topic files written mid-session (HANDOFF-S<N>-og-wrap.md) do not match
// (BL-413): they would move the HUD S-label past the session still open.
const SHIPPED_HANDOFF_RE = /^HANDOFF-S\d+[a-z]?(?:-[0-9a-f]{8}(?:-R\d+)?)?\.md$/i;

/**
 * Derive the next durable handoff number from _runs/HANDOFF-S*.md filenames.
 * A shipped handoff SN (SHIPPED_HANDOFF_RE) contributes N + 1; a pickup (name
 * ends -PICKUP.md, any case) is named for the session that reads it, so pickup
 * SN contributes N. Any other HANDOFF-S name contributes nothing. Returns the
 * max contribution. Letter suffixes (S312b) ignored.
 * Falls back to 1 if no handoffs exist.
 *
 * Caches result keyed by _runs/ directory mtime — if the directory has not
 * been modified since last call, the cached value is returned without a
 * readdirSync.  This makes repeated calls within a single hook invocation
 * (or across very rapid successive invocations while _runs/ is unchanged)
 * O(1) after the first call.
 *
 * Source-of-truth: shipped handoff files are immutable work-product markers,
 * but this helper does not claim a current durable session identity. Compact,
 * resume, /clear, and runtime session_id churn do not mint a new S-number.
 *
 * @param {string} [repoRoot=process.cwd()] - Project root containing _runs/
 * @returns {number} Next handoff number candidate
 */
function deriveNextHandoffNumber(repoRoot) {
  const root = repoRoot || process.cwd();
  const runsDir = path.join(root, '_runs');

  // Check _runs/ mtime — if unchanged, return cached result.
  try {
    const stat = fs.statSync(runsDir);
    const mtime = stat.mtimeMs;
    const cached = _nextHandoffNumCache.get(runsDir);
    if (cached && cached.mtime === mtime) {
      return cached.result;
    }
  } catch { /* _runs dir missing — fall through to full scan */ }

  // Full scan
  let maxShipped = 0;
  let maxPickup = 0;
  try {
    const entries = fs.readdirSync(runsDir);
    for (const entry of entries) {
      const m = entry.match(/^HANDOFF-S(\d+)/);
      if (m) {
        const n = parseInt(m[1], 10);
        if (!Number.isFinite(n)) continue;
        if (/-PICKUP\.md$/i.test(entry)) {
          if (n > maxPickup) maxPickup = n;
        } else if (n > maxShipped && SHIPPED_HANDOFF_RE.test(entry)) {
          maxShipped = n;
        }
      }
    }
    // Store result only if stat succeeded (we need the mtime key).
    try {
      const mtime = fs.statSync(runsDir).mtimeMs;
      _nextHandoffNumCache.set(runsDir, { mtime, result: Math.max(maxShipped + 1, maxPickup) });
    } catch { /* best-effort cache write */ }
  } catch { /* no _runs dir or read error */ }
  return Math.max(maxShipped + 1, maxPickup);
}

/**
 * Legacy alias retained for existing hook consumers.
 * Prefer deriveNextHandoffNumber() for new code; the returned value is not proof
 * of the current durable repo session.
 */
function deriveSessionNumber(repoRoot) {
  return deriveNextHandoffNumber(repoRoot);
}

// Commands that consume a heredoc body as DATA. Allowlist, never a denylist:
// an unrecognized command word must fall back to scanning the raw text.
const HEREDOC_DATA_SINKS = new Set(['cat', 'tee']);

// Shapes that hand the body to a consumer this helper cannot identify (pipe,
// command substitution, process substitution, backtick) or continue the header
// onto the next physical line, making the "body" ordinary command text.
const HEREDOC_SINK_DISQUALIFIER = /[|`]|\$\(|>\(|<\(|\\$/;

// A capture-or-execute context ANYWHERE earlier in the command feeds the sink's
// stdout straight back to the shell, so the body executes even though the sink
// is `cat`: `eval "$(cat <<'EOF' … )"`, `bash <(cat <<'EOF' … )`, backticks.
// Verified in bash. Deliberately blunt — an already-closed substitution
// disqualifies too, because tracking paren balance through shell quoting can
// only fail in the dangerous direction.
const HEREDOC_CAPTURE_CONTEXT = /[`]|\$\(|<\(|>\(/;

// An enclosing brace group, subshell, function, loop, if or case applies its
// output routing AFTER the terminator (`{ cat <<'EOF' … EOF\n} | bash`,
// `while …\ndo\ncat <<'EOF' … done | sh`), where no header-line check can see
// it (BL-390). Just as blunt: an opener anywhere earlier disqualifies, closed
// or not, quoted or not (`${VAR}`, a `(` in an earlier body, the word "do" in
// an earlier string). Over-blocking is the safe direction. `if`, `while` and
// `until` cover a heredoc in a condition list (`if true; cat <<'EOF' … EOF\nthen
// :; fi | bash`); `for` and `select` need no entry, because their body opens
// with `do` or `{`. A keyword counts only when a blank, a shell metacharacter
// or a backtick delimits it, as bash requires of a reserved word, so a path
// word such as use-case.md or do-not-merge.md does not.
const HEREDOC_ENCLOSING_CONTEXT = /[{(]|(?:^|[\s;&|()<>`])(?:if|while|until|do|then|else|elif|case)(?=$|[\s;&|()<>`])/;

// An earlier heredoc operator may own this one: inside its body
// (`bash <<OUTER | bash`, then `cat <<'EOF' … EOF`, then `OUTER`) the outer
// consumer runs the inner heredoc, wherever its own output goes (BL-506). Just as
// blunt: a finished earlier heredoc disqualifies too, so a second sequential
// heredoc stays visible. Telling them apart means modelling bash's terminator
// rules, including the backslash-newline join inside an unquoted-delimiter body.
const HEREDOC_EARLIER_OPERATOR = /(?<!<)<<(?!<)/;

// Blanks and the metacharacters after which bash starts a new token, the only
// place a `#` opens a comment.
const SHELL_TOKEN_BREAKS = new Set([' ', '\t', '\n', ';', '&', '|', '(', ')', '<', '>']);

/**
 * True when `text` ends inside a single- or double-quoted string, or holds an
 * ANSI-C `$'…'` string, which this scan does not model. A `<<` inside a quoted
 * script (`sh -c "true;cat <<'EOF' …" | sh`) is not a heredoc at this level: the
 * script's own shell runs it, and its output goes wherever the outer command
 * sends it (BL-506). A `#` opens a comment only at the start of a token, as in
 * bash, so a quote inside a comment does not count and a quote after a mid-word
 * `#` does. bash removes a backslash-newline, so the pair leaves the token state
 * as it was. A comment that runs to the end of `text` also returns true: the `<<`
 * is comment text there, and bash runs the "body" lines as commands
 * (`echo hi # ok; cat <<'EOF'`). Callers rule out heredoc bodies first
 * (HEREDOC_EARLIER_OPERATOR).
 *
 * @param {string} text - command text before the `<<` operator
 */
function endsInsideQuote(text) {
  let quote = '';
  let tokenStart = true;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote === "'") {
      if (ch === "'") quote = '';
      continue;
    }
    if (quote === '"') {
      if (ch === '\\') i++;
      else if (ch === '"') quote = '';
      continue;
    }
    if (ch === '\\') {
      if (text[i + 1] !== '\n') tokenStart = false;
      i++;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      tokenStart = false;
    } else if (ch === '$' && text[i + 1] === "'") {
      return true;
    } else if (ch === '#' && tokenStart) {
      const nl = text.indexOf('\n', i);
      if (nl === -1) return true;
      i = nl - 1;
    } else {
      tokenStart = SHELL_TOKEN_BREAKS.has(ch);
    }
  }
  return quote !== '';
}

// The sink word is the first token after the last of these.
const HEREDOC_SEGMENT_SEPARATORS = ['\n', ';', '&', '|', '(', '{', '`'];

const HEREDOC_STRIPPED_BODY = '[heredoc-body-stripped]\n';

// Two passes rather than one alternation so each regex is valid standalone and
// its terminator can back-reference the tag it actually captured.
// `(?<!<)<<(?!<)` keeps herestrings (<<<WORD) and bit-shifts ($((1 << N))) out.
const HEREDOC_QUOTED_RE =
  /(?<!<)(<<(?!<)-?[ \t]*(['"])([A-Za-z_][A-Za-z0-9_]*)\2([^\n]*)\n)[\s\S]*?\n[ \t]*\3[ \t]*(?=\n|$|;)/g;
const HEREDOC_ESCAPED_RE =
  /(?<!<)(<<(?!<)-?[ \t]*\\([A-Za-z_][A-Za-z0-9_]*)([^\n]*)\n)[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$|;)/g;

/**
 * True when the last segment of `text` (after the last separator) starts with an
 * allowlisted data sink and carries no disqualifier.
 *
 * @param {string} text - command text before the `<<` operator
 */
function heredocSegmentIsSink(text) {
  let segStart = -1;
  for (const sep of HEREDOC_SEGMENT_SEPARATORS) {
    const at = text.lastIndexOf(sep);
    if (at > segStart) segStart = at;
  }
  const segment = text.slice(segStart + 1);
  if (HEREDOC_SINK_DISQUALIFIER.test(segment)) return false;
  const words = segment.trim().split(/\s+/).filter(Boolean);
  return words.length > 0 && HEREDOC_DATA_SINKS.has(words[0]);
}

/**
 * True only when the command feeding this heredoc is an allowlisted data sink
 * and nothing on the segment can route the body to an unknown consumer.
 *
 * @param {string} src - the string being scanned (pass 2 sees pass 1's output)
 * @param {number} opStart - index of the `<<` operator within src
 * @param {string} headerRemainder - header-line text following the tag
 */
function heredocSinkAllowed(src, opStart, headerRemainder) {
  if (HEREDOC_SINK_DISQUALIFIER.test(headerRemainder)) return false;
  // bash joins a backslash-newline before it parses (`i\<newline>f` is `if`), so
  // the context checks run on the joined text too. Joining can only add matches.
  const before = src.slice(0, opStart);
  const joined = before.replace(/\\\n/g, '');
  if (HEREDOC_CAPTURE_CONTEXT.test(before) || HEREDOC_CAPTURE_CONTEXT.test(joined)) return false;
  if (HEREDOC_ENCLOSING_CONTEXT.test(before) || HEREDOC_ENCLOSING_CONTEXT.test(joined)) return false;
  if (HEREDOC_EARLIER_OPERATOR.test(before) || HEREDOC_EARLIER_OPERATOR.test(joined)) return false;
  if (endsInsideQuote(before) || endsInsideQuote(joined)) return false;
  // The sink must hold on BOTH texts. Raw alone misses a continuation from the
  // previous line (`bash -s \` then `cat <<'EOF'` is `bash -s cat <<'EOF'`).
  // Joined alone is no better: the naive join eats the newline after an escaped
  // backslash (`cat \\` then `bash -s <<'EOF'` would read as `cat \bash -s`).
  return heredocSegmentIsSink(before) && heredocSegmentIsSink(joined);
}

/**
 * Strip heredoc BODIES from a shell command string before pattern-scanning it.
 *
 * Guard hooks (guard-git-scope, guard-social-interaction) regex-scan the whole
 * command string, so a heredoc that merely DOCUMENTS a dangerous command (a lane
 * report quoting a force-push, a run-log carrying a ready-to-run PR-create line)
 * trips the same block as running it.
 *
 * DESIGN INTENT: false-positive hygiene for a cooperative agent, NOT a security
 * boundary. These guards are substring matchers an intent-bearing agent can
 * already evade trivially; the helper's job is to avoid WIDENING that gap, which
 * is why every ambiguous shape below falls back to scanning the RAW text.
 *
 * Scope honesty: the content-blind substring class fired three times on
 * 2026-08-27 (upstream, `_runs/.constraints.jsonl`), and only ONE of the three was
 * heredoc-shaped (a minion report written through a heredoc). The other two were
 * a PostToolUse trigger matching the bare substring `commit`, and a `printf`
 * whose QUOTED ARGUMENT named the trigger phrase. Neither is addressed here.
 *
 * The command LINE (redirection, tag, and the rest of the line) is preserved;
 * only the body between the header and its terminator is replaced. Stripping
 * requires ALL of the following — each unmet condition falls back to raw text:
 *
 * - The delimiter is QUOTED (`<<'EOF'`, `<<"EOF"`) or BACKSLASH-ESCAPED
 *   (`<<\EOF`). An unquoted delimiter makes bash expand `$(...)`, backticks and
 *   `${...}` in the body BEFORE the sink sees it, so that body can execute.
 * - The command feeding it is an allowlisted data sink (`cat`, `tee`). An
 *   interpreter — python3, node, `bash -s`, perl, psql, ssh — EXECUTES the body,
 *   and this repo's own `.claude/` apply doctrine is `python3 << 'PYEOF'`, so an
 *   unrecognized command word must fail closed. The sink word must hold on the
 *   raw segment and again with backslash-newlines joined, so a continuation
 *   from the previous line (`bash -s \` then `cat <<'EOF'`) cannot hide the
 *   interpreter that really receives the body.
 * - No pipe or line continuation is in play on that segment, and no capture-or-
 *   execute context (`$(`, `<(`, `>(`, backtick) appears anywhere earlier in the
 *   command. `eval "$(cat <<'EOF' … )"` and `bash <(cat <<'EOF' … )` execute the
 *   body despite the sink being `cat` — verified in bash.
 * - No brace group, subshell, function body, loop, if or case opens anywhere
 *   earlier in the command: a `{` or `(`, or a whole-word `if`, `while`,
 *   `until`, `do`, `then`, `else`, `elif` or `case`, delimited the way bash
 *   delimits a reserved word and checked again with backslash-newlines joined.
 *   Such a construct routes the body through redirections after the
 *   terminator, as in `{ cat <<'EOF' … EOF\n} | bash` (BL-390).
 * - No other heredoc operator appears anywhere earlier in the command, raw or
 *   with backslash-newlines joined. A heredoc in another heredoc's body
 *   (`bash <<OUTER | bash\ncat <<'EOF' … EOF\nOUTER`) goes to the outer
 *   consumer, which runs it (BL-506).
 * - The `<<` is not inside an open quote. In `sh -c "true;cat <<'EOF' … EOF\n" | sh`
 *   it is script text, and the inner shell runs the body (BL-506). The quote
 *   scan treats `#` as a comment only at the start of a token, as bash does.
 *   A comment that runs into the `<<` fails closed (`echo hi # ok; cat <<'EOF'`
 *   is all comment, so bash runs the "body"), and so does an ANSI-C `$'…'`
 *   string anywhere earlier.
 * - The `<<` is a real heredoc operator, not a herestring or a bit-shift.
 * - The heredoc is TERMINATED.
 *
 * Terminator semantics deliberately diverge from bash: a trailing `;` is
 * accepted as well as end-of-line, where bash requires the delimiter alone on
 * its line. The helper therefore ends a body EARLIER than bash would and leaves
 * trailing text visible to the scanner — the over-blocking direction.
 *
 * Also left untouched, all fail-closed: CRLF-authored heredocs, every heredoc
 * after the first in a command (a finished earlier one disqualifies too, so a
 * second sequential heredoc stays visible), and any input past the size/count cap.
 */
function stripHeredocBodies(command) {
  const src = String(command);
  if (!src.includes('<<')) return src;
  // Body scanning is superlinear in the number of distinct unmatched tags, and
  // the whole Bash guard chain shares one 9.5s fail-closed budget.
  if (src.length > 32768 || (src.match(/<</g) || []).length > 64) return src;

  const afterQuoted = src.replace(
    HEREDOC_QUOTED_RE,
    (match, header, _quote, tag, rest, offset, whole) => (
      heredocSinkAllowed(whole, offset, rest) ? header + HEREDOC_STRIPPED_BODY + tag : match
    )
  );
  return afterQuoted.replace(
    HEREDOC_ESCAPED_RE,
    (match, header, tag, rest, offset, whole) => (
      heredocSinkAllowed(whole, offset, rest) ? header + HEREDOC_STRIPPED_BODY + tag : match
    )
  );
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
  sessionHasRealTranscript,
  enforceTimeout,
  sessionPath,
  cleanupStaleFiles,
  buildCapabilityOutput,
  logCapabilityResponse,
  reportTiming,
  appendJsonl,
  rotateIfNeeded,
  isWin,
  resolvePlatformBin,
  deriveNextHandoffNumber,
  deriveSessionNumber,
  stripHeredocBodies,
};
