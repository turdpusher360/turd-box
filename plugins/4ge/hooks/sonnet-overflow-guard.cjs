#!/usr/bin/env node
// sonnet-overflow-guard.cjs — PreToolUse hook on Agent + Workflow.
//
// Blocks the recurring "Prompt is too long" / invalid_request overflow: a Sonnet-tier
// (200K) agent tasked with output-heavy research (web/memory fetches, multi-source comb)
// WITHOUT disk-first/bounded discipline accumulates raw fetched content past its window
// and dies. Failure class: feedback_agent-output-overflow.
//
// Surfaces covered:
//   - Agent tool: tool_input.model === 'sonnet' + tool_input.prompt
//   - Workflow tool: a model:'sonnet' literal inside tool_input.script (where it bit us in
//     agent(..., {model:'sonnet'}) probes doing WebFetch/comb). A hook cannot see a
//     workflow's internal per-agent spawns, but scanning the submitted script text is enough.
//
// Tiered: DENY the clear combo (sonnet + heavy + no discipline);
// WARN the soft combo (sonnet + heavy + discipline present). Escape: ALLOW_SONNET_HEAVY=1.
//
// Dual-use: pure check(input) + standalone stdin entry (mirrors agent-mode-required.cjs).
// Fail-open on bad JSON / timeout. No deps. <100ms.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const HEAVY = /\bWebFetch\b|\bWebSearch\b|web[-\s]?research|\bcomb(?:ing|s|ed)?\b|multi[-\s]?source|research[\s\S]{0,80}\b(?:all|every|comprehensive|exhaustive|deep|full|each)\b|\bfetch(?:es|ing)?\b[\s\S]{0,60}\bpages?\b|memory[_-]?search[\s\S]{0,40}\b(?:all|every|many|comb)\b/i;
const DISCIPLINE_A = /disk[-\s]?first|do(?:n['’]?t| not)\s+(?:paste|hoard|dump|carry|accumulate)|_runs\//i;
const DISCIPLINE_B = /\bbounded\b|summari[sz]e[\s\S]{0,40}discard|\bdistilled\b|reportPath|\blimit\b\s*[<:=]|cap(?:ped)?\s+(?:web)?fetch|<=\s*\d+\s+sources|return only/i;
const SONNET_LITERAL = /model\s*[:=]\s*['"]sonnet['"]/i;

function isDisciplined(text) {
  return DISCIPLINE_A.test(text) || DISCIPLINE_B.test(text);
}

function readEnvFlag() {
  // Read the override flag without an enumeration primitive.
  return (process.env && process.env.ALLOW_SONNET_HEAVY) === '1';
}

function audit(entry) {
  try {
    const dir = path.join(process.cwd(), '_runs');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'sonnet-overflow-guard.jsonl'), JSON.stringify(entry) + '\n');
  } catch (_) { /* fail-safe: never block on an audit error */ }
}

function denyMsg(tool) {
  return [
    '[sonnet-overflow-guard] BLOCKED: Sonnet + output-heavy research without disk-first/bounded discipline.',
    '',
    'This is the "Prompt is too long" / invalid_request overflow class (feedback_agent-output-overflow):',
    'a 200K-context Sonnet agent doing web/memory fetches or multi-source comb accumulates raw fetched',
    'content past its window and dies.',
    '',
    'Detected in this ' + tool + " dispatch: model 'sonnet' + heavy-research markers, no disk-first/bounded discipline.",
    '',
    'Fix ONE of:',
    "  - model: 'opus'  (1M context, absorbs heavy fetch/comb volume), OR",
    '  - add disk-first + bounded discipline: write detail to _runs/, return only distilled findings,',
    '    cap fetches (e.g. "<=6 sources, summarize then discard").',
    '',
    'Deliberate override: set ALLOW_SONNET_HEAVY=1 in the env.',
    '',
  ].join('\n');
}

function warnMsg(tool) {
  return '[sonnet-overflow-guard] NOTE (' + tool + '): sonnet + output-heavy markers detected; '
    + 'discipline present so allowed. Verify the disk-first/bounded discipline actually caps context, '
    + 'or use opus for headroom.\n';
}

/**
 * Pure check. Returns { deny, exitCode?, stderr?, warn?, stderrWarn? }.
 * deny=true -> PreToolUse block (exit 2 + stderr). warn=true -> allow + stderr note (exit 0).
 */
function check(input) {
  if (!input) return { deny: false };
  const tool = input.tool_name;
  if (tool !== 'Agent' && tool !== 'Workflow') return { deny: false };
  const ti = input.tool_input || {};

  let targetSonnet;
  let text;
  if (tool === 'Agent') {
    targetSonnet = ti.model === 'sonnet';
    text = String(ti.prompt || '');
  } else {
    text = String(ti.script || '');
    targetSonnet = SONNET_LITERAL.test(text);
  }

  if (!targetSonnet || !HEAVY.test(text)) return { deny: false };

  if (isDisciplined(text)) {
    return { deny: false, warn: true, stderrWarn: warnMsg(tool) };
  }
  if (readEnvFlag()) {
    return { deny: false, warn: true, stderrWarn: '[sonnet-overflow-guard] ALLOW_SONNET_HEAVY=1 - overflow guard bypassed for this ' + tool + ' dispatch.\n' };
  }
  return { deny: true, exitCode: 2, stderr: denyMsg(tool) };
}

module.exports = { check };

if (require.main === module) {
  const chunks = [];
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => chunks.push(c));
  process.stdin.on('end', () => {
    let input;
    try { input = JSON.parse(chunks.join('')); }
    catch (_e) { process.exit(0); }
    const v = check(input);
    if (v && v.deny) {
      audit({ ts: new Date().toISOString(), tool: input.tool_name, decision: 'deny' });
      if (v.stderr) process.stderr.write(v.stderr);
      process.exit(v.exitCode || 2);
    }
    if (v && v.warn) {
      audit({ ts: new Date().toISOString(), tool: input.tool_name, decision: 'warn' });
      if (v.stderrWarn) process.stderr.write(v.stderrWarn);
    }
    process.exit(0);
  });
  setTimeout(() => { process.stderr.write('sonnet-overflow-guard: stdin timeout\n'); process.exit(0); }, 5000);
}
