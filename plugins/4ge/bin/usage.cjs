#!/usr/bin/env node
'use strict';

// usage.cjs — Local usage/cost analytics CLI over Claude Code transcripts.
//
// Plugin-native replacement for the external `ccusage` CLI (which failed
// `command not found` on a hard pre-dispatch burn gate). All parsing, block
// math and pricing live in ../lib/usage-meter.cjs; this file is arg parsing +
// plain-monospace rendering only.
//
// OUTPUT CONTRACT: plain monospace text, NO ANSI (command-surface rule, same
// as forge-status.cjs). All costs are ESTIMATES from a local pricing config
// (lib/data/model-pricing.json; override via FORGE_USAGE_PRICING) — every
// human surface says so.
//
// SUBCOMMANDS
//   blocks  [--active] [--limit N]     5-hour billing blocks (ccusage parity)
//   daily   [--since D] [--until D]    per-day rollup (default: last 14 days)
//   monthly                            per-month rollup (full history scan)
//   session [--limit N] [--all]        per-session rollup, newest first
//   gate                               one-line pre-dispatch burn gate
//
// GLOBAL FLAGS
//   --json          machine output
//   --breakdown     per-model rows on any report
//   --dir <path>    transcript root override (repeatable; default ~/.claude/projects)
//   --now <ISO>     clock override (deterministic tests)
//   --tz <minutes>  day-bucket offset, minutes east of UTC (default: rig-local)
//   --all           lift default lookbacks (session/daily full history)
//
// EXIT CODES
//   0  data readable (including "no active block")
//   1  bad arguments
//   2  transcripts unreadable / no transcript files, or (gate) zero usable
//      entries alongside read/parse failures — idle and corrupt must never
//      be confusable (fail-visible for hooks)
//
// INJECTION POSTURE: transcript metadata is artifact input. The lib
// charset-quarantines model/ids at extraction; this bin additionally strips
// control/ANSI/newline bytes from every entry-derived string it renders, so
// the gate's one-physical-line contract holds even against a poisoned file.

const meter = require('../lib/usage-meter.cjs');

const GATE_LOOKBACK_HOURS = 30; // covers the active block plus any <5h-gap chain feeding it
const DAILY_DEFAULT_DAYS = 14;
const SESSION_LOOKBACK_DAYS = 45;

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const flags = {
    json: false,
    breakdown: false,
    active: false,
    all: false,
    since: null,
    until: null,
    limit: null,
    dirs: [],
    now: null,
    tz: null,
  };
  let cmd = null;
  const errors = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') flags.json = true;
    else if (a === '--breakdown') flags.breakdown = true;
    else if (a === '--active') flags.active = true;
    else if (a === '--all') flags.all = true;
    else if (a === '--since' || a === '--until' || a === '--limit' || a === '--dir' || a === '--now' || a === '--tz') {
      const v = argv[++i];
      if (v == null) { errors.push(`${a} requires a value`); continue; }
      if (a === '--since') flags.since = normalizeDate(v, errors, a);
      else if (a === '--until') flags.until = normalizeDate(v, errors, a);
      else if (a === '--limit') {
        const n = Number(v);
        if (Number.isInteger(n) && n > 0) flags.limit = n;
        else errors.push(`--limit expects a positive integer, got "${v}"`);
      } else if (a === '--dir') flags.dirs.push(v);
      else if (a === '--now') {
        const t = Date.parse(v);
        if (Number.isFinite(t)) flags.now = t;
        else errors.push(`--now expects an ISO timestamp, got "${v}"`);
      } else if (a === '--tz') {
        const n = Number(v);
        if (Number.isInteger(n) && n >= -12 * 60 && n <= 14 * 60) flags.tz = n;
        else errors.push(`--tz expects minutes east of UTC (-720..840), got "${v}"`);
      }
    } else if (a.startsWith('--')) errors.push(`unknown flag: ${a}`);
    else if (!cmd) cmd = a;
    else errors.push(`unexpected argument: ${a}`);
  }
  if (flags.since && flags.until && flags.until < flags.since) {
    errors.push(`--until (${flags.until}) must not be before --since (${flags.since})`);
  }
  return { cmd, flags, errors };
}

