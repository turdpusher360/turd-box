#!/usr/bin/env node
'use strict';

/**
 * emit-pill.cjs — FORGE PILL v1 emitter (campaign transition kit).
 *
 * Renders the session-transition pill from live git + the session cartridge +
 * the campaign board + OPERATOR-QUEUE.md, per spec §6.2–§6.3
 * (docs/superpowers/specs/2026-07-28-s610-campaign-design.md, DOC-ARC-029) and
 * plan Task 1 (docs/superpowers/plans/2026-07-28-s610-campaign.md, v1.0.1).
 *
 * Contract highlights:
 *   - Live git beats cartridge (pill design constraints 1–2): HEAD/branch come from
 *     execGit at emit time; the cartridge supplies momentum + shipped range.
 *   - Fail-open everywhere: any missing source omits its line;
 *     repo:/HEAD/verify:/NEXT: always render.
 *   - Hard cap PILL_MAX_LINES, enforced deterministically: drop `lanes:`
 *     detail first, then excess tripwires, then truncate — never hard-fail
 *     on overflow.
 *   - Dual-home: scripts/emit-pill.cjs + plugins/4ge/bin/emit-pill.cjs are
 *     byte-identical (everything derives from cwd — the rotate-continuity
 *     dual-home precedent). Verify with cmp.
 *
 * CLI: node scripts/emit-pill.cjs [--out <path>]  (default _runs/pill-latest.md)
 * Prints the RAW pill to stdout — fencing is /signoff's presentation layer
 * (spec §6.3/§6.5). Exit 0 on success; exit 1 with a stderr warning on hard
 * failure (/signoff Step 7.5 is the fail-open wrapper).
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Spec §6.2 hard cap. Exported so tests assert the RELATIONSHIP (rendered
// lines <= this constant), never a literal pin (execution-conventions
// pinned-moving-value rule).
const PILL_MAX_LINES = 25;

// Canonical §6.2 format block — byte-identical to the spec's fenced content
// (10 template lines; the canonical copy lands in docs/transition-kit.md via
// T4, which quotes this constant verbatim and parity-tests doc == constant).
// This is the ANNOTATED template: the bracket notes (`[omitted if no
// campaign]`, `[board carries detail]`) are documentation. renderPill NEVER
// emits the annotations.
const PILL_FORMAT = `FORGE PILL v1 — lead to verify, not authority (docs/transition-kit.md)
repo: /absolute/path/to/repo   branch: main   HEAD: <sha12>
verify: git rev-parse --short=12 HEAD == above -> adopt; else reconcile first
campaign: <id> C<n>/10 (Block <X>) <state>           [omitted if no campaign]
shipped: <range> — <one-line summary from cartridge momentum>
lanes: <lane:state, lane:state>                       [board carries detail]
NEXT: <one action — the next board move>
tripwires: <up to 3, semicolon-separated>
operator-pending: <n> open rows — OPERATOR-QUEUE.md
emitted: <ISO8601> by /signoff step 7.5
`;

// Literal render lines derive from the template so the rendered header/verify
// lines and the contract constant cannot drift apart byte-wise.
const TEMPLATE_LINES = PILL_FORMAT.split('\n');
const HEADER_LINE = TEMPLATE_LINES[0];
const VERIFY_LINE = TEMPLATE_LINES[2];

const CAMPAIGN_STATES = ['pending', 'active', 'held', 'closed'];
const TRIPWIRE_MAX = 3; // spec §6.2 grammar: "up to 3, semicolon-separated"
const NEXT_FALLBACK = 'reconcile — no cartridge next available';

/**
 * Default execGit factory: thin execSync wrapper. Injectable in
 * collectPillInputs so everything is testable without a live repo.
 */
