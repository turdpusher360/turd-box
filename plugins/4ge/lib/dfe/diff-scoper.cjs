// lib/dfe/diff-scoper.cjs
'use strict';

const { execSync } = require('node:child_process');
const path = require('node:path');

const SAFE_REF = /^[a-zA-Z0-9_.~^/-]+$/;

function validateRef(ref) {
  if (!ref || !SAFE_REF.test(ref)) {
    throw new Error(`Invalid git ref: ${ref}`);
  }
  return ref;
}

/**
 * Parse `git diff --name-status` output into structured file entries.
 * @param {string} raw - Raw git output
 * @returns {Array<{path: string, status: string, oldPath?: string}>}
 */
function parseNameStatus(raw) {
  if (!raw || !raw.trim()) return [];
  const lines = raw.trim().split('\n');
  const results = [];
  for (const line of lines) {
    const parts = line.split('\t');
    if (parts.length < 2) continue;
    const statusCode = parts[0].charAt(0);
    if (statusCode === 'R') {
      results.push({ path: parts[2], status: 'renamed', oldPath: parts[1] });
    } else if (statusCode === 'A') {
      results.push({ path: parts[1], status: 'added' });
    } else if (statusCode === 'D') {
      results.push({ path: parts[1], status: 'deleted' });
    } else if (statusCode === 'M') {
      results.push({ path: parts[1], status: 'modified' });
    } else if (statusCode === 'C') {
      results.push({ path: parts[2], status: 'copied', oldPath: parts[1] });
    } else {
      results.push({ path: parts[1], status: 'unknown' });
    }
  }
  return results;
}

/**
 * Parse unified diff output into per-file hunk information.
 * @param {string} raw - Raw unified diff output
 * @returns {Object<string, {hunks: Array<{start: number, count: number, lines: string[]}>}>}
 */
function parseUnifiedDiff(raw) {
  if (!raw || !raw.trim()) return {};
  const result = {};
  let currentFile = null;
  let currentHunk = null;

  const lines = raw.split('\n');
  for (const line of lines) {
    const fileMatch = line.match(/^\+\+\+ b\/(.+)$/);
    if (fileMatch) {
      currentFile = fileMatch[1];
      if (!result[currentFile]) {
        result[currentFile] = { hunks: [] };
      }
      continue;
    }

    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (hunkMatch && currentFile) {
      currentHunk = {
        start: parseInt(hunkMatch[1], 10),
        count: parseInt(hunkMatch[2] || '1', 10),
        lines: [],
      };
      result[currentFile].hunks.push(currentHunk);
      continue;
    }

    if (currentHunk && (line.startsWith('+') || line.startsWith('-') || line.startsWith(' '))) {
      currentHunk.lines.push(line);
    }
  }

  return result;
}

/**
 * Extract newly added dependencies from a unified diff that includes package.json.
 * @param {string} raw - Raw unified diff output
 * @returns {string[]} Array of new dependency package names
 */
function extractNewDeps(raw) {
  if (!raw || !raw.includes('package.json')) return [];
  const deps = [];
  const lines = raw.split('\n');
  let inPackageJson = false;

  for (const line of lines) {
    if (line.startsWith('+++ b/') && path.basename(line.slice(6)) === 'package.json') {
      inPackageJson = true;
      continue;
    }
    if (line.startsWith('+++ b/') && path.basename(line.slice(6)) !== 'package.json') {
      inPackageJson = false;
      continue;
    }
    if (inPackageJson && line.startsWith('+') && !line.startsWith('+++')) {
      const depMatch = line.match(/^\+\s*"([^"]+)":\s*"/);
      if (depMatch) {
        const name = depMatch[1];
        // Skip non-package fields
        if (!['version', 'description', 'main', 'scripts', 'type', 'license', 'name'].includes(name)) {
          deps.push(name);
        }
      }
    }
  }
  return deps;
}

/**
 * Run diff-scoper against a git ref or base branch.
 * @param {Object} opts
 * @param {string} [opts.ref] - Git ref to diff against (e.g., 'HEAD~1')
 * @param {string} [opts.base] - Base branch to compare (e.g., 'main')
 * @returns {Object} Structured diff scope result
 */
function scope(opts = {}) {
  const exec = opts.exec || execSync;
  const ref = opts.ref || 'HEAD~1';
  validateRef(ref);
  if (opts.base) validateRef(opts.base);
  const diffTarget = opts.base ? `${opts.base}...HEAD` : ref;

  let nameStatusRaw = '';
  let unifiedRaw = '';

  try {
    nameStatusRaw = exec(`git diff --name-status ${diffTarget}`, {
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (err) {
    process.stderr.write(`[diff-scoper] name-status failed: ${err.message}\n`);
  }

  try {
    unifiedRaw = exec(`git diff --unified=3 ${diffTarget}`, {
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (err) {
    process.stderr.write(`[diff-scoper] unified diff failed: ${err.message}\n`);
  }

  const fileEntries = parseNameStatus(nameStatusRaw);
  const hunkMap = parseUnifiedDiff(unifiedRaw);
  const newDeps = extractNewDeps(unifiedRaw);

  // Merge hunk data into file entries
  const files = fileEntries.map((entry) => {
    const hunkData = hunkMap[entry.path];
    const hunks = hunkData ? hunkData.hunks : [];
    const totalChangedLines = hunks.reduce((sum, h) => {
      return sum + h.lines.filter((l) => l.startsWith('+') || l.startsWith('-')).length;
    }, 0);
    return { ...entry, hunks, total_changed_lines: totalChangedLines };
  });

  const summary = {
    added: files.filter((f) => f.status === 'added').length,
    modified: files.filter((f) => f.status === 'modified').length,
    deleted: files.filter((f) => f.status === 'deleted').length,
    total_lines: files.reduce((sum, f) => sum + f.total_changed_lines, 0),
  };

  return { ref: opts.base ? `${opts.base}...HEAD` : ref, files, new_deps: newDeps, summary };
}

// CLI entry point
if (require.main === module) {
  const args = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--ref' && args[i + 1]) { opts.ref = args[++i]; }
    if (args[i] === '--base' && args[i + 1]) { opts.base = args[++i]; }
  }
  const result = scope(opts);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

module.exports = { parseNameStatus, parseUnifiedDiff, extractNewDeps, scope };
