'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SCHEMA = 'forge.dfe.diagnostics-index.v1';
const VERDICT_ORDER = Object.freeze({ CLEAN: 0, SMELLS: 1, FUCKED: 2 });

function normalizeVerdict(value) {
  const upper = String(value || '').toUpperCase();
  if (upper.includes('FUCKED')) return 'FUCKED';
  if (upper.includes('SMELLS')) return 'SMELLS';
  if (upper.includes('CLEAN')) return 'CLEAN';
  return 'SMELLS';
}

function inferPass(filePath) {
  const base = path.basename(filePath, path.extname(filePath)).toLowerCase();
  for (const pass of ['existence', 'logic', 'security', 'runtime', 'artifacts', 'adversarial']) {
    if (base.includes(pass)) return pass;
  }
  return base || 'unknown';
}

function parseSeverityCounts(text) {
  const counts = { p0: 0, p1: 0, p2: 0, p3: 0 };
  const statsMatch = text.match(/P0:\s*(\d+).*?P1:\s*(\d+).*?P2:\s*(\d+).*?P3:\s*(\d+)/is);
  if (statsMatch) {
    counts.p0 = Number(statsMatch[1]);
    counts.p1 = Number(statsMatch[2]);
    counts.p2 = Number(statsMatch[3]);
    counts.p3 = Number(statsMatch[4]);
  }
  return counts;
}

function parseReport(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const verdictLine =
    text.match(/DFE[-\sA-Z/]*REVIEW\s*--\s*(CLEAN|SMELLS|FUCKED)/i) ||
    text.match(/Verdict:\s*`?(CLEAN|SMELLS|FUCKED)`?/i) ||
    text.match(/DFE verdict:\s*(pass-with-risks|pass|fail)/i);
  let verdict = normalizeVerdict(verdictLine ? verdictLine[1] : '');
  if (verdictLine && /pass-with-risks/i.test(verdictLine[1])) verdict = 'SMELLS';
  if (verdictLine && /^pass$/i.test(verdictLine[1])) verdict = 'CLEAN';
  if (verdictLine && /^fail$/i.test(verdictLine[1])) verdict = 'FUCKED';

  const severity_counts = parseSeverityCounts(text);
  const pass = inferPass(filePath);
  const findings = [];
  const headingRe = /^#{2,6}\s+(?:[A-Z]+\s+)?(P[0-3])(?:\.[A-Z0-9_-]+)?:\s*(.+)$/gm;
  let match;
  while ((match = headingRe.exec(text)) !== null) {
    findings.push({
      id: `${pass}-${findings.length + 1}`,
      pass,
      severity: match[1].toUpperCase(),
      title: match[2].trim(),
      report_path: filePath,
      proof_plane: 'source',
    });
  }

  return {
    pass,
    path: filePath,
    verdict,
    severity_counts,
    findings,
    parse_status: 'ok',
  };
}

function isDfeReportFile(filePath) {
  const lower = path.basename(filePath).toLowerCase();
  return lower.endsWith('.md') &&
    !lower.includes('brief') &&
    /^dfe-(existence|logic|security|runtime|artifacts|adversarial)\b/.test(lower);
}

function listReportFiles(reportsDir) {
  if (!fs.existsSync(reportsDir)) return [];
  return fs.readdirSync(reportsDir)
    .filter(isDfeReportFile)
    .map((entry) => path.join(reportsDir, entry))
    .sort((a, b) => inferPass(a).localeCompare(inferPass(b)) || a.localeCompare(b));
}

