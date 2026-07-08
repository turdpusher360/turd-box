#!/usr/bin/env node
'use strict';

/**
 * rotate-continuity.cjs
 *
 * Bounds the live continuity files read during closeout by rotating overflow
 * verbatim into archive siblings:
 *
 *   TASKING.md  `## Current Sprint` rows  -> _runs/tasking-archive.md
 *   _runs/.decisions.jsonl                -> _runs/.decisions.archive.jsonl
 *
 * Dry-run is the default. Pass --apply to mutate. The default target root is
 * the current working directory so the installed plugin can operate on the
 * active project; set CONTINUITY_ROOT to override.
 */

const fs = require('fs');
const path = require('path');

const KEEP_ROWS = 6;
const KEEP_DECISIONS = 50;

const ROOT = process.env.CONTINUITY_ROOT || process.cwd();
const TASKING = path.join(ROOT, 'TASKING.md');
const TASKING_ARCHIVE = path.join(ROOT, '_runs', 'tasking-archive.md');
const TASKING_MARKER = '## Archived Current Sprint session rows';
const DECISIONS = path.join(ROOT, '_runs', '.decisions.jsonl');
const DECISIONS_ARCHIVE = path.join(ROOT, '_runs', '.decisions.archive.jsonl');

const APPLY = process.argv.includes('--apply');
const out = (s) => process.stdout.write(`${s}\n`);
const fail = (s) => { process.stderr.write(`[rotate-continuity] ABORT: ${s}\n`); process.exit(1); };

function writeAtomic(filePath, content) {
  const tmp = `${filePath}.rotate-tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filePath);
}

function countLines(s) {
  if (s === '') return 0;
  return s.split('\n').length - (s.endsWith('\n') ? 1 : 0);
}

function rotateDecisions() {
  if (!fs.existsSync(DECISIONS)) { out('decisions: live file missing - skip'); return; }
  const raw = fs.readFileSync(DECISIONS, 'utf8');
  const lines = raw.split('\n').filter((l) => l.trim());
  if (lines.length <= KEEP_DECISIONS) {
    out(`decisions: ${lines.length} entries <= cap ${KEEP_DECISIONS} - nothing to rotate`);
    return;
  }
  const overflow = lines.slice(0, lines.length - KEEP_DECISIONS);
  const kept = lines.slice(lines.length - KEEP_DECISIONS);
  for (const l of overflow.concat(kept)) {
    try { JSON.parse(l); } catch { fail(`decisions: non-JSON line found; refusing to rotate: ${l.slice(0, 80)}`); }
  }
  if (overflow.length + kept.length !== lines.length) fail('decisions: conservation check failed');
  out(`decisions: rotating ${overflow.length} entries to archive, keeping ${kept.length} live`);
  if (!APPLY) return;
  fs.appendFileSync(DECISIONS_ARCHIVE, `${overflow.join('\n')}\n`);
  writeAtomic(DECISIONS, `${kept.join('\n')}\n`);
}

function rotateTasking() {
  if (!fs.existsSync(TASKING) || !fs.existsSync(TASKING_ARCHIVE)) {
    out('tasking: live or archive file missing - skip');
    return;
  }
  const liveRaw = fs.readFileSync(TASKING, 'utf8');
  const live = liveRaw.split('\n');
  const sprintIdx = live.findIndex((l) => l.startsWith('## Current Sprint'));
  if (sprintIdx === -1) fail('tasking: no ## Current Sprint heading');

  const rowStarts = [];
  let end = live.length;
  for (let i = sprintIdx + 1; i < live.length; i++) {
    const l = live[i];
    if (/^#{1,3} /.test(l) || l.startsWith('> **Archive pointer')) { end = i; break; }
    if (/^\d{4}-\d{2}-\d{2} /.test(l)) rowStarts.push(i);
  }
  if (rowStarts.length <= KEEP_ROWS) {
    out(`tasking: ${rowStarts.length} sprint rows <= cap ${KEEP_ROWS} - nothing to rotate`);
    return;
  }

  const cut = rowStarts[KEEP_ROWS];
  const overflow = live.slice(cut, end);
  const keptLive = live.slice(0, cut).concat(live.slice(end));
  if (keptLive.length + overflow.length !== live.length) fail('tasking: conservation check failed');
  out(`tasking: rotating ${rowStarts.length - KEEP_ROWS} rows (${overflow.length} lines) to archive, keeping ${KEEP_ROWS} live`);
  if (!APPLY) return;

  const archRaw = fs.readFileSync(TASKING_ARCHIVE, 'utf8');
  const arch = archRaw.split('\n');
  const markIdx = arch.findIndex((l) => l.startsWith(TASKING_MARKER));
  if (markIdx === -1) fail(`tasking: archive marker line not found in ${TASKING_ARCHIVE}`);
  const insertAt = markIdx + (arch[markIdx + 1] === '' ? 2 : 1);
  const newArch = arch.slice(0, insertAt).concat(overflow, arch.slice(insertAt));
  const before = countLines(liveRaw) + countLines(archRaw);
  const liveOut = keptLive.join('\n');
  const archOut = newArch.join('\n');
  const after = countLines(liveOut) + countLines(archOut);
  if (before !== after) fail(`tasking: post-splice line total mismatch (${before} != ${after})`);
  writeAtomic(TASKING_ARCHIVE, archOut);
  writeAtomic(TASKING, liveOut);
}

out(`[rotate-continuity] mode: ${APPLY ? 'APPLY' : 'dry-run (pass --apply to execute)'}`);
rotateDecisions();
rotateTasking();
out('[rotate-continuity] done');
