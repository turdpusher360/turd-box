/**
 * github-client.js — Post DFE findings as GitHub PR review comments.
 *
 * Usage: node github-client.js <report_json_path>
 *
 * Reads the consolidated DFE report, extracts findings, and posts:
 *   - Inline review comments anchored to file:line for each finding
 *   - A summary review comment (approve/request_changes/comment) as the final step
 *
 * Requires: GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_PR_NUMBER, GITHUB_SHA env vars.
 * Exit 0 on success. Exit 1 on failure (non-blocking — orchestrator logs warning).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildLineIndex, isAnchorable } from './diff-parser.js';

// ─── Parse args ───────────────────────────────────────────────────────────────

const [, , reportPath] = process.argv;

if (!reportPath) {
  console.error('Usage: node github-client.js <report_json_path>');
  process.exit(1);
}

// ─── Load report ──────────────────────────────────────────────────────────────

let report;
try {
  report = JSON.parse(readFileSync(resolve(reportPath), 'utf8'));
} catch (err) {
  console.error(`Failed to read report: ${err.message}`);
  process.exit(1);
}

// ─── Validate env ─────────────────────────────────────────────────────────────

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY;
const GITHUB_PR_NUMBER = process.env.GITHUB_PR_NUMBER;
const GITHUB_SHA = process.env.GITHUB_SHA;

if (!GITHUB_TOKEN || !GITHUB_REPOSITORY || !GITHUB_PR_NUMBER) {
  console.error('Missing required env vars: GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_PR_NUMBER');
  process.exit(1);
}

const [owner, repo] = GITHUB_REPOSITORY.split('/');
const prNumber = parseInt(GITHUB_PR_NUMBER, 10);

// ─── GitHub API helpers ───────────────────────────────────────────────────────

const API_BASE = 'https://api.github.com';

async function ghFetch(path, options = {}) {
  const url = `${API_BASE}${path}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      'User-Agent': '4ge-dfe-action/1.0.0',
      ...options.headers,
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '(no body)');
    throw new Error(`GitHub API error ${response.status} on ${path}: ${body.slice(0, 200)}`);
  }

  return response.json();
}

// ─── Format a single finding as a review comment body ─────────────────────────

function formatFinding(finding) {
  const severityEmoji = {
    CRITICAL: 'P0',
    HIGH: 'P1',
    MEDIUM: 'P2',
    LOW: 'P3',
  }[finding.severity] || 'P3';

  const passLabel = finding.pass || 'DFE';
  const confidence = finding.confidence || 'Uncertain';

  return [
    `**[${severityEmoji}/${finding.severity}] ${passLabel}: ${finding.title}**`,
    '',
    `**Evidence:** ${finding.evidence || '(see diff)'}`,
    '',
    `**Reality:** ${finding.reality || '(see finding)'}`,
    '',
    `**Fix:** ${finding.fix || '(see finding)'}`,
    '',
    `*Confidence: ${confidence} | Pass: ${passLabel}*`,
    '',
    `<sub>4ge DFE adversarial review</sub>`,
  ].join('\n');
}

// ─── Format summary comment ────────────────────────────────────────────────────

function formatSummary(report) {
  const { verdict, stats, findings, passes_run } = report;
  const passErrors = Array.isArray(report.pass_errors) ? report.pass_errors : [];
  const isReportOnly = report.fail_on_severity === 'NONE';

  const passTable = [];

  // Summarise by pass
  const passCounts = {};
  for (const f of findings) {
    if (!passCounts[f.pass]) passCounts[f.pass] = { total: 0, critical: 0, high: 0 };
    passCounts[f.pass].total++;
    if (f.severity === 'CRITICAL') passCounts[f.pass].critical++;
    if (f.severity === 'HIGH') passCounts[f.pass].high++;
  }

  const passNames = {
    P1: 'EXISTENCE',
    P2: 'SECURITY',
    P3: 'LOGIC',
    P4: 'RUNTIME',
    P5: 'ARTIFACTS',
    P6: 'PROVENANCE',
  };

  const runPasses = passes_run === 6
    ? ['P1', 'P2', 'P3', 'P4', 'P5', 'P6']
    : ['P1', 'P2', 'P3'];

  for (const pid of runPasses) {
    const counts = passCounts[pid] || { total: 0, critical: 0, high: 0 };
    const statusIcon = counts.total === 0 ? 'CLEAN' : counts.critical > 0 || counts.high > 0 ? 'BLOCKED' : 'RISK';
    passTable.push(`| ${pid}: ${passNames[pid]} | ${statusIcon} | ${counts.total} |`);
  }

  const verdictLine = verdict === 'CLEAN'
    ? 'No issues found.'
    : verdict === 'RISK'
      ? `${stats.total} findings — review before merging.`
      : `${stats.critical} CRITICAL + ${stats.high} HIGH findings — do not merge.`;

  const modeLines = isReportOnly
    ? ['', '> Report-only mode: this review is posted as COMMENT and does not request changes.']
    : [];

  const errorLines = passErrors.length === 0
    ? []
    : [
      '',
      '### Pass errors',
      '',
      ...passErrors.map((item) => `- ${item.pass || 'DFE'}: ${item.error || 'unknown error'}`),
    ];

  return [
    `## 4ge DFE Review — ${verdict}`,
    '',
    `**Passes run:** ${passes_run} | **Total findings:** ${stats.total} (CRITICAL: ${stats.critical}, HIGH: ${stats.high})`,
    ...modeLines,
    '',
    '| Pass | Verdict | Findings |',
    '|------|---------|----------|',
    ...passTable,
    '',
    verdictLine,
    ...errorLines,
    '',
    '<sub>Powered by [4ge DFE](https://github.com/turdpusher360/4ge) — adversarial AI code review</sub>',
  ].join('\n');
}

// ─── Get PR commits for comment anchoring ────────────────────────────────────

async function getLatestCommitSha() {
  if (GITHUB_SHA) return GITHUB_SHA;

  const pr = await ghFetch(`/repos/${owner}/${repo}/pulls/${prNumber}`);
  return pr.head.sha;
}

// ─── Fetch the PR file list (with patches) for diff-aware anchoring ───────────

/**
 * List every file in the PR, following pagination (GitHub caps a PR file page
 * at 100). Each entry carries `filename` and, unless the file is binary or too
 * large, a unified-diff `patch` we can map to commentable line numbers.
 */
