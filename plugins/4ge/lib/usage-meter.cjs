'use strict';
/**
 * usage-meter.cjs — Local usage/cost analytics over Claude Code transcripts.
 *
 * Dependency-free (node core only) replacement for the external `ccusage` CLI,
 * built after it failed (`command not found`) on a hard pre-dispatch burn
 * gate. Parses the JSONL transcripts Claude Code writes under
 * `~/.claude/projects/`, aggregates token usage per day / month / session /
 * 5-hour billing block, and prices it from a local config
 * (`lib/data/model-pricing.json`). Consumed by `bin/usage.cjs`.
 *
 * ## Transcript facts (verified empirically on this rig, 2026-07-10)
 * - Files live at `<projectsDir>/<project-slug>/*.jsonl` AND nested at
 *   `<projectsDir>/<slug>/<session-uuid>/subagents/agent-*.jsonl` — discovery
 *   must recurse or subagent usage (which bills) is silently missed.
 * - Only `type: "assistant"` entries carry `message.usage`. The same
 *   `(message.id, requestId)` pair is re-appended on streaming snapshots —
 *   observed 4x with identical usage — so entries dedup on that pair
 *   (last-by-timestamp wins, in case a later snapshot carries final counts).
 * - `message.model === "<synthetic>"` entries are runtime-injected (zero
 *   usage, no requestId) and are excluded.
 * - `usage.cache_creation` splits creation tokens into
 *   `ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens`, letting the
 *   pricer distinguish the 1.25x vs 2x cache-write tiers. Older entries
 *   (pre ~June 2026) lack the split; those fall back to the 5m rate.
 * - `costUSD` was present on 0 of ~5,000 sampled entries — cost is therefore
 *   ALWAYS computed from the pricing config and is an ESTIMATE.
 *
 * ## Privacy hard line
 * `extractEntry()` copies ONLY usage numbers, model, timestamps and ids out of
 * a parsed line. `message.content` (and every other field) is structurally
 * dropped — never retained, printed, or logged.
 *
 * ## Block algorithm (ccusage parity)
 * Blocks are 5h. A block starts at the UTC hour-floor of the first entry after
 * a >=5h gap (or the first entry ever). An entry belongs to the current block
 * while `ts < start + 5h`. The active block is the one whose window contains
 * `now` and whose last activity is within 5h.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
const DEFAULT_BLOCK_HOURS = 5;
const SYNTHETIC_MODEL = '<synthetic>';
const DEFAULT_PRICING_PATH = path.join(__dirname, 'data', 'model-pricing.json');
const PARSE_CONCURRENCY = 4;
// Burn-rate floor: below one minute of activity a rate is meaningless noise
// and risks divide-by-~zero projections.
const MIN_BURN_WINDOW_MS = 60 * 1000;
// Transcript metadata is artifact INPUT, not trusted data. Model ids and
// opaque ids are validated against conservative charsets at extraction so a
// poisoned/corrupt transcript cannot smuggle newlines, ANSI escapes, or other
// control bytes into rendered output, JSON keys, or dedup keys. Entries whose
// model fails the charset keep their real token counts under a quarantine
// sentinel (visible + unpriced) rather than vanishing from totals.
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._@:/-]{0,127}$/;
const OPAQUE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const INVALID_MODEL = '(invalid-model)';
// A pricing row must carry ALL five rates as finite non-negative numbers;
// anything else is rejected at load (fail-visible) instead of zero-filled —
// a zero-filled rate silently prices a high-burn block at $0.
const REQUIRED_RATES = ['input', 'output', 'cache_write_5m', 'cache_write_1h', 'cache_read'];

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Candidate transcript roots, in priority order. All existing candidates are
 * scanned (a rig can have both legacy and XDG layouts). Missing candidates are
 * normal; failures that prevent determining whether a root exists are counted
 * in the optional diagnostics accumulator so callers can expose partial scans.
 */
