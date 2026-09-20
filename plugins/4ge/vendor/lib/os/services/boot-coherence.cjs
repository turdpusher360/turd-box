// @ts-check
'use strict';

/**
 * boot-coherence.cjs — read-only coherence sentinel for the shared OS boot-status
 * singleton. Rung D of the upstream boot-coherence remedy ladder (design:
 * _runs/2026-07-18/s589/rungs-ad/DESIGN.md; ladder ships B -> A1 -> D-detection,
 * with D built here because making incoherence VISIBLE is strictly safer than the
 * silent trust the upstream defects exploited).
 *
 * Consumes ONLY what rung B (write-attribution.cjs, e44bc618) already produced —
 * boot-status.json's `written_by`, the boot-writers.jsonl journal, `.boot-sentinel`,
 * and a live-session anchor the caller supplies. It adds NO key to any state file
 * and changes no schema: this is the zero-reader-compat-risk rung, and it NEVER
 * writes anything.
 *
 * Modeled 1:1 on services/sentinel-heartbeat.cjs (the {line, red} contract and the
 * "read a file, judge it, name the failure in red" shape). Five checks, each ->
 * a named degraded flag:
 *
 *   D1 foreign session   — boot-status is owned by a different session than the live one
 *                          AND that boot did not originate at this session's own start
 *                          (the upstream stomp: the brief is trusting another surface's view).
 *                          The `claude --continue` fork — whose own boot is stamped with the
 *                          pre-fork ancestor id (upstream) — is excluded by the self-fork window.
 *   D2 cold-boot killed   — boot-status is from another session AND predates this session's
 *                          start (this session's boot never wrote it — the upstream SIGKILL lesson)
 *   D3 dead boot process  — THIS session's `.boot-sentinel` is an IN-FLIGHT marker
 *                          (phase 'booting') whose boot process is dead — the boot
 *                          attempt died mid-flight. Sentinel v2 (upstream): os-boot writes
 *                          {phase:'booting', bootPid} before booting and rewrites
 *                          {phase:'complete'} only on success. v1 sentinels (no phase)
 *                          were written ONLY at completion and named CC's ephemeral
 *                          hook-wrapper pid — dead seconds after every healthy boot —
 *                          so they read as complete, never as a death.
 *   D4 journal divergence — `written_by` claims a write the append-only journal never
 *                          recorded (the ONLY tell for a truly out-of-band / direct-fs write)
 *   D5 no attribution     — boot-status has no `written_by` (pre-rung-B file, or a writer
 *                          that bypassed the library — provenance unknown)
 *
 * The live anchor is what makes D2 work even on a SIGKILLed boot: session-uptime.json
 * (the upstream per-session started_at_ms map) and session-meta.json are patched by
 * per-event hooks that run regardless of whether the expensive boot completed, so the
 * live session id + start survive a boot that never got to write boot-status. (A
 * compact fast-path boot — G-046 — likewise skips the boot-status write, but keeps the
 * SAME session id, so owner === live and D1/D2 stay quiet: correct, not a false alarm.)
 *
 * DELIBERATE DEVIATION from the DESIGN.md check table (documented so a future reader
 * does not "fix" it back): the design's literal D1 condition ANDs `booted_at <
 * liveSessionStart`, which would miss a teammate boot that stomps DURING the live
 * session (booted_at > liveSessionStart). Instead the foreign-owner timeline is
 * partitioned by `booted_at` relative to this session's start (± COLD_BOOT_THRESHOLD_MS):
 *   • before  (start − window)  → D2 cold-boot killed (this session's boot never ran)
 *   • within  (± window)        → SELF-FORK: this session's OWN start-time boot, stamped
 *                                 with a foreign id by the `claude --continue` gap (upstream);
 *                                 quiet — not foreign, not killed
 *   • after   (start + window)  → D1 foreign concurrent stomp (a real other surface)
 * So D1 catches the stale-trust and the concurrent-stomp WITHOUT firing on our own
 * resume-fork boot, and D2's session-mismatch tie kills the late-first-poll false-
 * positive (if this session's own boot wrote the file, owner === live and both stay
 * quiet regardless of started_at_ms timing). When the time anchors are unavailable the
 * partition collapses and D1 falls back to firing on any foreign owner (conservative:
 * a rare cosmetic false-red is preferable to masking a real foreign view).
 */

const fs = require('node:fs');
const path = require('node:path');

