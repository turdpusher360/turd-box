#!/usr/bin/env bash
# entrypoint.sh — DFE GitHub Action orchestrator
# Pulls PR diff, runs each DFE pass via Claude API, posts findings as PR review comments.
# Exit codes (fail-closed):
#   0 = review COMPLETED and is clean / only LOW/MEDIUM (or fail_on_severity=NONE)
#   1 = review COMPLETED and found blocking findings (HIGH/CRITICAL or BLOCKED verdict)
#   2 = review COULD NOT COMPLETE (a pass errored, API/token failure, or an
#       UNKNOWN/ERROR verdict). Distinct from "1 = real blockers found": a
#       transient API failure with ZERO findings must NOT be reported as a clean
#       pass (exit 0) and must NOT masquerade as a confirmed-blocker block (exit 1).

set -euo pipefail

# ─── Configuration ────────────────────────────────────────────────────────────

PASSES="${DFE_PASSES:-3}"
BASE_BRANCH="${DFE_BASE_BRANCH:-main}"
MAX_DIFF_KB="${DFE_MAX_DIFF_KB:-50}"
FAIL_ON_SEVERITY="${DFE_FAIL_ON_SEVERITY:-HIGH}"
POST_REVIEW="${DFE_POST_REVIEW:-true}"
REPORT_DIR="/tmp/dfe-reports"
REPORT_JSON="${REPORT_DIR}/dfe-report.json"
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

mkdir -p "${REPORT_DIR}"

echo "::group::4ge DFE Review — ${PASSES}-pass mode"
echo "Base branch: ${BASE_BRANCH}"
echo "Fail on severity: ${FAIL_ON_SEVERITY}"
echo "Post review comments: ${POST_REVIEW}"

# ─── Validate required inputs ─────────────────────────────────────────────────

if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "::error::ANTHROPIC_API_KEY is required but not set"
  exit 1
fi

if [ -z "${GITHUB_TOKEN:-}" ]; then
  echo "::error::GITHUB_TOKEN is required but not set"
  exit 1
fi

# fail_on_severity is allowlisted EARLY, exactly like `passes` below. Without
# this, any unexpected value (lowercase "high", "MEDIUM", empty string) fell
# through every elif in the exit-code block to `exit 0` — a silent fail-OPEN
# that defeated the merge gate even with HIGH/CRITICAL findings present
# (CWE-703/CWE-636; found in the 2026-06-05 deep audit).
case "${FAIL_ON_SEVERITY}" in
  NONE|CRITICAL|HIGH) ;;
  *)
    echo "::error::fail_on_severity must be NONE, CRITICAL, or HIGH, got: ${FAIL_ON_SEVERITY}"
    exit 1
    ;;
esac

# ─── Extract diff ─────────────────────────────────────────────────────────────

echo "Extracting diff..."

DIFF_FILE="${REPORT_DIR}/pr.diff"

if [ "${GITHUB_EVENT_NAME:-}" = "pull_request" ] && [ -n "${GITHUB_PR_NUMBER:-}" ]; then
  # PR context: diff against base branch
  git fetch --depth=50 origin "${BASE_BRANCH}" 2>/dev/null || true
  git diff "origin/${BASE_BRANCH}...HEAD" -- '*.js' '*.ts' '*.jsx' '*.tsx' '*.mjs' '*.cjs' \
    '*.py' '*.go' '*.rs' '*.java' '*.rb' '*.php' > "${DIFF_FILE}" 2>/dev/null || \
    git diff "origin/${BASE_BRANCH}...HEAD" > "${DIFF_FILE}" 2>/dev/null || \
    git diff HEAD~1 > "${DIFF_FILE}"
else
  # Push context: diff last commit
  git diff HEAD~1 > "${DIFF_FILE}" 2>/dev/null || git diff HEAD > "${DIFF_FILE}"
fi

DIFF_SIZE_KB=$(du -k "${DIFF_FILE}" | cut -f1)
echo "Diff size: ${DIFF_SIZE_KB}KB (limit: ${MAX_DIFF_KB}KB)"

if [ "${DIFF_SIZE_KB}" -gt "${MAX_DIFF_KB}" ]; then
  echo "::warning::Diff exceeds ${MAX_DIFF_KB}KB — truncating. Large PRs may have incomplete coverage."
  # Truncate and append a note
  head -c "$((MAX_DIFF_KB * 1024))" "${DIFF_FILE}" > "${DIFF_FILE}.truncated"
  echo -e "\n\n[DIFF TRUNCATED AT ${MAX_DIFF_KB}KB — remaining changes not reviewed]" >> "${DIFF_FILE}.truncated"
  mv "${DIFF_FILE}.truncated" "${DIFF_FILE}"
