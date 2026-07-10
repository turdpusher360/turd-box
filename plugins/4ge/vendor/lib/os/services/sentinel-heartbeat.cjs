'use strict';

/**
 * sentinel-heartbeat.cjs
 *
 * The boot-line "re-arm owner's voice" from the upstream root-cause closure design
 * (docs/superpowers/specs/2026-07-08-constraint-register-rig-sentinel-design.md §4). Reads
 * ONLY _runs/os/sentinel-status.json — this module NEVER runs a check itself. That split is
 * deliberate: scripts/rig-sentinel.cjs runs checks (cron-scheduled, seconds of work);
 * os-boot.cjs happens on every SessionStart and must stay a cheap file read.
 *
 * Freshness / "SENTINEL DEAD" detection lives HERE, not in rig-sentinel.cjs itself, because a
 * dead sentinel can't be trusted to report its own death — the DEAD-detection logic has to run
 * from a completely independent trigger (SessionStart) that fires regardless of whether the
 * cron job is still alive. If sentinel-status.json is more than DEAD_THRESHOLD_HOURS old (or
 * missing, or unparseable), the sentinel itself is the thing that's broken, and the boot line
 * says so in red rather than silently having nothing to show.
 */

const fs = require('node:fs');
const path = require('node:path');

const DEAD_THRESHOLD_HOURS = 48;

function defaultStatusPath(repoRoot) {
  return path.join(repoRoot || process.cwd(), '_runs', 'os', 'sentinel-status.json');
}

/**
 * @param {{ repoRoot?: string, statusPath?: string, now?: Date }} [opts]
 * @returns {{ line: string, red: boolean }}
 */
function formatSentinelLine(opts) {
  const options = opts || {};
  const statusPath = options.statusPath || defaultStatusPath(options.repoRoot);
  const now = options.now || new Date();

  let raw;
  try {
    raw = fs.readFileSync(statusPath, 'utf8');
  } catch {
    return {
      line: '[sentinel] never run (no _runs/os/sentinel-status.json — crontab not installed yet, or first run pending)',
      red: true,
    };
  }

  let status;
  try {
    status = JSON.parse(raw);
  } catch {
    return { line: '[sentinel] SENTINEL DEAD — status file unreadable/corrupt', red: true };
  }

  if (status && status.fatal_error) {
    return { line: `[sentinel] SENTINEL DEAD — last run failed to load the register: ${String(status.fatal_error).slice(0, 120)}`, red: true };
  }

  const ranAtMs = status && status.ran_at ? Date.parse(status.ran_at) : NaN;
  if (!Number.isFinite(ranAtMs)) {
    return { line: '[sentinel] SENTINEL DEAD — status file has no valid ran_at', red: true };
  }

  const ageHours = (now.getTime() - ranAtMs) / 3600000;
  if (ageHours > DEAD_THRESHOLD_HOURS) {
    return {
      line: `[sentinel] SENTINEL DEAD — crontab check (last ran ${ageHours.toFixed(1)}h ago, > ${DEAD_THRESHOLD_HOURS}h)`,
      red: true,
    };
  }

  const summary = (status && status.summary) || {};
  const enforcedOk = typeof summary.enforced_ok === 'number' ? summary.enforced_ok : 0;
  const enforcedTotal = typeof summary.enforced_total === 'number' ? summary.enforced_total : 0;
  const redList = Array.isArray(summary.red) ? summary.red : [];
  const doctrineOnlyCount = typeof summary.doctrine_only_count === 'number' ? summary.doctrine_only_count : 0;
  const retiringOverdue = Array.isArray(summary.retiring_overdue) ? summary.retiring_overdue : [];
  const doctrineOnlyOverdue = Array.isArray(summary.doctrine_only_overdue) ? summary.doctrine_only_overdue : [];
  // upstream review P2-3: budget-exhaustion skips are a coverage-loss signal, not just "fewer
  // enforced entries in the denominator" — surface them explicitly and treat as red, so a
  // run that silently lost coverage never renders as a clean "N/N ok" boot line.
  const budgetSkipped = Array.isArray(summary.budget_skipped) ? summary.budget_skipped : [];

  const agoText = ageHours < 1 ? `${Math.max(1, Math.round(ageHours * 60))}m ago` : `${ageHours.toFixed(1)}h ago`;

  const redParts = [];
  if (redList.length > 0) {
    redParts.push(`${redList.length} RED (${redList.slice(0, 4).join(', ')}${redList.length > 4 ? ', …' : ''})`);
  }
  if (budgetSkipped.length > 0) {
    redParts.push(`${budgetSkipped.length} SKIPPED (budget)`);
  }
  if (retiringOverdue.length > 0) {
    redParts.push(`${retiringOverdue.length} retiring overdue`);
  }
  if (doctrineOnlyOverdue.length > 0) {
    redParts.push(`${doctrineOnlyOverdue.length} doctrine-only overdue`);
  }
  const redText = redParts.length > 0 ? ` · ${redParts.join(' · ')}` : '';

  return {
    line: `[sentinel] ${enforcedOk}/${enforcedTotal} ok${redText} · ${doctrineOnlyCount} doctrine-only · ran ${agoText}`,
    red: redParts.length > 0,
  };
}

module.exports = { formatSentinelLine, defaultStatusPath, DEAD_THRESHOLD_HOURS };
