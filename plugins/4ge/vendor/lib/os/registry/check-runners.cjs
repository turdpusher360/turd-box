'use strict';

/**
 * check-runners.cjs
 *
 * Pure evaluators for constraint-register.json check objects. **Corrected upstream review
 * (opus-review P2-4):** this module has NO SHELL-INJECTION surface — every spawn is
 * argv-array with `shell:false`, and it never writes to a persistent surface (no
 * `writeFileSync`/`crontab -`/etc. anywhere in this file — the ONLY crontab WRITE path is
 * `rearmCrontabLine()` in scripts/rig-sentinel.cjs, gated by an auto-only + enforced-only
 * filter). But it is NOT "zero mutation capability" in the general sense the earlier
 * comment claimed: `cmd` checks execute an **arbitrary binary with arbitrary argv** by
 * design (`{bin:'rm', args:['-rf','x']}` would run `rm -rf x` — no injection needed, since
 * the binary and args are explicit register data, not shell-parsed strings). The register
 * is a reviewed, PR-able artifact (that's the whole design premise — "the enforcement layer
 * lives OUTSIDE .claude/", spec §2), so this is a residual to disclose honestly, not a hole:
 * a `cmd` check's `bin`/`args` are as trusted as any other register field, and the (not-yet-
 * built) monthly reconciliation sweep only ever *proposes* a register patch for human review,
 * never applies one unattended.
 *
 * upstream battery constraint (reprised in the upstream design's HARD RULES): every `cmd`/`grep` check
 * executes via arg-array spawn with `shell:false` — no string interpolated into a shell. The
 * upstream adversarial battery proved an arg-injection surface on this rig; `spawnSync(bin, args)`
 * with an explicit argv array never touches a shell parser, so a malicious `pattern`/`file`/`args`
 * value in a corrupted register can, at worst, become a literal (harmless) argv token — it cannot
 * break out into `; rm -rf` style injection. This holds for EVERY check type below, including
 * `crontab-line`'s read (`crontab -l`, no interpolation) — the crontab-line WRITE (rearm) lives in
 * rig-sentinel.cjs, also argv-only.
 *
 * Check types (see the schema for full field docs):
 *   grep            — spawn the `grep` binary (`-E -q`) against a file; pass = pattern found.
 *   grep-absent     — same evaluator, inverted; a missing FILE also counts as "absent" (pass).
 *   json-path       — read+parse a JSON file, resolve a dot path, optionally compare to `expect`.
 *   json-path-absent — pass = the dot path does NOT resolve (or the file itself is unreadable).
 *   cmd             — spawn an arbitrary binary with an argv array; exit-code + optional stdout
 *                     assertions (`expectStdoutContains`, `expectStdoutNotContains`,
 *                     `expectStdoutEmpty`, `stdoutNumberAtMost`).
 *   heartbeat       — file mtime age in hours, pass if <= maxAgeHours.
 *   crontab-line    — pass if a regex matches somewhere in `crontab -l` output.
 *
 * `evaluateCheck(checkOrArray, repoRoot)` accepts either a single check object or an array of
 * check objects (AND semantics — every entry must pass). This is how the register expresses
 * compound checks (e.g. agent-cap-8: a grep on the constant AND a `cmd` running its test file)
 * without inventing a combinator field.
 *
 * `{{MEMORY_INDEX}}` is the one supported symbolic path token — it resolves to this rig's
 * auto-memory index (~/.claude/projects/<slug>/memory/MEMORY.md, slug derived EXACTLY the way
 * os-boot.cjs and feedback-ratchet.cjs already derive it: `cwd.replace(/[/_]/g, '-')`). The
 * memory dir lives outside the repo, so a register entry can't reference it with a normal
 * repo-relative path.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const DEFAULT_TIMEOUT_MS = 8000;

/**
 * Mirrors os-boot.cjs:207 / feedback-ratchet.cjs computeMemorySlug() exactly. Do not
 * "improve" this independently of those two — all three must agree on the same directory.
 */
function computeMemorySlug(repoRoot) {
  return (repoRoot || process.cwd()).replace(/[/_]/g, '-');
}

function resolvePath(file, repoRoot) {
  if (file === '{{MEMORY_INDEX}}') {
    return path.join(os.homedir(), '.claude', 'projects', computeMemorySlug(repoRoot), 'memory', 'MEMORY.md');
  }
  if (path.isAbsolute(file)) return file;
  return path.join(repoRoot || process.cwd(), file);
}