function defaultProjectDirs(env, diagnostics) {
  const e = env || process.env;
  const diag = diagnostics || {};
  if (!Number.isInteger(diag.rootFailures) || diag.rootFailures < 0) diag.rootFailures = 0;
  const candidates = [];
  if (e.CLAUDE_CONFIG_DIR) candidates.push(path.join(e.CLAUDE_CONFIG_DIR, 'projects'));
  const home = e.HOME || e.USERPROFILE || os.homedir();
  candidates.push(path.join(home, '.claude', 'projects'));
  candidates.push(path.join(home, '.config', 'claude', 'projects'));
  const seen = new Set();
  const dirs = [];
  for (const c of candidates) {
    let real;
    try {
      real = fs.realpathSync(c);
    } catch (error) {
      if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) continue;
      diag.rootFailures = (diag.rootFailures || 0) + 1;
      continue;
    }
    if (seen.has(real)) continue;
    seen.add(real);
    try {
      if (fs.statSync(real).isDirectory()) dirs.push(real);
      else diag.rootFailures++;
    } catch {
      diag.rootFailures = (diag.rootFailures || 0) + 1;
    }
  }
  return dirs;
}

/**
 * Recursively find `*.jsonl` files under the given roots.
 * `opts.sinceMs` prefilters by mtime: an append-only transcript whose mtime is
 * older than `sinceMs` cannot contain entries newer than that, so it is
 * skipped without being opened (this is what keeps gate mode fast).
 *
 * Returns { files, candidatesTotal, skippedByMtime, unreadableDirs,
 * statFailures } where files carry { path, mtimeMs, sizeBytes }. Unreadable
 * subdirectories and stat failures are skipped but COUNTED — a partial scan
 * must be visible to callers, never silent.
 */
function discoverTranscriptFiles(dirs, opts) {
  const sinceMs = opts && Number.isFinite(opts.sinceMs) ? opts.sinceMs : null;
  const files = [];
  let candidatesTotal = 0;
  let skippedByMtime = 0;
  let unreadableDirs = 0;
  let statFailures = 0;
  const stack = [...dirs];
  while (stack.length) {
    const dir = stack.pop();
    let dirents;
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      unreadableDirs++; // skip, but surface in diagnostics
      continue;
    }
    for (const d of dirents) {
      if (d.isSymbolicLink()) continue;
      const p = path.join(dir, d.name);
      if (d.isDirectory()) {
        stack.push(p);
      } else if (d.isFile() && d.name.endsWith('.jsonl')) {
        candidatesTotal++;
        let st;
        try {
          st = fs.statSync(p);
        } catch {
          statFailures++;
          continue;
        }
        if (sinceMs != null && st.mtimeMs < sinceMs) {
          skippedByMtime++;
          continue;
        }
        files.push({ path: p, mtimeMs: st.mtimeMs, sizeBytes: st.size });
      }
    }
  }
  return { files, candidatesTotal, skippedByMtime, unreadableDirs, statFailures };
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function safeTokenCount(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
}

/**
 * Extract the billing-relevant fields from one parsed JSONL object, or return
 * null if the entry does not carry usage (non-assistant types, synthetic
 * models, malformed shapes).
 *
 * PRIVACY: this is the single point where transcript objects are read. Only
 * the fields below are copied out; `message.content` and all other fields are
 * structurally dropped.
 */
