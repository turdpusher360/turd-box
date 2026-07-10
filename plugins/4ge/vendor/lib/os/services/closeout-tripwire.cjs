'use strict';

/**
 * closeout-tripwire.cjs
 *
 * Postmortem P3 (_runs/2026-07-02/postmortem-ecosystem-stranded-work.md):
 * the exact failure this catches happened to the postmortem's OWN fix
 * session twelve hours after it landed — upstream closed with commit `7ff1bf47`
 * (continuity work: cartridge + TASKING + logs) sitting one commit ahead of
 * `origin/main`, unpushed, and no `_runs/HANDOFF-S521.md` was ever written.
 * upstream's boot reconciliation caught it manually. This module encodes that
 * exact manual check as a boot-brief tripwire.
 *
 * SBD-only in practice: the checks below assume the `TASKING.md` /
 * `_runs/HANDOFF-S###.md` / session-cartridge conventions documented in this
 * repo's CLAUDE.md. They are written generically (repoRoot-parameterized,
 * matching backlog-staleness.cjs's shape) but are only meaningful where
 * those conventions exist — same posture as backlog-staleness.cjs, which is
 * also SBD-only in practice despite being repo-agnostic in code.
 *
 * Three independent checks, all cheap and synchronous (local git only for (a) —
 * no fetch, no network; (b) and (c) are filesystem-only):
 *
 *   (a) unpushed continuity work — `main` ahead of `origin/main` where the
 *       unpushed commits touch a continuity file (TASKING.md,
 *       _runs/session-cartridge.json) or carry a `docs(session):` subject.
 *   (b) missing handoff — the session-cartridge's derived current session
 *       number has no matching `_runs/HANDOFF-S<N>.md`.
 *   (c) S-number-gap / minting-burst — R-07 (_runs/s547/recurring-failures-register.md):
 *       the upstream incident minted labels upstream-upstream for one continuing lane; the
 *       code-level counter bug (session number stuck/double-incrementing) has
 *       since been fixed and test-locked (upstream `deriveNextHandoffNumber`,
 *       `.claude/hooks/__tests__/hook-utils.test.js`), but the LABEL-discipline
 *       shape (a continuing lane minting multiple new S-numbers) is guarded by
 *       doctrine only. This check mechanizes that doctrine as a boot-brief warn.
 *
 * Fail-open by design, same contract as backlog-staleness.cjs: any missing
 * repo, non-git directory, git failure, or unparseable state returns a null
 * result for that check rather than throwing. This is an advisory tripwire,
 * not a gate — it must never block or alter boot.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { gitRead } = require('../../fast-git.cjs');

// Local-only git calls (no network) — cheap even on drvfs; a few hundred ms
// worst case. Still timeout-guarded per the file-integrity.cjs precedent of
// never letting a hung git call silently masquerade as "clean".
const GIT_TIMEOUT_MS = 5000;

const CONTINUITY_FILES = ['TASKING.md', path.join('_runs', 'session-cartridge.json')];
const DOCS_SESSION_SUBJECT_RE = /^docs\(session\)/i;

function runGit(args, cwd) {
  try {
    const result = gitRead(args, { cwd, timeout: GIT_TIMEOUT_MS });
    if (result.error || result.signal) {
      const reason = result.error ? (result.error.code || result.error.message) : `killed:${result.signal}`;
      return { ok: false, stdout: '', reason };
    }
    if (result.status !== 0) {
      const reason = (result.stderr || '').trim().split('\n')[0] || `exit:${result.status}`;
      return { ok: false, stdout: result.stdout || '', reason };
    }
    return { ok: true, stdout: result.stdout || '', reason: null };
  } catch (err) {
    return { ok: false, stdout: '', reason: (err && err.message) || 'unknown error' };
  }
}

/**
 * Check (a): is `main` ahead of `origin/main`, and if so, do the unpushed
 * commits touch a continuity file or carry a `docs(session):` subject?
 *
 * @param {{ repoRoot?: string }} [opts]
 * @returns {{ ahead: number|null, continuityTouch: boolean, files: string[], subjects: string[], warning: string|null }}
 */