function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Dot-path resolver distinguishing "absent" from "present but falsy/null". */
function getAtPath(obj, dotPath) {
  const parts = String(dotPath).split('.');
  let cur = obj;
  for (const part of parts) {
    if (cur === null || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, part)) {
      return { found: false, value: undefined };
    }
    cur = cur[part];
  }
  return { found: true, value: cur };
}

function runGrep(check, repoRoot) {
  const resolved = resolvePath(check.file, repoRoot);
  if (!fs.existsSync(resolved)) {
    return { ok: false, detail: `grep: file not found: ${check.file}` };
  }
  const args = ['-E', '-q', ...(Array.isArray(check.flags) ? check.flags : []), check.pattern, resolved];
  const r = spawnSync('grep', args, { shell: false, timeout: check.timeoutMs || DEFAULT_TIMEOUT_MS });
  if (r.error) return { ok: false, detail: `grep: spawn error: ${r.error.message}` };
  const found = r.status === 0;
  return { ok: found, detail: `grep -E -q '${check.pattern}' ${check.file} -> ${found ? 'found' : 'not found'}` };
}

function runGrepAbsent(check, repoRoot) {
  const resolved = resolvePath(check.file, repoRoot);
  if (!fs.existsSync(resolved)) {
    // A missing file trivially has no match — pattern is absent by definition.
    return { ok: true, detail: `grep-absent: file not found (trivially absent): ${check.file}` };
  }
  const inner = runGrep(check, repoRoot);
  return { ok: !inner.ok, detail: inner.detail.replace(/^grep:/, 'grep-absent:') };
}

function runJsonPath(check, repoRoot) {
  const resolved = resolvePath(check.file, repoRoot);
  let data;
  try {
    data = readJsonFile(resolved);
  } catch (err) {
    return { ok: false, detail: `json-path: cannot read/parse ${check.file}: ${err.message}` };
  }
  const { found, value } = getAtPath(data, check.path);
  if (!found) return { ok: false, detail: `json-path: ${check.path} absent in ${check.file}` };
  if (Object.prototype.hasOwnProperty.call(check, 'expect')) {
    const ok = value === check.expect;
    return { ok, detail: `json-path: ${check.path} = ${JSON.stringify(value)} (expect ${JSON.stringify(check.expect)}) -> ${ok}` };
  }
  const ok = value !== null && value !== undefined;
  return { ok, detail: `json-path: ${check.path} present -> ${ok}` };
}

function runJsonPathAbsent(check, repoRoot) {
  const resolved = resolvePath(check.file, repoRoot);
  let data;
  try {
    data = readJsonFile(resolved);
  } catch {
    // Unreadable/missing file: the path is trivially absent from it.
    return { ok: true, detail: `json-path-absent: ${check.path} absent (file unreadable/missing: ${check.file})` };
  }
  const { found } = getAtPath(data, check.path);
  return { ok: !found, detail: `json-path-absent: ${check.path} ${found ? 'PRESENT (violation)' : 'absent'} in ${check.file}` };
}

/**
 * upstream review P1-C: the sentinel runs under the WSL user crontab, which has NO `PATH=` line
 * (verified `crontab -l`), so cron's default PATH (`/usr/bin:/bin`) resolves `node` to the
 * apt-installed v18.19.1, not this project's nvm-managed v25.9.0 the sentinel itself runs
 * under (invoked via the crontab's absolute nvm path). Proven empirically during the review:
 * `PATH=/usr/bin:/bin npx vitest --version` throws `SyntaxError` under v18 (can't load vite);
 * the identical command under nvm v25.9.0 runs clean. Every `cmd` check whose `bin` is
 * `node`/`npx`/`npm` (or any other PATH-resolved tool) must resolve to the SAME runtime this
 * process is running under, not whatever cron's bare default PATH happens to find.
 *
 * Fix: prepend (never replace) `path.dirname(process.execPath)` to the child's PATH. Since
 * this process is itself invoked via the absolute nvm node path in the crontab line,
 * `process.execPath` IS that nvm v25.9.0 binary, and `npx`/`npm` live alongside `node` in the
 * same bin directory — prepending puts them first in PATH resolution while leaving every
 * other PATH-resolved bin (`grep`, `systemctl`, `curl`, `git`, `crontab`, `stat`) unaffected,
 * since those aren't nvm-version-sensitive and this directory rarely if ever shadows them.
 *
 * The seed set's "every enforced check observed passing live" proof (upstream build report) ran
 * in the INTERACTIVE shell (nvm-activated PATH), not the cron environment — this fix plus a
 * re-verification under a cron-equivalent env (`env -i HOME=$HOME PATH=/usr/bin:/bin <nvm-node>
 * scripts/rig-sentinel.cjs --dry-run`) is what makes that proof hold for the environment the
 * checks actually run in.
 */