function extractEntry(raw) {
  if (!raw || typeof raw !== 'object' || raw.type !== 'assistant') return null;
  const msg = raw.message;
  if (!msg || typeof msg !== 'object') return null;
  let model = typeof msg.model === 'string' ? msg.model : null;
  if (!model || model === SYNTHETIC_MODEL) return null;
  // Charset quarantine (see MODEL_ID_RE): hostile/corrupt model strings keep
  // their real token counts under a visible sentinel — never rendered verbatim.
  if (!MODEL_ID_RE.test(model)) model = INVALID_MODEL;
  const u = msg.usage;
  if (!u || typeof u !== 'object') return null;
  const ts = typeof raw.timestamp === 'string' ? Date.parse(raw.timestamp) : NaN;
  if (!Number.isFinite(ts)) return null;

  const cc = u.cache_creation && typeof u.cache_creation === 'object' ? u.cache_creation : null;
  const has5m = cc && typeof cc.ephemeral_5m_input_tokens === 'number'
    && Number.isFinite(cc.ephemeral_5m_input_tokens);
  const has1h = cc && typeof cc.ephemeral_1h_input_tokens === 'number'
    && Number.isFinite(cc.ephemeral_1h_input_tokens);

  return {
    ts,
    model,
    messageId: typeof msg.id === 'string' && OPAQUE_ID_RE.test(msg.id) ? msg.id : null,
    requestId: typeof raw.requestId === 'string' && OPAQUE_ID_RE.test(raw.requestId) ? raw.requestId : null,
    sessionId: typeof raw.sessionId === 'string' && OPAQUE_ID_RE.test(raw.sessionId) ? raw.sessionId : null,
    isSidechain: raw.isSidechain === true,
    input: safeTokenCount(u.input_tokens),
    output: safeTokenCount(u.output_tokens),
    cacheCreate: safeTokenCount(u.cache_creation_input_tokens),
    cacheRead: safeTokenCount(u.cache_read_input_tokens),
    cache5m: has5m ? Math.max(0, cc.ephemeral_5m_input_tokens) : null,
    cache1h: has1h ? Math.max(0, cc.ephemeral_1h_input_tokens) : null,
  };
}

/**
 * Stream-parse one transcript file line-by-line (never loads the whole file).
 * Malformed / partial lines are counted and skipped, never thrown. File-level
 * read failures (EACCES, vanished-during-scan, mid-read I/O errors) settle the
 * promise exactly once with `fileError` set. Both the stream AND the
 * readline.Interface emit 'error' for input failures — an unhandled rl
 * 'error' crashes the process (uncaught exit 1), violating the exit contract.
 */
function parseTranscriptFile(filePath) {
  return new Promise((resolve) => {
    const entries = [];
    let parseErrors = 0;
    let settled = false;
    const settle = (fileError) => {
      if (settled) return;
      settled = true;
      resolve({ entries, parseErrors, fileError: fileError || null });
    };
    let stream;
    try {
      stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    } catch (e) {
      settle(`open failed: ${e.message}`);
      return;
    }
    stream.on('error', (e) => settle(`read failed: ${e.message}`));
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on('error', (e) => settle(`read failed: ${e.message}`));
    rl.on('line', (line) => {
      if (settled) return;
      if (!line || line.charCodeAt(0) !== 123 /* '{' */) {
        if (line && line.trim() !== '') parseErrors++;
        return;
      }
      let raw;
      try {
        raw = JSON.parse(line);
      } catch {
        parseErrors++; // malformed or truncated (partial last line) — skip
        return;
      }
      const entry = extractEntry(raw);
      if (entry) entries.push(entry);
    });
    rl.on('close', () => settle(null));
  });
}