async function getPrFiles() {
  const files = [];
  let page = 1;

  // Hard page ceiling as a safety valve against an unbounded loop.
  while (page <= 30) {
    const batch = await ghFetch(`/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=100&page=${page}`);
    if (!Array.isArray(batch) || batch.length === 0) break;
    files.push(...batch);
    if (batch.length < 100) break;
    page += 1;
  }

  return files;
}

// ─── Format findings that could not be anchored inline ───────────────────────

/**
 * Findings whose line is outside the diff (or which carry no location) cannot
 * be posted as inline comments. Previously these — and on an API rejection,
 * ALL findings — were silently lost to a summary-only review. Fold their detail
 * into the review body so nothing disappears.
 */
function formatUnanchored(findings) {
  if (findings.length === 0) return '';

  const items = findings.map((f) => {
    const loc = f.file ? `\`${f.file}${f.line ? `:${f.line}` : ''}\`` : '(no location)';
    return `- ${loc} — ${formatFinding(f)}`;
  });

  return [
    '',
    '---',
    '',
    `### Findings outside the diff (${findings.length})`,
    '',
    'These findings reference lines not present in this PR\'s diff, so they could not be anchored as inline comments:',
    '',
    ...items,
  ].join('\n');
}

// ─── Post inline review comments ─────────────────────────────────────────────

async function createReview(commitSha, findings, lineIndex) {
  const { stats } = report;

  // GitHub review event:
  //   APPROVE    → CLEAN (no HIGH/CRITICAL)
  //   COMMENT    → MEDIUM/LOW only
  //   REQUEST_CHANGES → HIGH/CRITICAL present
  let event;
  if (report.fail_on_severity === 'NONE') {
    event = 'COMMENT';
  } else if (report.verdict === 'BLOCKED') {
    event = 'REQUEST_CHANGES';
  } else if (stats.critical > 0 || stats.high > 0) {
    event = 'REQUEST_CHANGES';
  } else if (stats.total > 0) {
    event = 'COMMENT';
  } else {
    event = 'APPROVE';
  }

  // Partition findings by whether their line is actually present in the PR diff.
  // Anchorable findings become inline comments keyed by `line`+`side` (the file
  // line number on the head/new side) — NOT the legacy `position` integer, which
  // is a diff-relative offset, not a file line. Unanchorable findings fold into
  // the summary so their detail is never silently dropped.
  const anchorable = [];
  const unanchored = [];
  for (const f of findings) {
    if (isAnchorable(lineIndex, f.file, f.line)) anchorable.push(f);
    else unanchored.push(f);
  }

  const comments = anchorable.map((f) => ({
    path: f.file,
    line: f.line,
    side: 'RIGHT',
    body: formatFinding(f),
  }));

  const reviewBody = formatSummary(report) + formatUnanchored(unanchored);

  try {
    await ghFetch(`/repos/${owner}/${repo}/pulls/${prNumber}/reviews`, {
      method: 'POST',
      body: JSON.stringify({
        commit_id: commitSha,
        body: reviewBody,
        event,
        comments,
      }),
    });

    console.log(`Review posted: ${event} with ${comments.length} inline comments (${unanchored.length} folded into summary)`);
  } catch (err) {
    // Defensive fallback: if the inline batch is still rejected for any reason,
    // post a summary-only review with EVERY finding's detail folded into the body
    // so nothing is lost.
    console.warn(`Review with inline comments failed: ${err.message}`);
    console.log('Retrying with summary-only review (all findings folded into body)...');

    const fallbackBody = formatSummary(report) + formatUnanchored(findings);

    await ghFetch(`/repos/${owner}/${repo}/pulls/${prNumber}/reviews`, {
      method: 'POST',
      body: JSON.stringify({
        commit_id: commitSha,
        body: fallbackBody,
        event,
        comments: [],
      }),
    });

    console.log(`Summary review posted: ${event}`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

try {
  const commitSha = await getLatestCommitSha();
  console.log(`Posting review to PR #${prNumber} at commit ${commitSha.slice(0, 8)}`);

  // Map the PR diff to commentable line numbers so inline comments anchor only
  // to lines GitHub will accept (and out-of-diff findings degrade gracefully).
  const prFiles = await getPrFiles();
  const lineIndex = buildLineIndex(prFiles);
  const commentableLines = [...lineIndex.values()].reduce((n, s) => n + s.size, 0);
  console.log(`Diff index: ${lineIndex.size} files, ${commentableLines} commentable lines`);

  await createReview(commitSha, report.findings || [], lineIndex);

  console.log('GitHub review posted successfully');
} catch (err) {
  console.error(`Failed to post GitHub review: ${err.message}`);
  process.exit(1);
}
