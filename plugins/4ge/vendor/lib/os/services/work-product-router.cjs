'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

/**
 * Template variable regex replacements for scan matching.
 * Converts SOP naming templates (e.g. "{date}-{sop_id}") to regexes.
 */
const TEMPLATE_REGEX_MAP = {
  '{date}': '\\d{4}-\\d{2}-\\d{2}',
  '{sop_id}': '[a-z][a-z0-9-]*',
  '{agent}': '[a-z][a-z0-9-]*',
  '{branch}': '[a-zA-Z0-9._/-]+',
};

/** Match date-based directory names like 2026-03-18 */
const DATE_DIR_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Resolve template variables in a naming string.
 * @param {string} template - e.g. "{date}-{sop_id}-report.md"
 * @param {object} vars - key/value pairs for substitution
 * @returns {string}
 */
function resolveTemplate(template, vars) {
  let result = template;
  for (const [key, val] of Object.entries(vars)) {
    result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), val);
  }
  return result;
}

/**
 * Convert a naming template to a regex for orphan matching.
 * @param {string} template
 * @returns {RegExp}
 */
function templateToRegex(template) {
  let pattern = template.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const [tmpl, regex] of Object.entries(TEMPLATE_REGEX_MAP)) {
    pattern = pattern.replace(tmpl.replace(/[{}]/g, '\\$&'), regex);
  }
  return new RegExp(`^${pattern}$`);
}

/**
 * Get current git branch name (worktree-safe).
 * @returns {string}
 */
function getCurrentBranch() {
  try {
    return execSync('git branch --show-current', { encoding: 'utf8', timeout: 5000, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Create a work-product router instance.
 * @param {string} stateDir - Directory for router state (pending-memory queue)
 * @returns {{ route, scan, manifest }}
 */
function createWorkProductRouter(stateDir) {

  /**
   * Route a work product file to its destination.
   */
  function route(outputPath, outputConfig) {
    const { destination, naming, also_store_memory, memory_tags } = outputConfig;

    // 1. Validate source exists
    if (!fs.existsSync(outputPath)) {
      return { ok: false, error: `source file not found: ${outputPath}` };
    }

    // 2. Ensure destination directory exists
    fs.mkdirSync(destination, { recursive: true });

    // 3. Resolve naming template
    const today = new Date().toISOString().slice(0, 10);
    const vars = {
      date: today,
      sop_id: outputConfig.sop_id || '',
      agent: outputConfig.agent || '',
      branch: getCurrentBranch(),
    };
    const resolvedName = resolveTemplate(naming, vars);

    // 4. Compute target path, handle collisions
    let target = path.join(destination, resolvedName);
    if (fs.existsSync(target)) {
      const ext = path.extname(resolvedName);
      const base = resolvedName.slice(0, -ext.length);
      let version = 2;
      while (fs.existsSync(path.join(destination, `${base}-v${version}${ext}`))) {
        version++;
      }
      target = path.join(destination, `${base}-v${version}${ext}`);
    }

    // 5. Move file
    try {
      fs.renameSync(outputPath, target);
    } catch (err) {
      if (err.code === 'EXDEV') {
        fs.copyFileSync(outputPath, target);
        fs.unlinkSync(outputPath);
      } else {
        return { ok: false, error: err.message };
      }
    }

    // 6. Queue memory if configured
    if (also_store_memory) {
      try {
        fs.mkdirSync(stateDir, { recursive: true });
        const queuePath = path.join(stateDir, 'pending-memory.jsonl');
        const entry = { path: target, tags: memory_tags || [], queued_at: new Date().toISOString() };
        fs.appendFileSync(queuePath, JSON.stringify(entry) + '\n');
      } catch { /* best-effort */ }
    }

    return { ok: true, moved_to: target, memory_queued: !!also_store_memory };
  }

  /**
   * Scan _runs/ for orphan, routed, historical, and unknown files.
   * @param {string} runsDir
   * @param {Array} sopDefs - array of SOP definition objects (need output.naming, output.destination)
   */
  function scan(runsDir, sopDefs) {
    const orphans = [];
    const routed = [];
    const historical = [];
    const unknown = [];

    if (!fs.existsSync(runsDir)) {
      return { orphans, routed, historical, unknown };
    }

    // Build naming regexes from SOP definitions
    const namingRegexes = (sopDefs || [])
      .filter(s => s.output && s.output.naming)
      .map(s => ({
        regex: templateToRegex(s.output.naming),
        dest: s.output.destination,
        sop: s,
      }));

    // Known destinations from SOPs
    const knownDests = new Set(
      (sopDefs || []).filter(s => s.output).map(s => path.basename(s.output.destination.replace(/\/$/, '')))
    );

    // Scan root-level .md files
    const entries = fs.readdirSync(runsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.md')) {
        const filePath = path.join(runsDir, entry.name);
        let matched = false;
        for (const nr of namingRegexes) {
          if (nr.regex.test(entry.name)) {
            orphans.push({ path: filePath, probable_sop: nr.sop.id || null, suggested_dest: nr.dest });
            matched = true;
            break;
          }
        }
        if (!matched) {
          unknown.push({ path: filePath });
        }
      } else if (entry.isDirectory()) {
        const dirPath = path.join(runsDir, entry.name);
        if (DATE_DIR_PATTERN.test(entry.name)) {
          // Date-based directory -> historical
          const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.md'));
          for (const f of files) {
            historical.push({ path: path.join(dirPath, f), date_dir: entry.name });
          }
        } else if (knownDests.has(entry.name)) {
          // Known SOP destination -> routed
          const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.md'));
          for (const f of files) {
            routed.push({ path: path.join(dirPath, f), domain: entry.name });
          }
        }
      }
    }

    return { orphans, routed, historical, unknown };
  }

  /**
   * Return all unique destinations from SOP definitions.
   */
  function manifest(sopDefs) {
    const destinations = {};
    for (const sop of (sopDefs || [])) {
      if (sop.output && sop.output.destination) {
        const domain = sop.domain || 'unknown';
        destinations[domain] = sop.output.destination;
      }
    }
    return { destinations };
  }

  return { route, scan, manifest };
}

module.exports = { createWorkProductRouter };