/** Run `fn` over `items` with bounded concurrency, preserving result order. */
async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  const workers = [];
  const n = Math.max(1, Math.min(limit, items.length));
  for (let i = 0; i < n; i++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

/**
 * Discover, parse and dedup usage entries.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.dirs]     Transcript roots (default: defaultProjectDirs()).
 * @param {number}   [opts.sinceMs]  mtime prefilter for discovery (perf only).
 * @param {object}   [opts.env]      env override for defaultProjectDirs.
 * @returns {Promise<{entries, filesScanned, candidatesTotal, skippedByMtime,
 *                    parseErrors, fileReadErrors, unreadableDirs, statFailures,
 *                    rootFailures,
 *                    totalBytes}>}
 *          entries are deduped on (messageId, requestId) — last timestamp
 *          wins — and sorted by timestamp ascending. The diagnostic counters
 *          (parseErrors / fileReadErrors / unreadableDirs / statFailures /
 *          rootFailures) let callers distinguish "idle" from "partially or
 *          fully unreadable" — the gate's fail-visible contract depends on them.
 * @throws  {Error & {code:'ENOTRANSCRIPTS'}} when no transcript files exist at
 *          all (unreadable rig — callers surface this as exit 2). An empty
 *          result after mtime filtering is NOT an error (idle rig).
 */
async function loadEntries(opts) {
  const o = opts || {};
  const explicitDirs = o.dirs && o.dirs.length ? o.dirs : null;
  const rootDiagnostics = { rootFailures: 0 };
  const dirs = explicitDirs || defaultProjectDirs(o.env, rootDiagnostics);
  const rootFailures = explicitDirs ? 0 : rootDiagnostics.rootFailures;
  if (!dirs.length) {
    const suffix = rootFailures ? `; ${rootFailures} candidate root(s) unreadable` : '';
    const err = new Error(`no Claude transcript directory found (looked for ~/.claude/projects)${suffix}`);
    err.code = 'ENOTRANSCRIPTS';
    throw err;
  }
  const { files, candidatesTotal, skippedByMtime, unreadableDirs, statFailures } = discoverTranscriptFiles(dirs, o);
  if (candidatesTotal === 0) {
    const failures = [];
    if (rootFailures) failures.push(`${rootFailures} root failure(s)`);
    if (unreadableDirs) failures.push(`${unreadableDirs} unreadable dir(s)`);
    if (statFailures) failures.push(`${statFailures} stat failure(s)`);
    const suffix = failures.length ? `; discovery failures: ${failures.join(', ')}` : '';
    const err = new Error(`no .jsonl transcripts found under: ${dirs.join(', ')}${suffix}`);
    err.code = 'ENOTRANSCRIPTS';
    throw err;
  }

  const parsed = await mapPool(files, PARSE_CONCURRENCY, (f) => parseTranscriptFile(f.path));

  const byKey = new Map();
  const unkeyed = [];
  let parseErrors = 0;
  let fileReadErrors = 0;
  for (const res of parsed) {
    parseErrors += res.parseErrors;
    if (res.fileError) fileReadErrors++;
    for (const e of res.entries) {
      if (e.messageId) {
        const key = `${e.messageId}\u0000${e.requestId || ''}`;
        const prev = byKey.get(key);
        if (!prev || e.ts >= prev.ts) byKey.set(key, e);
      } else {
        unkeyed.push(e); // no messageId — nothing to dedup on
      }
    }
  }
  const entries = [...byKey.values(), ...unkeyed].sort((a, b) => a.ts - b.ts);
  const totalBytes = files.reduce((s, f) => s + f.sizeBytes, 0);
  return {
    entries,
    filesScanned: files.length,
    candidatesTotal,
    skippedByMtime,
    parseErrors,
    fileReadErrors,
    unreadableDirs,
    statFailures,
    rootFailures,
    totalBytes,
  };
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

/**
 * Load the pricing config. Resolution order: opts.path, then the
 * FORGE_USAGE_PRICING env var (operator override hook), then the shipped
 * lib/data/model-pricing.json. Never throws: an unreadable/invalid config
 * returns `{ models: {}, error }` so token counting still works — callers
 * surface the degradation.
 *
 * Every row is validated: all five REQUIRED_RATES must be finite non-negative
 * numbers. Invalid rows are REJECTED (listed in `rowErrors`, models becomes
 * unpriced-and-flagged downstream) — never zero-filled, because a zero-filled
 * rate silently prices a high-burn block at $0 (a lying gate).
 */
function loadPricing(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const p = o.path || env.FORGE_USAGE_PRICING || DEFAULT_PRICING_PATH;
  const empty = { models: Object.create(null), rowErrors: [], as_of: null, source: null, path: p };
  try {
    const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!doc || typeof doc !== 'object' || !doc.models || typeof doc.models !== 'object') {
      return { ...empty, error: `pricing config at ${p} has no "models" object` };
    }
    const models = Object.create(null);
    const rowErrors = [];
    for (const [key, row] of Object.entries(doc.models)) {
      if (!row || typeof row !== 'object') {
        rowErrors.push(`${key}: not an object`);
        continue;
      }
      const bad = REQUIRED_RATES.filter(
        (r) => !(typeof row[r] === 'number' && Number.isFinite(row[r]) && row[r] >= 0)
      );
      if (bad.length) {
        rowErrors.push(`${key}: invalid/missing rate(s): ${bad.join(', ')}`);
        continue;
      }
      models[key] = row;
    }
    return { models, rowErrors, as_of: doc.as_of || null, source: doc.source || null, error: null, path: p };
  } catch (e) {
    return { ...empty, error: `pricing config unreadable at ${p}: ${e.message}` };
  }
}

/**
 * Longest-prefix match of a model id against the pricing table keys.
 * Exact match is the longest possible prefix, so it wins naturally.
 * Returns the rate object or null (unpriced model).
 */
function resolveModelPricing(pricing, model) {
  if (!pricing || !pricing.models || typeof model !== 'string') return null;
  let best = null;
  let bestLen = -1;
  for (const key of Object.keys(pricing.models)) {
    if (model.startsWith(key) && key.length > bestLen) {
      best = pricing.models[key];
      bestLen = key.length;
    }
  }
  return best;
}

function rate(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
}

/**
 * Estimated USD cost of one entry. When the 5m/1h cache-creation split is
 * present it is priced per tier; otherwise the blended
 * cache_creation_input_tokens falls back to the 5m rate (may underestimate
 * 1h-TTL-heavy sessions — this rig's recent entries carry the split).
 * Returns { costUSD, unpriced } — unpriced=true means no table row matched
 * and the entry contributed $0 (token counts are still real).
 */
function entryCostUSD(entry, pricing) {
  const p = resolveModelPricing(pricing, entry.model);
  if (!p) return { costUSD: 0, unpriced: true };
  const M = 1e6;
  let cacheCreateCost;
  if (entry.cache5m != null || entry.cache1h != null) {
    cacheCreateCost = ((entry.cache5m || 0) / M) * rate(p.cache_write_5m)
      + ((entry.cache1h || 0) / M) * rate(p.cache_write_1h);
  } else {
    cacheCreateCost = (entry.cacheCreate / M) * rate(p.cache_write_5m);
  }
  const costUSD = (entry.input / M) * rate(p.input)
    + (entry.output / M) * rate(p.output)
    + cacheCreateCost
    + (entry.cacheRead / M) * rate(p.cache_read);
  return { costUSD, unpriced: false };
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

function emptyTokens() {
  return { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, total: 0 };
}

function addTokens(acc, e) {
  // Token totals deliberately sum the blended cache_creation_input_tokens,
  // while entryCostUSD prices the 5m/1h split when present. If the API's
  // blended field ever disagreed with (5m + 1h), totals and cost would
  // diverge by that delta — accepted: totals mirror the raw field, cost
  // uses the finest tier data available.
  acc.input += e.input;
  acc.output += e.output;
  acc.cacheCreate += e.cacheCreate;
  acc.cacheRead += e.cacheRead;
  acc.total += e.input + e.output + e.cacheCreate + e.cacheRead;
  return acc;
}

function sumTokens(entries) {
  const acc = emptyTokens();
  for (const e of entries) addTokens(acc, e);
  return acc;
}

/**
 * Roll a list of entries into { tokens, costUSD, unpricedModels, models }
 * where models maps model id -> { tokens, costUSD, entryCount }.
 */
function rollup(entries, pricing) {
  const tokens = emptyTokens();
  // Null prototype: model ids are artifact input — "__proto__" as a model
  // name must be a plain own key, never prototype pollution.
  const models = Object.create(null);
  const unpriced = new Set();
  let costUSD = 0;
  for (const e of entries) {
    addTokens(tokens, e);
    const { costUSD: c, unpriced: u } = entryCostUSD(e, pricing);
    costUSD += c;
    if (u) unpriced.add(e.model);
    let m = models[e.model];
    if (!m) {
      m = models[e.model] = { tokens: emptyTokens(), costUSD: 0, entryCount: 0 };
    }
    addTokens(m.tokens, e);
    m.costUSD += c;
    m.entryCount++;
  }
  return { tokens, costUSD, unpricedModels: [...unpriced].sort(), models, entryCount: entries.length };
}

/**
 * Local-day key for a timestamp. `tzOffsetMinutes` is minutes EAST of UTC
 * (UTC-7 => -420). When omitted, the rig's own offset for that instant is
 * used (DST-correct via Date#getTimezoneOffset).
 */
function dayKey(ts, tzOffsetMinutes) {
  const off = tzOffsetMinutes != null ? tzOffsetMinutes : -new Date(ts).getTimezoneOffset();
  return new Date(ts + off * 60 * 1000).toISOString().slice(0, 10);
}

function monthKey(ts, tzOffsetMinutes) {
  return dayKey(ts, tzOffsetMinutes).slice(0, 7);
}

function aggregateByKey(entries, keyFn, pricing) {
  const groups = new Map();
  for (const e of entries) {
    const k = keyFn(e);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  const out = [];
  for (const [key, group] of groups) out.push({ key, ...rollup(group, pricing) });
  return out;
}

/** Daily buckets, ascending by date. */
function aggregateDaily(entries, opts) {
  const o = opts || {};
  return aggregateByKey(entries, (e) => dayKey(e.ts, o.tzOffsetMinutes), o.pricing)
    .sort((a, b) => (a.key < b.key ? -1 : 1));
}

/** Monthly buckets, ascending by month. */
function aggregateMonthly(entries, opts) {
  const o = opts || {};
  return aggregateByKey(entries, (e) => monthKey(e.ts, o.tzOffsetMinutes), o.pricing)
    .sort((a, b) => (a.key < b.key ? -1 : 1));
}

/**
 * Per-session rollup (subagent entries carry the parent sessionId, so their
 * usage rolls into the parent session). Newest-activity first.
 */
function aggregateSessions(entries, opts) {
  const o = opts || {};
  const bySession = new Map();
  for (const e of entries) {
    const k = e.sessionId || '(unknown)';
    let s = bySession.get(k);
    if (!s) {
      s = { entries: [], firstTs: e.ts, lastTs: e.ts, sidechainEntries: 0 };
      bySession.set(k, s);
    }
    s.entries.push(e);
    if (e.ts < s.firstTs) s.firstTs = e.ts;
    if (e.ts > s.lastTs) s.lastTs = e.ts;
    if (e.isSidechain) s.sidechainEntries++;
  }
  const out = [];
  for (const [sessionId, s] of bySession) {
    out.push({
      sessionId,
      firstTs: s.firstTs,
      lastTs: s.lastTs,
      sidechainEntries: s.sidechainEntries,
      ...rollup(s.entries, o.pricing),
    });
  }
  out.sort((a, b) => b.lastTs - a.lastTs);
  return typeof o.limit === 'number' && o.limit > 0 ? out.slice(0, o.limit) : out;
}

// ---------------------------------------------------------------------------
// 5-hour billing blocks
// ---------------------------------------------------------------------------

function floorToUTCHour(ms) {
  return ms - (ms % HOUR_MS);
}

/**
 * Bucket entries (sorted ascending) into 5h billing blocks. See the header
 * for the algorithm. `now` is injectable for deterministic tests.
 * Returns blocks: { startMs, endMs, firstTs, lastTs, entries, isActive }.
 */
function identifyBlocks(entries, opts) {
  const o = opts || {};
  const blockMs = (o.blockHours || DEFAULT_BLOCK_HOURS) * HOUR_MS;
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const blocks = [];
  let cur = null;
  for (const e of entries) {
    // New block when past the current window OR after a >=blockMs activity
    // gap. PROOF the gap predicate is subsumed (kept only as ccusage-spec
    // parity + defense-in-depth if start-flooring ever changes): with
    // startMs = floor(firstTs) <= firstTs <= lastTs, a gap e.ts - lastTs >=
    // blockMs implies e.ts >= lastTs + blockMs >= startMs + blockMs, i.e.
    // the window predicate already fired. No input can exercise the gap
    // predicate independently, so no test can discriminate it.
    if (!cur || e.ts >= cur.startMs + blockMs || e.ts - cur.lastTs >= blockMs) {
      cur = { startMs: floorToUTCHour(e.ts), firstTs: e.ts, lastTs: e.ts, entries: [] };
      blocks.push(cur);
    }
    cur.entries.push(e);
    cur.lastTs = e.ts;
  }
  for (const b of blocks) {
    b.endMs = b.startMs + blockMs;
    // The recency conjunct (now - lastTs < blockMs) is likewise implied by
    // the window conjuncts: lastTs >= startMs and now < endMs give
    // now - lastTs <= now - startMs < blockMs. Kept for spec parity /
    // defense-in-depth; not independently testable.
    b.isActive = now >= b.startMs && now < b.endMs && now - b.lastTs < blockMs;
  }
  return blocks;
}

/**
 * Burn rate + projection for one block.
 * Burn window = firstTs -> now for the active block, firstTs -> lastTs for
 * closed blocks, floored at 1 minute. Projection (active only) extrapolates
 * the observed rate over the remaining window:
 *   projectedCostUSD = costUSD + costPerHour * remainingHours.
 */
function blockStats(block, opts) {
  const o = opts || {};
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const roll = rollup(block.entries, o.pricing);
  const effectiveEnd = block.isActive ? now : block.lastTs;
  const burnWindowMs = Math.max(effectiveEnd - block.firstTs, MIN_BURN_WINDOW_MS);
  const tokensPerMinute = roll.tokens.total / (burnWindowMs / 60000);
  const costPerHour = roll.costUSD / (burnWindowMs / HOUR_MS);
  const remainingMs = block.isActive ? Math.max(0, block.endMs - now) : 0;
  return {
    ...roll,
    startMs: block.startMs,
    endMs: block.endMs,
    firstTs: block.firstTs,
    lastTs: block.lastTs,
    isActive: block.isActive,
    burnWindowMs,
    tokensPerMinute,
    costPerHour,
    remainingMs,
    elapsedMs: block.isActive ? Math.max(0, now - block.startMs) : block.lastTs - block.startMs,
    projectedCostUSD: block.isActive ? roll.costUSD + costPerHour * (remainingMs / HOUR_MS) : null,
    projectedTokens: block.isActive
      ? Math.round(roll.tokens.total + tokensPerMinute * (remainingMs / 60000))
      : null,
  };
}

// ---------------------------------------------------------------------------
// Formatting helpers (shared by bin + tests)
// ---------------------------------------------------------------------------

/** "claude-fable-5" -> "fable-5" (display only). */
function shortModel(model) {
  return typeof model === 'string' ? model.replace(/^claude-/, '') : String(model);
}

function formatTokens(n) {
  if (!Number.isFinite(n)) return '0';
  const abs = Math.abs(n);
  if (abs >= 1e6) return `${(n / 1e6).toFixed(abs >= 1e8 ? 0 : 2)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(abs >= 1e5 ? 0 : 1)}k`;
  return String(Math.round(n));
}

function formatUSD(n) {
  if (!Number.isFinite(n)) return '$0.00';
  const abs = Math.abs(n);
  if (abs >= 100) return `$${n.toFixed(0)}`;
  if (abs >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(4)}`;
}

function formatDurationMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`;
  if (totalMin > 0) return `${m}m`;
  return `${Math.floor(ms / 1000)}s`;
}

module.exports = {
  HOUR_MS,
  DAY_MS,
  DEFAULT_BLOCK_HOURS,
  DEFAULT_PRICING_PATH,
  INVALID_MODEL,
  defaultProjectDirs,
  discoverTranscriptFiles,
  extractEntry,
  parseTranscriptFile,
  loadEntries,
  loadPricing,
  resolveModelPricing,
  entryCostUSD,
  sumTokens,
  rollup,
  dayKey,
  monthKey,
  aggregateDaily,
  aggregateMonthly,
  aggregateSessions,
  floorToUTCHour,
  identifyBlocks,
  blockStats,
  shortModel,
  formatTokens,
  formatUSD,
  formatDurationMs,
};