function checkUnpushedContinuity(opts) {
  const options = opts || {};
  const repoRoot = options.repoRoot || process.cwd();
  const empty = { ahead: null, continuityTouch: false, files: [], subjects: [], warning: null };

  try {
    const aheadResult = runGit(['rev-list', '--count', 'origin/main..main'], repoRoot);
    if (!aheadResult.ok) return empty; // no origin/main ref, no git, etc. — nothing to warn about
    const ahead = parseInt(aheadResult.stdout.trim(), 10);
    if (!Number.isFinite(ahead) || ahead <= 0) return { ...empty, ahead: Number.isFinite(ahead) ? ahead : null };

    const filesResult = runGit(['diff', '--name-only', 'origin/main..main'], repoRoot);
    const subjectsResult = runGit(['log', 'origin/main..main', '--format=%s'], repoRoot);

    const files = filesResult.ok ? filesResult.stdout.split('\n').filter(Boolean) : [];
    const subjects = subjectsResult.ok ? subjectsResult.stdout.split('\n').filter(Boolean) : [];

    const touchedContinuityFiles = files.filter((f) => CONTINUITY_FILES.some((c) => f === c || f.replace(/\\/g, '/') === c.replace(/\\/g, '/')));
    const docsSessionSubjects = subjects.filter((s) => DOCS_SESSION_SUBJECT_RE.test(s));
    const continuityTouch = touchedContinuityFiles.length > 0 || docsSessionSubjects.length > 0;

    let warning = null;
    if (continuityTouch) {
      const parts = [];
      if (touchedContinuityFiles.length) parts.push(`files: ${touchedContinuityFiles.join(', ')}`);
      if (docsSessionSubjects.length) parts.push(`${docsSessionSubjects.length} docs(session) commit${docsSessionSubjects.length === 1 ? '' : 's'}`);
      warning = `main is ${ahead} commit${ahead === 1 ? '' : 's'} ahead of origin/main including continuity work (${parts.join('; ')}) — push before ending`;
    }

    return { ahead, continuityTouch, files: touchedContinuityFiles, subjects: docsSessionSubjects, warning };
  } catch {
    return empty;
  }
}

/**
 * Check (b): does the session-cartridge's derived current session number
 * have a matching `_runs/HANDOFF-S<N>.md`?
 *
 * Reimplements the same "highest S### token in the cartridge text" heuristic
 * as backlog-staleness.cjs's `getCurrentSessionNumber` (kept local/duplicated
 * rather than imported, so this module has no cross-module coupling and
 * degrades independently if the sibling module is ever removed/renamed).
 *
 * @param {{ repoRoot?: string }} [opts]
 * @returns {{ currentSession: number|null, handoffExists: boolean|null, warning: string|null }}
 */
function checkHandoffGap(opts) {
  const options = opts || {};
  const repoRoot = options.repoRoot || process.cwd();
  const empty = { currentSession: null, handoffExists: null, warning: null };

  try {
    const cartridgePath = path.join(repoRoot, '_runs', 'session-cartridge.json');
    let raw;
    try {
      raw = fs.readFileSync(cartridgePath, 'utf8');
    } catch {
      return empty;
    }

    const matches = raw.match(/S(\d{3,4})\b/g);
    if (!matches || matches.length === 0) return empty;
    let currentSession = null;
    for (const m of matches) {
      const n = parseInt(m.slice(1), 10);
      if (Number.isFinite(n) && (currentSession === null || n > currentSession)) currentSession = n;
    }
    if (currentSession === null) return empty;

    const handoffPath = path.join(repoRoot, '_runs', `HANDOFF-S${currentSession}.md`);
    const handoffExists = fs.existsSync(handoffPath);

    const warning = handoffExists
      ? null
      : `session S${currentSession} has no matching _runs/HANDOFF-S${currentSession}.md — write one before ending`;

    return { currentSession, handoffExists, warning };
  } catch {
    return empty;
  }
}

/**
 * Check (c): scan `_runs/HANDOFF-S<digits>.md` filenames for a numbering gap
 * or a burst of new handoffs minted within a trailing 24h window (R-07,
 * _runs/s547/recurring-failures-register.md — the upstream label-minting shape).
 *
 * Two independent warn conditions:
 *   1. GAP — newest minus second-newest > 1: a number was skipped (erroneous
 *      minting, or a lost/renamed handoff).
 *   2. BURST — >=3 handoff files with mtime within the trailing 24h of
 *      `opts.now` (defaults to `Date.now()`): one continuing lane minting
 *      multiple new S-numbers.
 *
 * Fail-open: a missing `_runs/` dir, zero handoff files, or any thrown error
 * returns the empty shape with no warnings — same contract as the other two
 * checks in this module.
 *
 * @param {{ repoRoot?: string, now?: number }} [opts]
 * @returns {{ numbers: number[], newest: number|null, secondNewest: number|null, gapWarning: string|null, burstCount: number, burstWarning: string|null, warnings: string[] }}
 */