function cmdChildEnv() {
  const nodeBinDir = path.dirname(process.execPath);
  return {
    ...process.env,
    PATH: `${nodeBinDir}${path.delimiter}${process.env.PATH || ''}`,
  };
}

function runCmd(check, repoRoot) {
  const cwd = check.cwd ? resolvePath(check.cwd, repoRoot) : (repoRoot || process.cwd());
  // Resolve the {{MEMORY_INDEX}} symbolic token inside individual argv entries too (not just
  // check.file) — a `cmd` check like `stat --format=%s {{MEMORY_INDEX}}` needs its target path
  // resolved the same way a `heartbeat`/`grep` check.file would be. Only the exact-match token
  // is substituted; everything else passes through as a literal argv string (no interpolation).
  const rawArgs = Array.isArray(check.args) ? check.args : [];
  const args = rawArgs.map((a) => (a === '{{MEMORY_INDEX}}' ? resolvePath(a, repoRoot) : a));
  const r = spawnSync(check.bin, args, {
    cwd,
    shell: false,
    encoding: 'utf8',
    timeout: check.timeoutMs || DEFAULT_TIMEOUT_MS,
    env: cmdChildEnv(),
  });
  if (r.error) return { ok: false, detail: `cmd: ${check.bin} spawn error: ${r.error.message}` };
  const expectExitCode = Object.prototype.hasOwnProperty.call(check, 'expectExitCode') ? check.expectExitCode : 0;
  const stdout = r.stdout || '';
  let ok = r.status === expectExitCode;
  const reasons = [`exit=${r.status} (expect ${expectExitCode})`];

  if (typeof check.expectStdoutContains === 'string') {
    const has = stdout.includes(check.expectStdoutContains);
    ok = ok && has;
    reasons.push(`stdoutContains(${JSON.stringify(check.expectStdoutContains)})=${has}`);
  }
  if (typeof check.expectStdoutNotContains === 'string') {
    const has = stdout.includes(check.expectStdoutNotContains);
    ok = ok && !has;
    reasons.push(`stdoutNotContains(${JSON.stringify(check.expectStdoutNotContains)})=${!has}`);
  }
  if (check.expectStdoutEmpty === true) {
    const empty = stdout.trim() === '';
    ok = ok && empty;
    reasons.push(`stdoutEmpty=${empty}`);
  }
  if (typeof check.stdoutNumberAtMost === 'number') {
    const n = parseFloat(stdout.trim());
    const within = Number.isFinite(n) && n <= check.stdoutNumberAtMost;
    ok = ok && within;
    reasons.push(`stdoutNumber=${Number.isFinite(n) ? n : 'NaN'} atMost ${check.stdoutNumberAtMost} -> ${within}`);
  }

  return { ok, detail: `cmd: ${check.bin} ${args.join(' ')} -> ${reasons.join(', ')}` };
}

function runHeartbeat(check, repoRoot) {
  const resolved = resolvePath(check.file, repoRoot);
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    return { ok: false, detail: `heartbeat: file missing: ${check.file}` };
  }
  const ageHours = (Date.now() - stat.mtimeMs) / 3600000;
  const ok = ageHours <= check.maxAgeHours;
  return { ok, detail: `heartbeat: ${check.file} age=${ageHours.toFixed(2)}h (max ${check.maxAgeHours}h) -> ${ok}` };
}