function assessReportFiles(reportsDir, reportFiles = []) {
  if (!Array.isArray(reportFiles) || reportFiles.length === 0) {
    const files = listReportFiles(reportsDir);
    return { files, coverage: { declared: false, requested: [], missing: [], invalid: [], duplicate: [] } };
  }
  const requested = reportFiles.map((filePath) => path.resolve(filePath));
  const duplicate = [...new Set(requested.filter((filePath, i) => requested.indexOf(filePath) !== i))];
  const missing = requested.filter((filePath) => !fs.existsSync(filePath));
  const invalid = requested.filter((filePath) => fs.existsSync(filePath) && !isDfeReportFile(filePath));
  const files = [...new Set(requested)]
    .filter((filePath) => fs.existsSync(filePath) && isDfeReportFile(filePath))
    .sort((a, b) => inferPass(a).localeCompare(inferPass(b)) || a.localeCompare(b));
  if (files.length === 0) {
    throw new Error('No DFE reports found for diagnostics index');
  }
  return { files, coverage: { declared: true, requested, missing, invalid, duplicate } };
}

function resolveReportFiles(reportsDir, reportFiles = []) {
  return assessReportFiles(reportsDir, reportFiles).files;
}

function sumCounts(reports) {
  return reports.reduce((totals, report) => {
    totals.p0 += report.severity_counts.p0;
    totals.p1 += report.severity_counts.p1;
    totals.p2 += report.severity_counts.p2;
    totals.p3 += report.severity_counts.p3;
    return totals;
  }, { p0: 0, p1: 0, p2: 0, p3: 0 });
}

function overallVerdict(reports, totals) {
  if (totals.p0 > 0) return 'FUCKED';
  if (totals.p1 > 0) return 'SMELLS';
  return reports.reduce((current, report) => {
    return VERDICT_ORDER[report.verdict] > VERDICT_ORDER[current] ? report.verdict : current;
  }, 'CLEAN');
}

function buildDiagnosticsIndex(options = {}) {
  const reportsDir = path.resolve(options.reportsDir || process.cwd());
  const { files, coverage } = assessReportFiles(reportsDir, options.reportFiles);
  const reports = files.map(parseReport);
  const severity_totals = sumCounts(reports);
  // A declared report that is missing, invalid or repeated, or a discovery that
  // found nothing, is incomplete evidence: never reduce it to CLEAN.
  const complete = files.length > 0 && coverage.missing.length === 0
    && coverage.invalid.length === 0 && coverage.duplicate.length === 0;
  return {
    schema: SCHEMA,
    generated_at: new Date(0).toISOString(),
    reports_dir: reportsDir,
    overall_verdict: complete ? overallVerdict(reports, severity_totals) : 'INCOMPLETE',
    coverage: {
      declared: coverage.declared, requested: coverage.requested.length, found: files.length,
      missing: coverage.missing, invalid: coverage.invalid, duplicate: coverage.duplicate,
    },
    severity_totals,
    reports: reports.map(({ findings, ...report }) => report),
    findings: reports.flatMap((report) => report.findings),
    proof_planes: ['source'],
  };
}

function writeDiagnosticsIndex(options = {}) {
  const reportsDir = path.resolve(options.reportsDir || process.cwd());
  const index = buildDiagnosticsIndex({ reportsDir, reportFiles: options.reportFiles });
  const outputPath = path.join(reportsDir, 'index.json');
  fs.writeFileSync(outputPath, JSON.stringify(index, null, 2));
  return { ...index, output_path: outputPath };
}

if (require.main === module) {
  const reportsDir = process.argv[2] || process.cwd();
  const reportFiles = process.argv.slice(3);
  const written = writeDiagnosticsIndex({ reportsDir, reportFiles });
  process.stdout.write(`${written.output_path}\n`);
  if (written.overall_verdict === 'INCOMPLETE') {
    process.stderr.write(`[dfe] diagnostics index INCOMPLETE: ${written.coverage.missing.length} missing, ${written.coverage.invalid.length} invalid, ${written.coverage.duplicate.length} duplicate\n`);
    process.exitCode = 2;
  }
}

module.exports = {
  SCHEMA,
  buildDiagnosticsIndex,
  resolveReportFiles,
  writeDiagnosticsIndex,
};