// boot-status this far BEFORE the live session's start => the session never booted
// (SIGKILL at the boot timeout). Generous enough to absorb clock jitter and the
// started_at_ms-vs-booted_at ordering race, tight enough to catch the upstream gap (~92m).
const COLD_BOOT_THRESHOLD_MS = 60 * 1000;
// Only judge a sentinel pid "dead mid-boot" if its own claim is recent; a day-old
// dead sentinel is stale bookkeeping, not an in-flight boot that died.
const SENTINEL_FRESH_MAX_MS = 24 * 60 * 60 * 1000;
// Bound the journal read. The file is byte-capped by jsonl-rotate (~512KB), so the
// tail always contains the newest boot-status write; a full read is unnecessary.
const JOURNAL_TAIL_LINES = 200;

/** Best-effort JSON read. Returns null on any failure (missing / unparseable). */
function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/** First 8 chars of a session/uuid id for compact display; '' for a non-string. */
function shortId(id) {
  return typeof id === 'string' ? id.slice(0, 8) : '';
}

/**
 * True when `pid` names a live process. `process.kill(pid, 0)` sends no signal — it
 * only probes existence/permission: it throws ESRCH when the process is gone and
 * EPERM when the process exists but is owned by another user (still alive).
 */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return !!(err && err.code === 'EPERM');
  }
}

/**
 * Parse the tail of a JSONL journal into objects, skipping unparseable lines.
 * @param {string} p
 * @param {number} maxLines
 * @returns {object[]}
 */
function readJournalTail(p, maxLines) {
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch {
    return [];
  }
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  const out = [];
  for (const l of lines.slice(-maxLines)) {
    try {
      out.push(JSON.parse(l));
    } catch {
      /* skip a torn/partial line */
    }
  }
  return out;
}

/** Human-friendly age string: "8s", "47m", "3.2h". */
function ageText(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  const secs = ms / 1000;
  if (secs < 90) return `${Math.max(1, Math.round(secs))}s`;
  const mins = secs / 60;
  if (mins < 90) return `${Math.round(mins)}m`;
  return `${(mins / 60).toFixed(1)}h`;
}

/**
 * Judge whether the live boot-status.json is coherent for the live session.
 *
 * @param {object} [opts]
 * @param {string} [opts.repoRoot]            Repo root (used only to derive stateDir if absent).
 * @param {string} [opts.stateDir]            The OS state dir (_runs/os). Preferred input.
 * @param {string} [opts.liveSessionId]       The live session id the caller trusts (statusline/hook
 *                                            stdin). Falls back to session-meta.json.
 * @param {number} [opts.liveSessionStartMs]  The live session's start epoch-ms. Falls back to
 *                                            session-uptime.json's per-session started_at_ms.
 * @param {number} [opts.now]                 Clock override (tests).
 * @returns {{ line: string, red: boolean, reason: string, checks: object }}
 */