/**
 * Read-only. The ONLY crontab WRITE path in this whole feature lives in rig-sentinel.cjs's
 * rearmCrontabLine(). `overrideFn`, when provided, is called instead of spawning the real
 * `crontab` binary — this is how tests exercise crontab-line checks (including via
 * rig-sentinel.cjs's runSentinel({ crontabIo })) without ever touching the real system
 * crontab. Production code paths never pass an override; only test fixtures do.
 *
 * **upstream review P1-A fix.** Returns THREE distinct shapes, not two — this distinction is
 * load-bearing for `rearmCrontabLine`'s read-modify-write safety, not cosmetic:
 *   - a string (possibly `''`) — the crontab was read successfully. `''` specifically means
 *     "genuinely no crontab exists for this user" (`crontab -l` exits 1 with a
 *     "no crontab for <user>" stderr message on every standard cron implementation) — a real,
 *     legitimate state that a rearm may safely treat as "start from empty."
 *   - `null` — the read FAILED for an unknown/unexpected reason (spawn error, timeout, an
 *     exit code that ISN'T the documented "no crontab" case). The caller must NOT treat this
 *     as empty. Before this fix, `readCrontab()` collapsed every failure into `''`, so a
 *     transient `crontab -l` blip (spawn timeout, EAGAIN, crond hiccup) while a real crontab
 *     DID exist would make `rearmCrontabLine`'s read-modify-write compute `next = <one line>`
 *     and overwrite the ENTIRE crontab with just the rearmed line — destroying every other
 *     scheduled job (memory-batcher, memory-prune, janitor-weekly, rig-blackbox) AND the
 *     sentinel's own line, silently disabling itself. `rearmCrontabLine()` now aborts on
 *     `null` rather than writing.
 */
function readCrontab(overrideFn) {
  if (typeof overrideFn === 'function') return overrideFn();
  const r = spawnSync('crontab', ['-l'], { shell: false, encoding: 'utf8', timeout: DEFAULT_TIMEOUT_MS });
  if (r.error) return null; // spawn-level failure (ENOENT, timeout) — cannot distinguish from a real crontab, must not be treated as empty
  if (r.status === 0) return r.stdout || '';
  const stderr = r.stderr || '';
  if (r.status === 1 && /no crontab for/i.test(stderr)) return ''; // genuinely empty — the one legitimate non-zero-exit case
  return null; // unexpected non-zero exit — treat as a read failure, not "empty"
}

function runCrontabLine(check, _repoRoot, opts) {
  let re;
  try {
    re = new RegExp(check.pattern, 'm');
  } catch (err) {
    return { ok: false, detail: `crontab-line: invalid pattern: ${err.message}` };
  }
  const content = readCrontab(opts && opts.readCrontab);
  if (content === null) {
    // Read failure is a check FAIL, never a silent pass and never coerced into the string
    // "null" via naive regex.test(null) — this is a genuine "cannot verify" state.
    return { ok: false, detail: 'crontab-line: crontab read failed (transient error) — cannot verify, treating as fail' };
  }
  const ok = re.test(content);
  return { ok, detail: `crontab-line: /${check.pattern}/ -> ${ok ? 'present' : 'MISSING'}` };
}

const EVALUATORS = Object.freeze({
  'grep': runGrep,
  'grep-absent': runGrepAbsent,
  'json-path': runJsonPath,
  'json-path-absent': runJsonPathAbsent,
  'cmd': runCmd,
  'heartbeat': runHeartbeat,
  'crontab-line': runCrontabLine,
});

function evaluateSingle(check, repoRoot, opts) {
  if (!check || typeof check.type !== 'string') {
    return { ok: false, detail: 'malformed check: missing type' };
  }
  const fn = EVALUATORS[check.type];
  if (!fn) return { ok: false, detail: `unknown check type: ${check.type}` };
  try {
    return fn(check, repoRoot, opts);
  } catch (err) {
    return { ok: false, detail: `check threw: ${err && err.message ? err.message : String(err)}` };
  }
}

/**
 * Evaluate a check field (single object or AND-array). Returns null-shaped result
 * ({ok:null}) for an absent check — callers (doctrine-only/retiring entries with no
 * check yet) must treat that as "not evaluated", not as a failure.
 *
 * @param {object|object[]|undefined|null} checkOrArray
 * @param {string} repoRoot
 * @param {{ readCrontab?: () => string }} [opts] — test-only injection point; see readCrontab().
 * @returns {{ ok: boolean|null, detail: string, results: Array<{ok:boolean,detail:string}> }}
 */
function evaluateCheck(checkOrArray, repoRoot, opts) {
  if (checkOrArray == null) return { ok: null, detail: 'no check defined', results: [] };
  const list = Array.isArray(checkOrArray) ? checkOrArray : [checkOrArray];
  const results = list.map((c) => evaluateSingle(c, repoRoot, opts));
  const ok = results.every((r) => r.ok);
  const detail = results.map((r) => r.detail).join(' AND ');
  return { ok, detail, results };
}

module.exports = {
  evaluateCheck,
  resolvePath,
  computeMemorySlug,
  readCrontab,
  DEFAULT_TIMEOUT_MS,
};