function makeExecGit(cwd) {
  return function execGit(args) {
    return execSync('git ' + args, {
      cwd: cwd || process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  };
}

/**
 * Count data rows of the `## Open` table in OPERATOR-QUEUE.md text: lines
 * matching /^\|/ within the section, minus the header + separator rows.
 * Returns a number, or null on parse failure / non-string input (fail-open —
 * null omits the operator-pending line).
 */
function countOpenQueueRows(text) {
  if (typeof text !== 'string') return null;
  try {
    const lines = text.split('\n');
    const start = lines.findIndex((l) => /^##\s+Open\b/.test(l));
    if (start === -1) return null;
    let pipeRows = 0;
    for (let i = start + 1; i < lines.length; i++) {
      if (/^##\s/.test(lines[i])) break;
      if (/^\|/.test(lines[i])) pipeRows++;
    }
    return Math.max(0, pipeRows - 2);
  } catch {
    return null;
  }
}

/** Fail-open JSON file read: object or null, never throws. */
function readJsonFailOpen(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Gather pill inputs. Every source is fail-open: a missing/unreadable source
 * yields a null/empty field, and renderPill omits its line.
 *
 * @param {object} opts
 * @param {string} [opts.cwd]                repo root (defaults process.cwd())
 * @param {object|null} [opts.cartridge]     parsed _runs/session-cartridge.json
 * @param {object|null} [opts.campaign]      parsed _runs/forge-board/campaign.json
 * @param {function} [opts.execGit]          injectable git runner (args string -> stdout)
 * @param {string|null} [opts.operatorQueueText]  OPERATOR-QUEUE.md text; null = omit;
 *        undefined = read <cwd>/OPERATOR-QUEUE.md fail-open (the only fs touch here)
 * @returns {object} inputs for renderPill
 */
function collectPillInputs(opts) {
  const o = opts || {};
  const cwd = o.cwd || process.cwd();
  const execGit = typeof o.execGit === 'function' ? o.execGit : makeExecGit(cwd);

  // Live git beats cartridge (pill design constraints 1–2, spec §6.3).
  // DFE-06 truth path: a git call that THROWS is recorded as gitFailed so the
  // rendered HEAD line says UNKNOWN and the CLI exits non-zero, instead of a
  // quiet "unknown" that reads like a missing input.
  let head;
  let branch;
  let gitFailed = false;
  try {
    head = execGit('rev-parse --short=12 HEAD') || null;
  } catch {
    head = null;
    gitFailed = true;
  }
  try {
    branch = execGit('branch --show-current') || null;
  } catch {
    branch = null;
    gitFailed = true;
  }

  const cart = o.cartridge && typeof o.cartridge === 'object' ? o.cartridge : null;
  const momentum = cart && cart.momentum && typeof cart.momentum === 'object' ? cart.momentum : null;

  // shipped: range from git.recent_commits (git-log order: newest first, so
  // range = oldestSha..newestSha) + one-line summary from momentum.summary.
  let shipped = null;
  if (cart) {
    const commits =
      cart.git && Array.isArray(cart.git.recent_commits) ? cart.git.recent_commits : [];
    let range = null;
    if (commits.length > 0) {
      const shaOf = (line) => String(line).trim().split(/\s+/)[0];
      const newest = shaOf(commits[0]);
      const oldest = shaOf(commits[commits.length - 1]);
      range = commits.length === 1 ? newest : oldest + '..' + newest;
    }
    const summary =
      momentum && typeof momentum.summary === 'string' && momentum.summary.trim()
        ? momentum.summary.trim()
        : null;
    if (range || summary) shipped = { range, summary };
  }

  // campaign: all four fields required, else unreadable -> line omitted.
  // Displayed C-number rule (spec §6.2 grammar): pending = next square not
  // yet opened, so position 0 pending renders C1.
  let campaign = null;
  const c = o.campaign && typeof o.campaign === 'object' ? o.campaign : null;
  if (
    c &&
    typeof c.campaign_id === 'string' &&
    c.campaign_id.length > 0 &&
    Number.isInteger(c.position) &&
    c.position >= 0 &&
    typeof c.block === 'string' &&
    c.block.length > 0 &&
    CAMPAIGN_STATES.indexOf(c.state) !== -1
  ) {
    const displayed = c.state === 'pending' ? c.position + 1 : Math.max(c.position, 1);
    campaign = { id: c.campaign_id, displayed, block: c.block, state: c.state };
  }

  // lanes: projection of campaign board block states when the consumed
  // campaign object carries them (spec §6.3 constraint 5 — the lanes: line
  // names states, the board carries detail). No blocks -> no lanes line.
  let lanes = null;
  if (c && c.blocks && typeof c.blocks === 'object' && !Array.isArray(c.blocks)) {
    const pairs = Object.keys(c.blocks).map((k) => {
      const b = c.blocks[k];
      const status = b && typeof b.status === 'string' && b.status ? b.status : 'unknown';
      return k + ':' + status;
    });
    if (pairs.length > 0) lanes = pairs;
  }

  // NEXT always renders: momentum.next, then the literal fallback.
  const next =
    momentum && typeof momentum.next === 'string' && momentum.next.trim()
      ? momentum.next.trim()
      : NEXT_FALLBACK;

  // tripwires: momentum.blockers truncated to TRIPWIRE_MAX (spec §6.2).
  let tripwires = [];
  if (momentum && Array.isArray(momentum.blockers)) {
    tripwires = momentum.blockers
      .filter((b) => typeof b === 'string' && b.trim())
      .map((b) => b.trim())
      .slice(0, TRIPWIRE_MAX);
  }

  // operator-pending: explicit text param wins; undefined + cwd -> read the
  // file fail-open; null -> omit.
  let queueText = o.operatorQueueText;
  if (queueText === undefined && cwd) {
    try {
      queueText = fs.readFileSync(path.join(cwd, 'OPERATOR-QUEUE.md'), 'utf8');
    } catch {
      queueText = null;
    }
  }
  const operatorPending = countOpenQueueRows(queueText);

  return { repo: cwd, branch, head, gitFailed, campaign, shipped, lanes, next, tripwires, operatorPending };
}

/**
 * Assemble pill lines for one degradation stage.
 * opts: { includeLanes: boolean, tripCount: number, emittedAt: string }
 */
function assembleLines(inp, opts) {
  const lines = [];
  lines.push(HEADER_LINE);
  lines.push(
    'repo: ' +
      (inp.repo || 'unknown') +
      '   branch: ' +
      (inp.branch || 'unknown') +
      '   HEAD: ' +
      (inp.gitFailed
        ? 'UNKNOWN (git failed: verify HEAD by hand before adopting this pill)'
        : (inp.head || 'unknown')),
  );
  lines.push(VERIFY_LINE);
  if (inp.campaign) {
    lines.push(
      'campaign: ' +
        inp.campaign.id +
        ' C' +
        inp.campaign.displayed +
        '/10 (Block ' +
        inp.campaign.block +
        ') ' +
        inp.campaign.state,
    );
  }
  if (inp.shipped && (inp.shipped.range || inp.shipped.summary)) {
    const parts = [inp.shipped.range, inp.shipped.summary].filter(Boolean);
    lines.push('shipped: ' + parts.join(' — '));
  }
  if (opts.includeLanes && inp.lanes && inp.lanes.length > 0) {
    lines.push('lanes: ' + inp.lanes.join(', '));
  }
  // Exactly ONE NEXT: line (spec §6.2) — internal newlines collapse so the
  // one-action contract holds even against a multi-line momentum.next.
  lines.push('NEXT: ' + String(inp.next || NEXT_FALLBACK).replace(/\s*\n\s*/g, ' '));
  if (opts.tripCount > 0 && inp.tripwires.length > 0) {
    lines.push('tripwires: ' + inp.tripwires.slice(0, opts.tripCount).join('; '));
  }
  if (typeof inp.operatorPending === 'number') {
    lines.push('operator-pending: ' + inp.operatorPending + ' open rows — OPERATOR-QUEUE.md');
  }
  lines.push('emitted: ' + opts.emittedAt + ' by /signoff step 7.5');
  return lines;
}

/**
 * Render the pill. Line count <= PILL_MAX_LINES enforced deterministically:
 * drop the `lanes:` detail first, then excess tripwires (one at a time, then
 * the line), then truncate to the cap — never hard-fail on overflow.
 */
function renderPill(inputs) {
  const raw = inputs && typeof inputs === 'object' ? inputs : {};
  const inp = {
    repo: raw.repo || null,
    branch: raw.branch || null,
    head: raw.head || null,
    gitFailed: !!raw.gitFailed,
    campaign: raw.campaign || null,
    shipped: raw.shipped || null,
    lanes: Array.isArray(raw.lanes) ? raw.lanes : null,
    next: raw.next || NEXT_FALLBACK,
    tripwires: Array.isArray(raw.tripwires) ? raw.tripwires : [],
    operatorPending: typeof raw.operatorPending === 'number' ? raw.operatorPending : null,
  };
  const emittedAt = new Date().toISOString();
  const countLines = (t) => t.split('\n').length;

  let includeLanes = !!(inp.lanes && inp.lanes.length > 0);
  let tripCount = Math.min(inp.tripwires.length, TRIPWIRE_MAX);
  let text = assembleLines(inp, { includeLanes, tripCount, emittedAt }).join('\n');

  if (countLines(text) > PILL_MAX_LINES && includeLanes) {
    includeLanes = false; // 1) drop lanes detail — the board carries it
    text = assembleLines(inp, { includeLanes, tripCount, emittedAt }).join('\n');
  }
  while (countLines(text) > PILL_MAX_LINES && tripCount > 0) {
    tripCount--; // 2) drop excess tripwires
    text = assembleLines(inp, { includeLanes, tripCount, emittedAt }).join('\n');
  }
  if (countLines(text) > PILL_MAX_LINES) {
    // 3) last resort: truncate. The pill stays a pill; it never hard-fails.
    text = text.split('\n').slice(0, PILL_MAX_LINES).join('\n');
  }
  return text;
}

/**
 * Atomic write (spec §6.3): tmp sibling + fs.renameSync. Parent directory is
 * created if absent (the lattice-observer ENOENT class, HANDOFF-S609.md).
 */
function writePillAtomic(outPath, text) {
  const dir = path.dirname(outPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, path.basename(outPath) + '.' + process.pid + '.tmp');
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, outPath);
}

function main(argv) {
  const args = argv.slice(2);
  let out = path.join('_runs', 'pill-latest.md');
  const flagIdx = args.indexOf('--out');
  if (flagIdx !== -1) {
    if (!args[flagIdx + 1]) {
      process.stderr.write('[emit-pill] --out requires a path argument\n');
      return 1;
    }
    out = args[flagIdx + 1];
  }
  try {
    const cwd = process.cwd();
    const cartridge = readJsonFailOpen(path.join(cwd, '_runs', 'session-cartridge.json'));
    const campaign = readJsonFailOpen(path.join(cwd, '_runs', 'forge-board', 'campaign.json'));
    // operatorQueueText stays undefined -> collect reads OPERATOR-QUEUE.md fail-open.
    const inputs = collectPillInputs({ cwd, cartridge, campaign });
    const pill = renderPill(inputs);
    writePillAtomic(path.resolve(cwd, out), pill + '\n');
    process.stdout.write(pill + '\n');
    if (inputs.gitFailed) {
      // The pill is written (it says UNKNOWN) but the run is not a success.
      process.stderr.write('[emit-pill] git failed: HEAD is UNKNOWN in the pill; do not adopt it unverified\n');
      return 1;
    }
    return 0;
  } catch (err) {
    process.stderr.write(
      '[emit-pill] FAILED: ' + (err && err.message ? err.message : String(err)) + '\n',
    );
    return 1;
  }
}

if (require.main === module) {
  process.exit(main(process.argv));
}

module.exports = {
  PILL_MAX_LINES,
  PILL_FORMAT,
  collectPillInputs,
  renderPill,
  writePillAtomic,
};