/**
 * Accept YYYYMMDD or YYYY-MM-DD; normalize to YYYY-MM-DD for key compare.
 * Round-trips through a UTC date so calendar-invalid input (2026-02-31)
 * fails loudly instead of silently changing the filter.
 */
function normalizeDate(v, errors, flagName) {
  const m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(v);
  if (!m) {
    errors.push(`${flagName} expects YYYYMMDD or YYYY-MM-DD, got "${v}"`);
    return null;
  }
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    errors.push(`${flagName} is not a real calendar date: "${v}"`);
    return null;
  }
  return `${m[1]}-${m[2]}-${m[3]}`;
}

// ---------------------------------------------------------------------------
// Rendering helpers (plain monospace, no ANSI)
// ---------------------------------------------------------------------------

const out = (s) => process.stdout.write(s + '\n');
const errOut = (s) => process.stderr.write(s + '\n');

/**
 * Strip control bytes (incl. ESC/ANSI intro, CR/LF, C1 range, line/para
 * separators) from entry-derived strings before rendering. Second layer
 * behind the lib's extraction charset quarantine.
 */
function sanitizeText(s) {
  return String(s).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '');
}

function pad(s, w) {
  s = String(s);
  return s.length >= w ? s : s + ' '.repeat(w - s.length);
}

function rpad(s, w) {
  s = String(s);
  return s.length >= w ? s : ' '.repeat(w - s.length) + s;
}

function tokenCols(tokens) {
  return [
    rpad(meter.formatTokens(tokens.input), 8),
    rpad(meter.formatTokens(tokens.output), 8),
    rpad(meter.formatTokens(tokens.cacheCreate), 9),
    rpad(meter.formatTokens(tokens.cacheRead), 9),
    rpad(meter.formatTokens(tokens.total), 9),
  ].join(' ');
}

const TOKEN_HEADER = `${rpad('input', 8)} ${rpad('output', 8)} ${rpad('cache+', 9)} ${rpad('cache>', 9)} ${rpad('total', 9)}`;

function renderBreakdownRows(models, indent) {
  const rows = [];
  const names = Object.keys(models).sort((a, b) => models[b].tokens.total - models[a].tokens.total);
  for (const name of names) {
    const m = models[name];
    rows.push(`${indent}${pad(sanitizeText(meter.shortModel(name)), 14)} ${tokenCols(m.tokens)} ${rpad(meter.formatUSD(m.costUSD), 9)}`);
  }
  return rows;
}

function estimateFooter(pricing, extra) {
  const lines = [];
  const asOf = pricing.as_of ? ` (pricing as_of ${pricing.as_of})` : '';
  lines.push(`  costs are ESTIMATES from local pricing config${asOf} — override: FORGE_USAGE_PRICING`);
  if (pricing.error) lines.push(`  WARNING: ${pricing.error} — token counts only, all costs $0`);
  if (pricing.rowErrors && pricing.rowErrors.length) {
    lines.push(`  WARNING: invalid pricing row(s) rejected: ${pricing.rowErrors.join('; ')} — affected models priced $0`);
  }
  if (extra) lines.push(extra);
  return lines;
}

function unpricedWarning(buckets) {
  const models = new Set();
  for (const b of buckets) for (const m of b.unpricedModels || []) models.add(m);
  return models.size
    ? `  WARNING: no pricing row for: ${[...models].map((m) => sanitizeText(m)).join(', ')} — their cost counted as $0`
    : null;
}

/** One-line scan-health summary for human reports; null when clean. */
function scanDiagnostics(loaded) {
  const parts = [];
  if (loaded.parseErrors) parts.push(`${loaded.parseErrors} parse-skips`);
  if (loaded.fileReadErrors) parts.push(`${loaded.fileReadErrors} unreadable files`);
  if (loaded.unreadableDirs) parts.push(`${loaded.unreadableDirs} unreadable dirs`);
  if (loaded.statFailures) parts.push(`${loaded.statFailures} stat failures`);
  if (loaded.rootFailures) parts.push(`${loaded.rootFailures} root failures`);
  return parts.length ? `  scan diagnostics: ${parts.join(' · ')}` : null;
}

