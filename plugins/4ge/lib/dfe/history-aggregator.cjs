// lib/dfe/history-aggregator.cjs
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REPORT_PATTERNS = [/dumb-fuck/i, /dfe-/i];

// Primary: ### [CRITICAL|HIGH|MEDIUM|LOW] P[0-3].[Category]: [Title]
// Also: #### variant
const FINDING_RE = /^#{2,4}\s+(?:(?:CRITICAL|HIGH|MEDIUM|LOW)\s+)?P([0-3])\.(\w+):\s*(.+)$/;
// Fallback: P[0-3].Category: without heading prefix (older reports)
const FINDING_FALLBACK_RE = /^P([0-3])\.(\w+):\s*(.+)$/;
// File reference
const FILE_RE = /^-?\s*File:\s*(.+?):(\d+)/;

/**
 * Amendment A6: Recursively find report files matching REPORT_PATTERNS.
 * Scans subdirectories (e.g., _runs/review/) so DFE reports are found
 * regardless of whether they are in the root _runs/ or a subdirectory.
 * @param {string} dir - Directory to scan
 * @returns {string[]} Array of absolute file paths
 */
function findReportFiles(dir) {
  const results = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findReportFiles(fullPath));
    } else if (entry.name.endsWith('.md') && REPORT_PATTERNS.some((p) => p.test(entry.name))) {
      results.push(fullPath);
    }
  }
  return results;
}

/**
 * Aggregate DFE reports from a runs directory.
 * @param {Object} opts
 * @param {string} [opts.runsDir] - Directory to scan recursively (default: _runs/)
 * @param {string} [opts.file] - Filter findings by file path
 * @param {string} [opts.category] - Filter findings by category
 * @returns {Object} Aggregated results
 */
function aggregate(opts = {}) {
  const runsDir = opts.runsDir || path.join(process.cwd(), '_runs');
  const filterFile = opts.file || null;
  const filterCategory = opts.category || null;

  if (!fs.existsSync(runsDir)) {
    return emptyResult();
  }

  // Amendment A6: Recursive scan to find reports in subdirectories (e.g., _runs/review/)
  const filePaths = findReportFiles(runsDir);

  if (filePaths.length === 0) {
    return emptyResult();
  }

  const allFindings = [];

  for (const filePath of filePaths) {
    const file = path.basename(filePath);
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    let currentFinding = null;

    for (const line of lines) {
      // Try primary pattern
      let match = line.match(FINDING_RE);
      if (!match) match = line.match(FINDING_FALLBACK_RE);

      if (match) {
        if (currentFinding) allFindings.push(currentFinding);
        currentFinding = {
          severity: `P${match[1]}`,
          category: match[2].toUpperCase(),
          title: match[3].trim(),
          file: null,
          line: null,
          report: file,
        };
        continue;
      }

      const fileMatch = line.match(FILE_RE);
      if (fileMatch && currentFinding) {
        currentFinding.file = fileMatch[1].trim();
        currentFinding.line = parseInt(fileMatch[2], 10);
      }
    }

    if (currentFinding) allFindings.push(currentFinding);
  }

  // Apply filters
  let findings = allFindings;
  if (filterFile) {
    findings = findings.filter((f) => f.file === filterFile);
  }
  if (filterCategory) {
    findings = findings.filter((f) => f.category === filterCategory.toUpperCase());
  }

  // Compute severity breakdown
  const bySeverity = { P0: 0, P1: 0, P2: 0, P3: 0 };
  for (const f of findings) {
    if (bySeverity[f.severity] !== undefined) bySeverity[f.severity]++;
  }

  // Compute hot spots (files with most findings)
  const fileMap = {};
  for (const f of findings) {
    if (!f.file) continue;
    if (!fileMap[f.file]) fileMap[f.file] = { file: f.file, finding_count: 0, categories: new Set() };
    fileMap[f.file].finding_count++;
    fileMap[f.file].categories.add(f.category);
  }
  const hotSpots = Object.values(fileMap)
    .map((h) => ({ ...h, categories: [...h.categories] }))
    .sort((a, b) => b.finding_count - a.finding_count);

  // Compute recurring patterns (same category + normalized title appearing 2+ times)
  const patternMap = {};
  for (const f of findings) {
    const key = `${f.category}::${f.title.toLowerCase()}`;
    if (!patternMap[key]) {
      patternMap[key] = { category: f.category, pattern: f.title, count: 0, last_seen: '' };
    }
    patternMap[key].count++;
    // Extract date from report filename (YYYY-MM-DD)
    const dateMatch = f.report.match(/(\d{4}-\d{2}-\d{2})/);
    if (dateMatch && dateMatch[1] > patternMap[key].last_seen) {
      patternMap[key].last_seen = dateMatch[1];
    }
  }
  const recurringPatterns = Object.values(patternMap)
    .filter((p) => p.count >= 2)
    .sort((a, b) => b.count - a.count);

  // File matches (for --file filter)
  const fileMatches = filterFile
    ? findings.filter((f) => f.file === filterFile).map((f) => ({
        file: f.file,
        line: f.line,
        severity: f.severity,
        category: f.category,
        title: f.title,
      }))
    : [];

  return {
    total_reports: filePaths.length,
    total_findings: findings.length,
    by_severity: bySeverity,
    hot_spots: hotSpots,
    recurring_patterns: recurringPatterns,
    file_matches: fileMatches,
  };
}

function emptyResult() {
  return {
    total_reports: 0,
    total_findings: 0,
    by_severity: { P0: 0, P1: 0, P2: 0, P3: 0 },
    hot_spots: [],
    recurring_patterns: [],
    file_matches: [],
  };
}

// CLI entry point
if (require.main === module) {
  const args = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--file' && args[i + 1]) opts.file = args[++i];
    if (args[i] === '--category' && args[i + 1]) opts.category = args[++i];
  }
  const result = aggregate(opts);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

module.exports = { aggregate };
