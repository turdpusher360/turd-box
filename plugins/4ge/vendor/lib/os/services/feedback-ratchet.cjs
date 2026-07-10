'use strict';

/**
 * feedback-ratchet.cjs
 *
 * Boot-time tripwire for the feedback-memory pile (R-08, upstream
 * recurring-failures register). Memory is the only zero-friction fold
 * surface in this repo's correction pipeline, so every doctrine correction
 * routes there and nothing counted or capped its growth -- the 7/06
 * postmortem declared consolidation at a baseline of 56 feedback_* files;
 * by upstream the pile had gone backward to 169 (~3x), unnoticed. This service
 * counts `feedback_*` entries in the live memory dir and compares against a
 * recorded baseline, WARNing on growth so the next regression cannot hide.
 *
 * The memory dir lives OUTSIDE the repo (`~/.claude/projects/<slug>/memory`)
 * so CI cannot see it -- boot time is the only enforcement surface.
 *
 * Fail-open by design: a missing memory dir, a missing/malformed baseline
 * file, or any unexpected internal throw all return the null-shape (no
 * output) rather than throwing or partial-reporting.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

/**
 * Replicate os-boot.cjs's cwd->slug derivation EXACTLY
 * (`.claude/hooks/os-boot.cjs:207`): `cwd.replace(/[/_]/g, '-')`. Do not
 * "improve" this -- callers rely on it matching the live memory dir path.
 *
 * @param {string} [cwd]
 * @returns {string}
 */
function computeMemorySlug(cwd) {
  const base = cwd || process.cwd();
  return base.replace(/[/_]/g, '-');
}

/**
 * Derive the default memory directory for a given cwd, mirroring os-boot.cjs.
 *
 * @param {string} [cwd]
 * @returns {string}
 */
function getDefaultMemoryDir(cwd) {
  const slug = computeMemorySlug(cwd);
  return path.join(os.homedir(), '.claude', 'projects', slug, 'memory');
}

/**
 * Check the feedback-memory pile against its recorded baseline.
 *
 * @param {{
 *   memoryDir?: string,
 *   baselinePath?: string,
 *   cwd?: string,
 *   repoRoot?: string,
 * }} [opts]
 * @returns {{
 *   count: number|null,
 *   baseline: number|null,
 *   warning: string|null,
 *   line: string|null,
 * }}
 */
function checkFeedbackRatchet(opts) {
  const options = opts || {};
  const NULL_SHAPE = { count: null, baseline: null, warning: null, line: null };

  try {
    const memoryDir = options.memoryDir || getDefaultMemoryDir(options.cwd);
    const baselinePath =
      options.baselinePath ||
      path.join(options.repoRoot || process.cwd(), 'lib', 'os', 'config', 'feedback-baseline.json');

    let entries;
    try {
      entries = fs.readdirSync(memoryDir, { withFileTypes: true });
    } catch {
      // The memory dir lives outside the repo and may legitimately be
      // absent (fresh checkout, different machine). Fail-open, no output.
      return NULL_SHAPE;
    }

    const count = entries.filter((e) => e.isFile() && /^feedback_/.test(e.name)).length;

    let baseline = null;
    try {
      const raw = fs.readFileSync(baselinePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && Number.isFinite(parsed.baseline)) {
        baseline = parsed.baseline;
      } else {
        return NULL_SHAPE;
      }
    } catch {
      return NULL_SHAPE;
    }

    const line = `feedback files: ${count} (baseline ${baseline})`;
    let warning = null;
    if (count > baseline) {
      warning = `feedback memory pile growing (${count} > baseline ${baseline}) — consolidate, don't accrete (upstream R-08)`;
    }

    return { count, baseline, warning, line };
  } catch {
    // Fail-open: a tripwire must never break boot.
    return NULL_SHAPE;
  }
}

module.exports = {
  checkFeedbackRatchet,
  computeMemorySlug,
  getDefaultMemoryDir,
};