function checkHandoffNumberGap(opts) {
  const options = opts || {};
  const repoRoot = options.repoRoot || process.cwd();
  const now = typeof options.now === 'number' ? options.now : Date.now();
  const empty = {
    numbers: [],
    newest: null,
    secondNewest: null,
    gapWarning: null,
    burstCount: 0,
    burstWarning: null,
    warnings: [],
  };

  try {
    const runsDir = path.join(repoRoot, '_runs');
    let entries;
    try {
      entries = fs.readdirSync(runsDir);
    } catch {
      return empty;
    }

    const HANDOFF_FILE_RE = /^HANDOFF-S(\d+)[A-Za-z]?\.md$/;
    const handoffFiles = [];
    for (const entry of entries) {
      const m = entry.match(HANDOFF_FILE_RE);
      if (!m) continue;
      const n = parseInt(m[1], 10);
      if (!Number.isFinite(n)) continue;
      let mtimeMs = null;
      try {
        mtimeMs = fs.statSync(path.join(runsDir, entry)).mtimeMs;
      } catch {
        mtimeMs = null;
      }
      handoffFiles.push({ name: entry, number: n, mtimeMs });
    }

    if (handoffFiles.length === 0) return empty;

    const numbers = [...new Set(handoffFiles.map((f) => f.number))].sort((a, b) => a - b);

    let gapWarning = null;
    const newest = numbers[numbers.length - 1];
    const secondNewest = numbers.length >= 2 ? numbers[numbers.length - 2] : null;
    if (secondNewest !== null) {
      const gap = newest - secondNewest;
      if (gap > 1) {
        gapWarning = `handoff numbering gap: S${secondNewest} → S${newest} skips ${gap - 1} number(s) — compact/resume must not mint S-numbers (upstream class)`;
      }
    }

    const DAY_MS = 24 * 60 * 60 * 1000;
    const burstCount = handoffFiles.filter(
      (f) => typeof f.mtimeMs === 'number' && now - f.mtimeMs <= DAY_MS && now - f.mtimeMs >= 0
    ).length;

    let burstWarning = null;
    if (burstCount >= 3) {
      burstWarning = `${burstCount} handoffs minted within 24h — one continuing lane must not mint multiple S-numbers (upstream class)`;
    }

    return {
      numbers,
      newest,
      secondNewest,
      gapWarning,
      burstCount,
      burstWarning,
      warnings: [gapWarning, burstWarning].filter(Boolean),
    };
  } catch {
    return empty;
  }
}

/**
 * Run all three checks and collect any warnings. Independent — a failure in
 * one check never suppresses the others.
 *
 * @param {{ repoRoot?: string, now?: number }} [opts]
 * @returns {{ continuity: object, handoff: object, numbering: object, warnings: string[] }}
 */
function checkCloseoutTripwire(opts) {
  let continuity;
  try {
    continuity = checkUnpushedContinuity(opts);
  } catch {
    continuity = { ahead: null, continuityTouch: false, files: [], subjects: [], warning: null };
  }

  let handoff;
  try {
    handoff = checkHandoffGap(opts);
  } catch {
    handoff = { currentSession: null, handoffExists: null, warning: null };
  }

  let numbering;
  try {
    numbering = checkHandoffNumberGap(opts);
  } catch {
    numbering = {
      numbers: [],
      newest: null,
      secondNewest: null,
      gapWarning: null,
      burstCount: 0,
      burstWarning: null,
      warnings: [],
    };
  }

  const warnings = [continuity.warning, handoff.warning, ...(numbering.warnings || [])].filter(Boolean);
  return { continuity, handoff, numbering, warnings };
}

module.exports = {
  CONTINUITY_FILES,
  DOCS_SESSION_SUBJECT_RE,
  checkUnpushedContinuity,
  checkHandoffGap,
  checkHandoffNumberGap,
  checkCloseoutTripwire,
};