function scanFailureCount(loaded) {
  return loaded.parseErrors + loaded.fileReadErrors + loaded.unreadableDirs
    + loaded.statFailures + (loaded.rootFailures || 0);
}

/** Exit 2 when scan failures leave no usable entry to distinguish idle from corrupt. */
function failVisibleScanExit(loaded, command) {
  if (loaded.entries.length > 0 || scanFailureCount(loaded) === 0) return null;
  errOut(`usage.cjs: ${command} degraded — 0 usable entries with ${loaded.parseErrors} parse error(s), `
    + `${loaded.fileReadErrors} unreadable file(s), ${loaded.unreadableDirs} unreadable dir(s), `
    + `${loaded.statFailures} stat failure(s), ${loaded.rootFailures || 0} root failure(s); `
    + 'cannot distinguish idle from corrupt');
  return 2;
}

function jsonMeta(loaded, pricing, now) {
  return {
    generatedAt: new Date(now).toISOString(),
    estimate: true,
    pricingAsOf: pricing.as_of,
    pricingError: pricing.error,
    pricingRowErrors: pricing.rowErrors || [],
    filesScanned: loaded.filesScanned,
    skippedByMtime: loaded.skippedByMtime,
    parseErrors: loaded.parseErrors,
    fileReadErrors: loaded.fileReadErrors,
    unreadableDirs: loaded.unreadableDirs,
    statFailures: loaded.statFailures,
    rootFailures: loaded.rootFailures,
  };
}

// Rounds costs for JSON output (6 decimals — sub-cent estimate precision).
function usd(n) {
  return n == null ? null : Math.round(n * 1e6) / 1e6;
}