fi

if [ ! -s "${DIFF_FILE}" ]; then
  echo "No diff found — nothing to review."
  echo "findings_count=0" >> "${GITHUB_OUTPUT:-/dev/null}"
  echo "critical_count=0" >> "${GITHUB_OUTPUT:-/dev/null}"
  echo "high_count=0" >> "${GITHUB_OUTPUT:-/dev/null}"
  echo "verdict=CLEAN" >> "${GITHUB_OUTPUT:-/dev/null}"
  echo "report_path=" >> "${GITHUB_OUTPUT:-/dev/null}"
  echo "::endgroup::"
  exit 0
fi

# ─── Determine which passes to run ───────────────────────────────────────────

if [ "${PASSES}" = "3" ]; then
  PASS_IDS=("P1" "P2" "P3")
elif [ "${PASSES}" = "6" ]; then
  PASS_IDS=("P1" "P2" "P3" "P4" "P5" "P6")
else
  echo "::error::passes must be 3 or 6, got: ${PASSES}"
  exit 1
fi

echo "Running ${#PASS_IDS[@]} passes: ${PASS_IDS[*]}"

# ─── Run passes via Node.js ───────────────────────────────────────────────────

# Findings accumulate in a FILE, never a shell variable. Interpolating finding
# text (LLM-generated, derived from attacker-controllable PR diffs) into a
# `node -e` string literal breaks on any apostrophe and is an injection vector;
# read/write via the file path instead and the content never touches the shell.
COMBINED_FILE="${REPORT_DIR}/combined.json"
PASS_ERRORS_FILE="${REPORT_DIR}/pass-errors.json"
echo '[]' > "${COMBINED_FILE}"
echo '[]' > "${PASS_ERRORS_FILE}"
VERDICTS=()
TOTAL_FINDINGS=0
CRITICAL_COUNT=0
HIGH_COUNT=0
# Set to 1 if any pass cannot be completed (execution failure, API/token failure,
# or an ERROR/UNKNOWN verdict). Drives the dedicated exit 2 "could-not-complete"
# path so a transient failure is never reported as CLEAN and never conflated with
# a real findings-based BLOCKED block. Fixes the L-4 false-block: a transient API
# failure with zero findings previously routed to BLOCKED -> exit 1.
COULD_NOT_COMPLETE=0