function formatBootCoherenceLine(opts = {}) {
  const options = opts || {};
  const stateDir = options.stateDir
    || path.join(options.repoRoot || process.cwd(), '_runs', 'os');
  const now = Number.isFinite(options.now) ? options.now : Date.now();

  const bootStatusPath = path.join(stateDir, 'boot-status.json');
  let bsRaw;
  try {
    bsRaw = fs.readFileSync(bootStatusPath, 'utf8');
  } catch {
    // No boot-status is a normal fresh / non-OS state, not an incoherence to flag.
    // The absence of OS health already speaks for itself in the HUD — do not cry wolf.
    return {
      line: '[boot-coherence] no boot-status.json (OS not booted here)',
      red: false,
      reason: '',
      checks: { present: false },
    };
  }
  let bs;
  try {
    bs = JSON.parse(bsRaw);
  } catch {
    return {
      line: '[boot-coherence] BOOT INCOHERENT — boot-status.json unreadable/corrupt',
      red: true,
      reason: 'boot-status corrupt',
      checks: { present: true, corrupt: true },
    };
  }

  // --- resolve the live-session anchor -------------------------------------------------
  let liveSessionId = (typeof options.liveSessionId === 'string' && options.liveSessionId)
    ? options.liveSessionId
    : '';
  if (!liveSessionId) {
    const meta = readJsonSafe(path.join(stateDir, 'session-meta.json'));
    if (meta && typeof meta.session_id === 'string') liveSessionId = meta.session_id;
  }
  let liveStartMs = Number.isFinite(options.liveSessionStartMs) ? options.liveSessionStartMs : NaN;
  if (!Number.isFinite(liveStartMs) && liveSessionId) {
    const up = readJsonSafe(path.join(stateDir, 'session-uptime.json'));
    const entry = up && up.sessions && up.sessions[liveSessionId];
    if (entry && Number.isFinite(entry.started_at_ms)) liveStartMs = entry.started_at_ms;
  }

  // --- read boot-status facts ----------------------------------------------------------
  const hasWrittenBy = !!(bs.written_by && typeof bs.written_by === 'object');
  const owner = (hasWrittenBy && typeof bs.written_by.session_id === 'string' && bs.written_by.session_id)
    || (typeof bs.session_id === 'string' ? bs.session_id : '');
  const bootedAtMs = Date.parse(bs.booted_at);

  const checks = { present: true };

  // D5 — no attribution.
  checks.d5_no_attribution = !hasWrittenBy;

  const foreignOwner = !!(liveSessionId && owner && owner !== liveSessionId);
  const haveTimeAnchors = Number.isFinite(bootedAtMs) && Number.isFinite(liveStartMs);

  // SELF-FORK (upstream D1 fix) — a foreign-owned boot-status whose boot timestamp coincides
  // with THIS session's own start (within the window on either side) is this session's own
  // SessionStart boot, mis-stamped with a different id. That is exactly the `claude
  // --continue` fork gap (found upstream): CC forks the conversation to a NEW live session id
  // but delivers the PRE-FORK (ancestor) id to the SessionStart hook, so os-boot honestly
  // stamps boot-status with the ancestor while the live session is the fork. The boot is
  // real and ours — not another surface's view — so owner!==live must NOT read as foreign.
  // The ancestor id itself is unrecoverable (on --continue CC re-stamps every transcript
  // line to the fork id — verified upstream), so this keys on the boot's TIMING relative to this
  // session's start (the observable invariant) rather than on lineage. The window reuses
  // COLD_BOOT_THRESHOLD_MS symmetrically so it seams exactly with D2 below: booted before
  // (start − window) is a killed boot (D2); within ±window is this session's own boot
  // (self-fork, quiet); after (start + window) is a genuinely concurrent foreign surface
  // (D1). Only classifiable when both time anchors exist; without them a fork cannot be told
  // from a foreign surface and D1 falls back to the conservative any-foreign-owner alarm.
  // NO health gate: a --continue self-boot that is legitimately degraded is still OUR boot;
  // its degraded HEALTH surfaces through normal rendering and must not read as `foreign`.
  // The one theoretical hole — a foreign DEGRADED boot inside the window — is closed at
  // WRITE time by rung A1 (shouldSuppressWrite), the ladder's "A prevents, D detects" split.
  checks.self_fork = foreignOwner && haveTimeAnchors
    && bootedAtMs >= (liveStartMs - COLD_BOOT_THRESHOLD_MS)
    && bootedAtMs <= (liveStartMs + COLD_BOOT_THRESHOLD_MS);

  // D2 — cold-boot killed / predates: boot-status is from another session AND predates
  // this session's start by > threshold, so this session's boot never wrote it (the upstream
  // SIGKILL lesson). Tied to the owner!==live mismatch (see the header deviation note) so a
  // healthy same-session boot whose first statusline poll landed late can never be mistaken
  // for a killed boot.
  checks.d2_cold_boot = foreignOwner && haveTimeAnchors
    && bootedAtMs < (liveStartMs - COLD_BOOT_THRESHOLD_MS);

  // D1 — foreign session: a different session owns the boot-status the live session is
  // trusting, and that boot is NEITHER this session's own start-time boot (self-fork, above)
  // NOR a pre-session cold boot (D2, above). When the time anchors are missing we cannot
  // tell a --continue fork from a genuinely foreign surface, so we conservatively fire on
  // any foreign owner (self_fork + d2_cold_boot are both false without anchors), preserving
  // the upstream concurrent-stomp catch.
  checks.d1_foreign = foreignOwner && !checks.self_fork && !checks.d2_cold_boot;

  // D3 — dead boot process: THIS session's sentinel says a boot attempt is in flight
  // (phase 'booting') and the process running it is gone — the attempt died mid-boot
  // (or was killed by the in-process ceiling / SIGKILL before it could complete). Tied
  // to sessionId===live so a prior-session sentinel is never mistaken for a mid-boot
  // death. Gated on phase==='booting': a 'complete' sentinel is a finished boot, and a
  // v1 sentinel (no phase) was written ONLY at completion — and named CC's ephemeral
  // hook-wrapper pid, dead seconds after every healthy boot (the upstream every-session
  // false positive) — so both read as complete, never as a death.
  const sentinel = readJsonSafe(path.join(stateDir, '.boot-sentinel'));
  if (sentinel && liveSessionId && sentinel.sessionId === liveSessionId
    && sentinel.phase === 'booting') {
    const claimMs = Date.parse(sentinel.startedAt || sentinel.bootedAt);
    const fresh = Number.isFinite(claimMs) && (now - claimMs) < SENTINEL_FRESH_MAX_MS;
    checks.d3_dead_sentinel = !!(fresh && !pidAlive(sentinel.bootPid));
  } else {
    checks.d3_dead_sentinel = false;
  }

  // D4 — journal divergence: written_by claims a write the append-only journal never
  // recorded => an out-of-band / direct-fs write that bypassed recordWrite (the only tell
  // for a truly-foreign writer). Compare against the NEWEST boot-status.json line in the
  // journal, not an exact historical match, so jsonl rotation can never false-fire.
  checks.d4_journal_divergence = false;
  if (hasWrittenBy) {
    const journal = readJournalTail(path.join(stateDir, 'boot-writers.jsonl'), JOURNAL_TAIL_LINES);
    const wb = bs.written_by;
    let evidence = null;
    for (let i = journal.length - 1; i >= 0; i -= 1) {
      const e = journal[i];
      if (!e || e.file !== 'boot-status.json') continue;
      if (e.event === 'suppressed_write') {
        // A1 records which existing writer remained protected. That proof keeps D4 valid
        // after the original actual-write line falls outside the tail or rotates away.
        const protectedWriter = e.protected_written_by;
        if (e.protected_writer_verified === true
          && protectedWriter
          && protectedWriter.session_id === wb.session_id
          && protectedWriter.ts === wb.ts) {
          evidence = protectedWriter;
          break;
        }
        continue;
      }
      evidence = e;
      break;
    }
    if (!evidence) {
      // written_by present but the journal has neither an actual write nor protected proof.
      checks.d4_journal_divergence = true;
    } else {
      checks.d4_journal_divergence = !(evidence.session_id === wb.session_id && evidence.ts === wb.ts);
    }
  }

  // --- compose ------------------------------------------------------------------------
  // Severe = the "you are trusting the wrong view" class (red-red). d4/d5 are provenance
  // warnings. Reason priority is most-specific / most-actionable first.
  const severe = checks.d1_foreign || checks.d2_cold_boot || checks.d3_dead_sentinel;
  const red = !!(severe || checks.d4_journal_divergence || checks.d5_no_attribution);
  checks.severe = !!severe;

  const bootedAgo = Number.isFinite(bootedAtMs) ? ageText(now - bootedAtMs) : 'unknown';

  if (!red) {
    // Green. Say whether the live anchor was available so an "ok" with skipped D1/D2
    // is not mistaken for a fully-verified one. The self-fork case is called out
    // explicitly so owner!==live is not read as a missed foreign alarm on inspection.
    let anchorNote;
    if (checks.self_fork) {
      anchorNote = `booted by this resumed session (${bootedAgo} ago; boot stamped prior id ${shortId(owner)} — --continue fork)`;
    } else if (liveSessionId) {
      anchorNote = `booted by this session (${bootedAgo} ago), journal matches`;
    } else {
      anchorNote = `booted ${bootedAgo} ago (live session unknown — foreign/stale checks skipped)`;
    }
    return { line: `[boot-coherence] ok — ${anchorNote}`, red: false, reason: '', checks };
  }

  let reason;
  if (checks.d2_cold_boot) {
    reason = `cold-boot killed — boot-status is session ${shortId(owner)}, frozen from before this session started`;
  } else if (checks.d1_foreign) {
    reason = `foreign session ${shortId(owner)} — health shown is another surface's view (booted ${bootedAgo} ago)`;
  } else if (checks.d3_dead_sentinel) {
    reason = `boot attempt pid ${sentinel.bootPid} died mid-boot — boot may be incomplete`;
  } else if (checks.d4_journal_divergence) {
    reason = 'boot-status write is not in the writers journal — possible out-of-band write';
  } else {
    reason = 'boot-status has no written_by attribution — provenance unknown';
  }

  return { line: `[boot-coherence] BOOT INCOHERENT — ${reason}`, red: true, reason, checks };
}

module.exports = {
  formatBootCoherenceLine,
  COLD_BOOT_THRESHOLD_MS,
  SENTINEL_FRESH_MAX_MS,
  JOURNAL_TAIL_LINES,
};