function modelsJson(models) {
  const o = Object.create(null); // model ids are artifact input — see sanitizeText
  for (const [k, v] of Object.entries(models)) {
    o[k] = { tokens: v.tokens, costUSD: usd(v.costUSD), entryCount: v.entryCount };
  }
  return o;
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

async function cmdBlocks(flags) {
  const now = flags.now != null ? flags.now : Date.now();
  const sinceMs = flags.active ? now - GATE_LOOKBACK_HOURS * meter.HOUR_MS : undefined;
  const loaded = await meter.loadEntries({ dirs: flags.dirs, sinceMs });
  const scanExit = failVisibleScanExit(loaded, 'blocks');
  if (scanExit != null) return scanExit;
  const pricing = meter.loadPricing();
  const blocks = meter.identifyBlocks(loaded.entries, { now });
  let stats = blocks.map((b) => meter.blockStats(b, { now, pricing }));
  if (flags.active) stats = stats.filter((s) => s.isActive);
  else {
    const limit = flags.limit || 12;
    stats = stats.slice(-limit);
  }

  if (flags.json) {
    out(JSON.stringify({
      blocks: stats.map((s) => ({
        start: new Date(s.startMs).toISOString(),
        end: new Date(s.endMs).toISOString(),
        firstActivity: new Date(s.firstTs).toISOString(),
        lastActivity: new Date(s.lastTs).toISOString(),
        isActive: s.isActive,
        entryCount: s.entryCount,
        tokens: s.tokens,
        costUSD: usd(s.costUSD),
        tokensPerMinute: Math.round(s.tokensPerMinute),
        costPerHour: usd(s.costPerHour),
        remainingMs: s.remainingMs,
        projectedCostUSD: usd(s.projectedCostUSD),
        projectedTokens: s.projectedTokens,
        unpricedModels: s.unpricedModels,
        models: modelsJson(s.models),
      })),
      meta: jsonMeta(loaded, pricing, now),
    }, null, 2));
    return 0;
  }

  out('5-hour billing blocks (UTC-floored starts)');
  if (!stats.length) {
    out(flags.active
      ? `  no active block — no entries in the last ${GATE_LOOKBACK_HOURS}h window`
      : '  no blocks found');
    const diag = scanDiagnostics(loaded);
    if (diag) out(diag);
    for (const l of estimateFooter(pricing)) out(l);
    return 0;
  }
  out(`  ${pad('block start (UTC)', 18)} ${pad('span', 7)} ${TOKEN_HEADER} ${rpad('est cost', 9)}  state`);
  for (const s of stats) {
    const startLabel = new Date(s.startMs).toISOString().slice(0, 16).replace('T', ' ');
    const state = s.isActive
      ? `ACTIVE ${meter.formatDurationMs(s.remainingMs)} left, proj ${meter.formatUSD(s.projectedCostUSD)}`
      : '';
    out(`  ${pad(startLabel, 18)} ${pad(meter.formatDurationMs(s.lastTs - s.firstTs), 7)} ${tokenCols(s.tokens)} ${rpad(meter.formatUSD(s.costUSD), 9)}  ${state}`);
    // --active is the gate's detail view: always show the per-model split there
    if (flags.breakdown || flags.active) for (const row of renderBreakdownRows(s.models, '    ')) out(row);
    if (s.isActive) {
      out(`    burn ${meter.formatTokens(s.tokensPerMinute)} tok/min · ${meter.formatUSD(s.costPerHour)}/hr est · elapsed ${meter.formatDurationMs(s.elapsedMs)} · ends ${new Date(s.endMs).toISOString().slice(11, 16)}Z`);
    }
  }
  const warn = unpricedWarning(stats);
  if (warn) out(warn);
  const diag = scanDiagnostics(loaded);
  if (diag) out(diag);
  for (const l of estimateFooter(pricing)) out(l);
  return 0;
}

async function cmdDaily(flags) {
  const now = flags.now != null ? flags.now : Date.now();
  const since = flags.since
    || (flags.all ? null : meter.dayKey(now - (DAILY_DEFAULT_DAYS - 1) * meter.DAY_MS, flags.tz));
  // mtime prefilter with a day of slack: a file older than (since - 1d) cannot
  // hold entries on/after `since` (append-only transcripts).
  const sinceMs = since && !flags.all ? Date.parse(since) - meter.DAY_MS : undefined;
  const loaded = await meter.loadEntries({ dirs: flags.dirs, sinceMs });
  const scanExit = failVisibleScanExit(loaded, 'daily');
  if (scanExit != null) return scanExit;
  const pricing = meter.loadPricing();
  let buckets = meter.aggregateDaily(loaded.entries, { pricing, tzOffsetMinutes: flags.tz });
  if (since) buckets = buckets.filter((b) => b.key >= since);
  if (flags.until) buckets = buckets.filter((b) => b.key <= flags.until);

  if (flags.json) {
    out(JSON.stringify({
      daily: buckets.map((b) => ({
        date: b.key,
        entryCount: b.entryCount,
        tokens: b.tokens,
        costUSD: usd(b.costUSD),
        unpricedModels: b.unpricedModels,
        models: modelsJson(b.models),
      })),
      meta: jsonMeta(loaded, pricing, now),
    }, null, 2));
    return 0;
  }

  out(`daily usage${since ? ` since ${since}` : ''}${flags.until ? ` until ${flags.until}` : ''} (local days)`);
  if (!buckets.length) {
    out('  no usage in range');
    const diag = scanDiagnostics(loaded);
    if (diag) out(diag);
    for (const l of estimateFooter(pricing)) out(l);
    return 0;
  }
  out(`  ${pad('date', 11)} ${TOKEN_HEADER} ${rpad('est cost', 9)}`);
  const total = { tokens: meter.sumTokens([]), costUSD: 0 };
  for (const b of buckets) {
    out(`  ${pad(b.key, 11)} ${tokenCols(b.tokens)} ${rpad(meter.formatUSD(b.costUSD), 9)}`);
    if (flags.breakdown) for (const row of renderBreakdownRows(b.models, '    ')) out(row);
    total.tokens.input += b.tokens.input;
    total.tokens.output += b.tokens.output;
    total.tokens.cacheCreate += b.tokens.cacheCreate;
    total.tokens.cacheRead += b.tokens.cacheRead;
    total.tokens.total += b.tokens.total;
    total.costUSD += b.costUSD;
  }
  out(`  ${pad('TOTAL', 11)} ${tokenCols(total.tokens)} ${rpad(meter.formatUSD(total.costUSD), 9)}`);
  const warn = unpricedWarning(buckets);
  if (warn) out(warn);
  const diag = scanDiagnostics(loaded);
  if (diag) out(diag);
  for (const l of estimateFooter(pricing)) out(l);
  return 0;
}

async function cmdMonthly(flags) {
  const now = flags.now != null ? flags.now : Date.now();
  const loaded = await meter.loadEntries({ dirs: flags.dirs }); // full history scan
  const scanExit = failVisibleScanExit(loaded, 'monthly');
  if (scanExit != null) return scanExit;
  const pricing = meter.loadPricing();
  const buckets = meter.aggregateMonthly(loaded.entries, { pricing, tzOffsetMinutes: flags.tz });

  if (flags.json) {
    out(JSON.stringify({
      monthly: buckets.map((b) => ({
        month: b.key,
        entryCount: b.entryCount,
        tokens: b.tokens,
        costUSD: usd(b.costUSD),
        unpricedModels: b.unpricedModels,
        models: modelsJson(b.models),
      })),
      meta: jsonMeta(loaded, pricing, now),
    }, null, 2));
    return 0;
  }

  out('monthly usage (local months, full history)');
  out(`  ${pad('month', 8)} ${TOKEN_HEADER} ${rpad('est cost', 9)}`);
  for (const b of buckets) {
    out(`  ${pad(b.key, 8)} ${tokenCols(b.tokens)} ${rpad(meter.formatUSD(b.costUSD), 9)}`);
    if (flags.breakdown) for (const row of renderBreakdownRows(b.models, '    ')) out(row);
  }
  const warn = unpricedWarning(buckets);
  if (warn) out(warn);
  const diag = scanDiagnostics(loaded);
  if (diag) out(diag);
  for (const l of estimateFooter(pricing)) out(l);
  return 0;
}

async function cmdSession(flags) {
  const now = flags.now != null ? flags.now : Date.now();
  const sinceMs = flags.all ? undefined : now - SESSION_LOOKBACK_DAYS * meter.DAY_MS;
  const loaded = await meter.loadEntries({ dirs: flags.dirs, sinceMs });
  const scanExit = failVisibleScanExit(loaded, 'session');
  if (scanExit != null) return scanExit;
  const pricing = meter.loadPricing();
  const sessions = meter.aggregateSessions(loaded.entries, { pricing, limit: flags.limit || 15 });

  if (flags.json) {
    out(JSON.stringify({
      sessions: sessions.map((s) => ({
        sessionId: s.sessionId,
        firstActivity: new Date(s.firstTs).toISOString(),
        lastActivity: new Date(s.lastTs).toISOString(),
        entryCount: s.entryCount,
        sidechainEntries: s.sidechainEntries,
        tokens: s.tokens,
        costUSD: usd(s.costUSD),
        unpricedModels: s.unpricedModels,
        models: modelsJson(s.models),
      })),
      meta: jsonMeta(loaded, pricing, now),
    }, null, 2));
    return 0;
  }

  out(`sessions, newest first${flags.all ? ' (full history)' : ` (last ${SESSION_LOOKBACK_DAYS} days)`}`);
  out(`  ${pad('session', 9)} ${pad('last activity', 17)} ${TOKEN_HEADER} ${rpad('est cost', 9)}`);
  for (const s of sessions) {
    const id = s.sessionId === '(unknown)' ? s.sessionId : sanitizeText(s.sessionId).slice(0, 8);
    const last = new Date(s.lastTs).toISOString().slice(0, 16).replace('T', ' ');
    out(`  ${pad(id, 9)} ${pad(last, 17)} ${tokenCols(s.tokens)} ${rpad(meter.formatUSD(s.costUSD), 9)}`);
    if (flags.breakdown) for (const row of renderBreakdownRows(s.models, '    ')) out(row);
  }
  const warn = unpricedWarning(sessions);
  if (warn) out(warn);
  const diag = scanDiagnostics(loaded);
  if (diag) out(diag);
  for (const l of estimateFooter(pricing)) out(l);
  return 0;
}

/**
 * gate — one compact line for skill workflows (the pre-dispatch burn gate).
 * The gate must never lie:
 * - Exit 2 when it CANNOT TELL idle from corrupt: zero usable entries while
 *   the scan hit parse/read/stat/dir/root failures (stderr carries the reason;
 *   with --json no JSON is emitted on this path — hooks key off the code).
 * - Otherwise exit 0, with scan/pricing degradation ON the line: parse-skip
 *   and unreadable-file counts always shown when nonzero, unpriced models
 *   named ($0-counted), invalid pricing rows counted.
 * - "DEGRADED" prefixes the line when numbers may be materially wrong: any
 *   whole file/dir/root unreadable, or parse failures rivaling usable entries
 *   (parseErrors >= entries). Baseline calibration: this rig measures ~1% of
 *   FILES with one tail-truncated line (23 errors / 2,416 files) against
 *   thousands of entries — a small nonzero count is normal and shown, not
 *   alarmed on.
 */
async function cmdGate(flags) {
  const now = flags.now != null ? flags.now : Date.now();
  const sinceMs = now - GATE_LOOKBACK_HOURS * meter.HOUR_MS;
  const loaded = await meter.loadEntries({ dirs: flags.dirs, sinceMs });
  const scanExit = failVisibleScanExit(loaded, 'gate');
  if (scanExit != null) return scanExit;
  const pricing = meter.loadPricing();

  const blocks = meter.identifyBlocks(loaded.entries, { now });
  const active = blocks.find((b) => b.isActive) || null;
  const stats = active ? meter.blockStats(active, { now, pricing }) : null;

  const degraded = loaded.fileReadErrors > 0 || loaded.unreadableDirs > 0 || loaded.statFailures > 0
    || loaded.rootFailures > 0
    || (loaded.parseErrors > 0 && loaded.parseErrors >= loaded.entries.length);
  const warnings = [];
  if (loaded.parseErrors > 0) warnings.push(`${loaded.parseErrors} parse-skips`);
  if (loaded.fileReadErrors > 0) warnings.push(`${loaded.fileReadErrors} unreadable files`);
  if (loaded.unreadableDirs > 0) warnings.push(`${loaded.unreadableDirs} unreadable dirs`);
  if (loaded.statFailures > 0) warnings.push(`${loaded.statFailures} stat failures`);
  if (loaded.rootFailures > 0) warnings.push(`${loaded.rootFailures} root failures`);
  if (pricing.rowErrors && pricing.rowErrors.length) warnings.push(`${pricing.rowErrors.length} invalid pricing row(s)`);
  if (stats && stats.unpricedModels.length) {
    warnings.push(`unpriced: ${stats.unpricedModels.map((m) => sanitizeText(meter.shortModel(m))).join(',')} ($0-counted)`);
  }
  const warnStr = warnings.length ? ` | WARN ${warnings.join(' · ')}` : '';
  const degradedTag = degraded ? ' DEGRADED' : '';

  if (flags.json) {
    out(JSON.stringify({
      active: !!active,
      degraded,
      block: stats ? {
        start: new Date(stats.startMs).toISOString(),
        end: new Date(stats.endMs).toISOString(),
        remainingMs: stats.remainingMs,
        elapsedMs: stats.elapsedMs,
        tokens: stats.tokens,
        costUSD: usd(stats.costUSD),
        tokensPerMinute: Math.round(stats.tokensPerMinute),
        costPerHour: usd(stats.costPerHour),
        projectedCostUSD: usd(stats.projectedCostUSD),
        projectedTokens: stats.projectedTokens,
        unpricedModels: stats.unpricedModels,
        models: modelsJson(stats.models),
      } : null,
      lastActivity: loaded.entries.length
        ? new Date(loaded.entries[loaded.entries.length - 1].ts).toISOString()
        : null,
      meta: jsonMeta(loaded, pricing, now),
    }, null, 2));
    return 0;
  }

  if (!active) {
    const last = loaded.entries.length ? loaded.entries[loaded.entries.length - 1].ts : null;
    const ago = last ? `last activity ${meter.formatDurationMs(now - last)} ago` : `no activity in the last ${GATE_LOOKBACK_HOURS}h`;
    out(`[usage-gate] NO ACTIVE BLOCK${degradedTag} — ${ago} | costs are estimates | files ${loaded.filesScanned}${warnStr}`);
    return 0;
  }

  const split = Object.entries(stats.models)
    .sort((a, b) => b[1].tokens.total - a[1].tokens.total)
    .map(([m, v]) => `${sanitizeText(meter.shortModel(m))} ${Math.round((v.tokens.total / Math.max(1, stats.tokens.total)) * 100)}%`)
    .join(' · ');
  const pricingNote = pricing.error
    ? 'proj n/a — PRICING UNREADABLE (tokens only)'
    : `proj ${meter.formatUSD(stats.projectedCostUSD)} by block end`;
  out(`[usage-gate] ACTIVE${degradedTag} ${meter.formatDurationMs(stats.remainingMs)} left (ends ${new Date(stats.endMs).toISOString().slice(11, 16)}Z)`
    + ` | burn ${meter.formatTokens(stats.tokensPerMinute)} tok/min · ${meter.formatUSD(stats.costPerHour)}/hr est`
    + ` | block ${meter.formatTokens(stats.tokens.total)} tok · ${meter.formatUSD(stats.costUSD)} est → ${pricingNote}`
    + ` | ${split}${warnStr}`
    + ` | est. only`);
  return 0;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const HELP = `usage.cjs — local usage/cost analytics over Claude Code transcripts (all costs are ESTIMATES)

  node plugins/4ge/bin/usage.cjs <blocks|daily|monthly|session|gate> [flags]

  blocks  [--active] [--limit N]      5h billing blocks; --active = gate workhorse detail
  daily   [--since D] [--until D]     per-day rollup (default last ${DAILY_DEFAULT_DAYS} days; D = YYYYMMDD)
  monthly                             per-month rollup (full history scan — slower)
  session [--limit N] [--all]         per-session rollup, newest first
  gate                                one-line pre-dispatch burn gate (exit 2 = transcripts unreadable)

  global: --json --breakdown --dir <path> (repeatable) --all --now <ISO> --tz <minutes east of UTC>`;

async function main() {
  const { cmd, flags, errors } = parseArgs(process.argv.slice(2));
  if (errors.length) {
    for (const e of errors) errOut(`usage.cjs: ${e}`);
    errOut(HELP);
    process.exit(1);
  }
  const commands = {
    blocks: cmdBlocks,
    daily: cmdDaily,
    monthly: cmdMonthly,
    session: cmdSession,
    gate: cmdGate,
  };
  if (!cmd || !commands[cmd]) {
    errOut(cmd ? `usage.cjs: unknown subcommand "${cmd}"` : 'usage.cjs: missing subcommand');
    errOut(HELP);
    process.exit(1);
  }
  try {
    process.exit(await commands[cmd](flags));
  } catch (e) {
    if (e && e.code === 'ENOTRANSCRIPTS') {
      errOut(`usage.cjs: transcripts unreadable — ${e.message}`);
      process.exit(2);
    }
    if (cmd === 'gate') {
      // Gate is consumed by hooks/skills: any unexpected failure must be
      // fail-VISIBLE (exit 2), never a silent zero.
      errOut(`usage.cjs: gate failed — ${e && e.message ? e.message : e}`);
      process.exit(2);
    }
    errOut(`usage.cjs: ${e && e.stack ? e.stack : e}`);
    process.exit(1);
  }
}

main();