for PASS_ID in "${PASS_IDS[@]}"; do
  echo ""
  echo "--- Running ${PASS_ID} ---"

  PASS_OUTPUT="${REPORT_DIR}/pass-${PASS_ID}.json"

  # node run-pass.js <pass_id> <diff_file> <output_file>
  if node /action/lib/run-pass.js "${PASS_ID}" "${DIFF_FILE}" "${PASS_OUTPUT}"; then
    if [ -f "${PASS_OUTPUT}" ]; then
      PASS_VERDICT=$(node -e '
        const fs = require("fs");
        try {
          const d = JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
          const verdict = d.verdict || "CLEAN";
          // Findings-based verdicts pass through. ERROR/UNKNOWN (produced on API
          // failure / token truncation / unparseable response) pass through too so
          // the aggregator can fail-closed via the could-not-complete path. Any
          // OTHER unexpected string is treated as UNKNOWN (could-not-complete) —
          // NOT BLOCKED — so a transient glitch never masquerades as a real blocker.
          process.stdout.write(["CLEAN", "RISK", "BLOCKED", "ERROR", "UNKNOWN"].includes(verdict) ? verdict : "UNKNOWN");
        } catch(e) { process.stdout.write("UNKNOWN"); }
      ' "${PASS_OUTPUT}")
      PASS_FINDINGS=$(node -e '
        const fs = require("fs");
        try {
          const d = JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
          process.stdout.write(String((d.findings||[]).length));
        } catch(e) { process.stdout.write("0"); }
      ' "${PASS_OUTPUT}")
      echo "::notice::${PASS_ID}: ${PASS_VERDICT} (${PASS_FINDINGS} findings)"
      VERDICTS+=("${PASS_VERDICT}")

      # ERROR/UNKNOWN means the pass ran but produced no trustworthy result
      # (API failure, token truncation, unparseable output). Fail-closed via the
      # could-not-complete path — never silently downgraded to CLEAN.
      if [ "${PASS_VERDICT}" = "ERROR" ] || [ "${PASS_VERDICT}" = "UNKNOWN" ]; then
        echo "::warning::${PASS_ID} verdict ${PASS_VERDICT} — review could not complete this pass"
        COULD_NOT_COMPLETE=1
      fi

      # Merge this pass's findings into the accumulator file. All values arrive
      # as argv (controlled paths + the P1..P6 pass id); finding content is read
      # from disk, never interpolated into the script body.
      node -e '
        const fs = require("fs");
        const [combinedFile, passFile, passId] = process.argv.slice(1);
        let combined = [];
        try { combined = JSON.parse(fs.readFileSync(combinedFile, "utf8")); } catch (e) { /* start empty */ }
        try {
          const pass = JSON.parse(fs.readFileSync(passFile, "utf8"));
          const tagged = (pass.findings || []).map((f) => ({ ...f, pass: passId }));
          fs.writeFileSync(combinedFile, JSON.stringify([...combined, ...tagged]));
        } catch (e) { /* leave accumulator unchanged on bad pass output */ }
      ' "${COMBINED_FILE}" "${PASS_OUTPUT}" "${PASS_ID}"

      node -e '
        const fs = require("fs");
        const [errorsFile, passFile, passId] = process.argv.slice(1);
        let errors = [];
        try { errors = JSON.parse(fs.readFileSync(errorsFile, "utf8")); } catch (e) { /* start empty */ }
        try {
          const pass = JSON.parse(fs.readFileSync(passFile, "utf8"));
          if (pass.error || pass.parse_error) {
            errors.push({
              pass: passId,
              error: pass.error || "Could not parse structured review response",
            });
            fs.writeFileSync(errorsFile, JSON.stringify(errors));
          }
        } catch (e) { /* no pass error to preserve */ }
      ' "${PASS_ERRORS_FILE}" "${PASS_OUTPUT}" "${PASS_ID}"
    fi
  else
    echo "::warning::${PASS_ID} failed — continuing with remaining passes"
    # Pass execution failed outright (non-zero exit from run-pass.js): the review
    # did not complete. This is ERROR (could-not-complete), NOT a findings-based
    # BLOCKED — fixes L-4 where a transient failure with zero findings false-blocked
    # the PR as if real blockers were found.
    VERDICTS+=("ERROR")
    COULD_NOT_COMPLETE=1
    node -e '
      const fs = require("fs");
      const [errorsFile, passFile, passId] = process.argv.slice(1);
      let errors = [];
      try { errors = JSON.parse(fs.readFileSync(errorsFile, "utf8")); } catch (e) { /* start empty */ }
      let error = "Pass execution failed";
      try {
        const pass = JSON.parse(fs.readFileSync(passFile, "utf8"));
        error = pass.error || error;
      } catch (e) { /* keep generic error */ }
      errors.push({ pass: passId, error });
      fs.writeFileSync(errorsFile, JSON.stringify(errors));
    ' "${PASS_ERRORS_FILE}" "${PASS_OUTPUT}" "${PASS_ID}"
  fi
done

# ─── Compute aggregate counts ─────────────────────────────────────────────────

# Counts read the accumulator from disk (path passed as argv); no content interpolation.
TOTAL_FINDINGS=$(node -e '
  const fs = require("fs");
  try { process.stdout.write(String(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).length)); }
  catch (e) { process.stdout.write("0"); }
' "${COMBINED_FILE}")

CRITICAL_COUNT=$(node -e '
  const fs = require("fs");
  try { process.stdout.write(String(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).filter((x) => x.severity === "CRITICAL").length)); }
  catch (e) { process.stdout.write("0"); }
' "${COMBINED_FILE}")

HIGH_COUNT=$(node -e '
  const fs = require("fs");
  try { process.stdout.write(String(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).filter((x) => x.severity === "HIGH").length)); }
  catch (e) { process.stdout.write("0"); }
' "${COMBINED_FILE}")

# Overall verdict: worst of all pass verdicts
OVERALL_VERDICT="CLEAN"
for V in "${VERDICTS[@]}"; do
  if [ "${V}" = "BLOCKED" ]; then
    OVERALL_VERDICT="BLOCKED"
    break
  elif [ "${V}" = "RISK" ] && [ "${OVERALL_VERDICT}" != "BLOCKED" ]; then
    OVERALL_VERDICT="RISK"
  fi
done

echo ""
echo "=== DFE Summary ==="
echo "Total findings: ${TOTAL_FINDINGS} (CRITICAL: ${CRITICAL_COUNT}, HIGH: ${HIGH_COUNT})"
echo "Overall verdict: ${OVERALL_VERDICT}"
if [ "${COULD_NOT_COMPLETE}" = "1" ]; then
  echo "Review status: COULD NOT COMPLETE (one or more passes errored or returned UNKNOWN)"
fi

# ─── Write consolidated JSON report ──────────────────────────────────────────

# Findings come from the accumulator file; only controlled scalars/paths are argv.
# Previously this block had no try/catch and interpolated finding content, so a
# single apostrophe in any finding crashed the whole action under `set -e`.
node -e '
  const fs = require("fs");
  const [combinedFile, errorsFile, reportJson, timestamp, passes, verdict, failOnSeverity, total, critical, high] = process.argv.slice(1);
  let findings = [];
  let passErrors = [];
  try { findings = JSON.parse(fs.readFileSync(combinedFile, "utf8")); } catch (e) { /* empty */ }
  try { passErrors = JSON.parse(fs.readFileSync(errorsFile, "utf8")); } catch (e) { /* empty */ }
  const report = {
    timestamp,
    passes_run: Number(passes),
    verdict,
    fail_on_severity: failOnSeverity,
    stats: { total: Number(total), critical: Number(critical), high: Number(high) },
    pass_errors: passErrors,
    findings,
  };
  fs.writeFileSync(reportJson, JSON.stringify(report, null, 2));
  console.log("Report written to " + reportJson);
' "${COMBINED_FILE}" "${PASS_ERRORS_FILE}" "${REPORT_JSON}" "${TIMESTAMP}" "${PASSES}" "${OVERALL_VERDICT}" "${FAIL_ON_SEVERITY}" "${TOTAL_FINDINGS}" "${CRITICAL_COUNT}" "${HIGH_COUNT}"

# ─── Post PR review comments ──────────────────────────────────────────────────

if [ "${POST_REVIEW}" = "true" ] && [ -n "${GITHUB_PR_NUMBER:-}" ]; then
  echo ""
  echo "Posting review comments..."
  node /action/lib/github-client.js "${REPORT_JSON}" || \
    echo "::warning::Failed to post review comments — findings are in the report artifact"
fi

# ─── Set outputs ─────────────────────────────────────────────────────────────

{
  echo "findings_count=${TOTAL_FINDINGS}"
  echo "critical_count=${CRITICAL_COUNT}"
  echo "high_count=${HIGH_COUNT}"
  echo "verdict=${OVERALL_VERDICT}"
  echo "report_path=${REPORT_JSON}"
} >> "${GITHUB_OUTPUT:-/dev/null}"

echo "::endgroup::"

# ─── Exit code ────────────────────────────────────────────────────────────────

# Fail-closed FIRST: a review that could not complete (transient API/token
# failure, pass error, ERROR/UNKNOWN verdict) gets a DISTINCT exit 2 — checked
# before fail_on_severity (including NONE). It is neither a clean pass (exit 0)
# nor a confirmed-blocker block (exit 1). Fixes L-4: a transient failure with zero
# findings no longer false-blocks the PR as if real blockers were found.
if [ "${COULD_NOT_COMPLETE}" = "1" ]; then
  echo "::error::DFE review could not complete (a pass errored, the API/token failed, or a pass returned an UNKNOWN verdict) — failing closed. This is NOT a clean pass and NOT a findings-based block."
  exit 2
fi

if [ "${FAIL_ON_SEVERITY}" = "NONE" ]; then
  exit 0
elif [ "${OVERALL_VERDICT}" = "BLOCKED" ]; then
  # A genuine, findings-based BLOCKED verdict (run-pass emits BLOCKED only for
  # confirmed blockers; pass failures now yield ERROR/UNKNOWN handled above).
  echo "::error::DFE returned a BLOCKED verdict — blocking merge"
  exit 1
elif [ "${FAIL_ON_SEVERITY}" = "CRITICAL" ] && [ "${CRITICAL_COUNT}" -gt 0 ]; then
  echo "::error::DFE found ${CRITICAL_COUNT} CRITICAL findings — blocking merge"
  exit 1
elif [ "${FAIL_ON_SEVERITY}" = "HIGH" ] && [ $((CRITICAL_COUNT + HIGH_COUNT)) -gt 0 ]; then
  echo "::error::DFE found $((CRITICAL_COUNT + HIGH_COUNT)) HIGH+ findings — blocking merge"
  exit 1
fi

exit 0
