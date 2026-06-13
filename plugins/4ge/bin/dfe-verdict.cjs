#!/usr/bin/env node
'use strict';

// dfe-verdict.cjs — deterministic renderer for the /dfe 6-pass verdict block.
//
// PURPOSE: the marketplace dfe-review screenshot was a
// contract-true RECONSTRUCTION because no standalone renderer existed for the
// /dfe verdict surface. This module is that renderer: a pure function of an
// input JSON state document, so screenshot capture (and any future surface)
// can render REAL output instead of hand-built mockups — same doctrine as the
// statusline's real-ANSI xterm capture (see the screenshot-truth doctrine in the project docs).
//
// OUTPUT CONTRACT: /dfe display (plugins/4ge/commands/dfe.md Step 6) uses
// plugins/4ge/skills/wizard-engine/references/output-format.md Components
// 8 (Status Table, per-pass verdict), 3 (Finding Row), 1 (Score Bar) — plain
// monospace text, NO ANSI, no color, no borders (anti-patterns 6-8). Because
// the contract is ANSI-free, `--mode=ansi` (default) and `--mode=plain` emit
// byte-identical output; the flag exists for CLI uniformity with the repo's
// other renderers (hud-engine.cjs) and as a defensive strip in plain mode.
//
// DERIVED FIELDS (output-format.md formulas — not accepted as input, so the
// render can never contradict its own scores):
//   grade  = A 90-100 | B 75-89 | C 55-74 | D 35-54 | F 0-34   (confidence)
//   bar    = 20 chars, '=' filled '-' empty, fill = round(confidence/100*20)
//   clean  = count of passes with status PASS
//   total findings = severity.p0 + p1 + p2 + p3
//
// DETERMINISM: same input JSON -> byte-identical stdout. No wall clock, no
// randomness, no env-dependent branches. Timestamps/dates arrive in the input
// (e.g. inside reportPath).
//
// USAGE:
//   node plugins/4ge/bin/dfe-verdict.cjs --mode=plain \
//     < plugins/4ge/bin/examples/dfe-verdict.example.json
//   node plugins/4ge/bin/dfe-verdict.cjs --schema
//
// INPUT SCHEMA (also printed by --schema):
//   {
//     command?:   string           // default "/dfe"
//     target:     { path: string, files: int, lines: int }
//     scan?:      { current: int, total: int, label: string }
//     passes:     [ { num: int, name: string, status: "PASS"|"WARN"|"FAIL",
//                     detail: string, findings: int } ]   // 1..9 rows
//     severity:   { p0: int, p1: int, p2: int, p3: int }
//     confidence: int 0-100
//     reportPath: string
//   }

const SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'dfe-verdict input',
  type: 'object',
  required: ['target', 'passes', 'severity', 'confidence', 'reportPath'],
  additionalProperties: false,
  properties: {
    command: { type: 'string' },
    target: {
      type: 'object',
      required: ['path', 'files', 'lines'],
      properties: {
        path: { type: 'string' },
        files: { type: 'integer', minimum: 0 },
        lines: { type: 'integer', minimum: 0 },
      },
    },
    scan: {
      type: 'object',
      required: ['current', 'total', 'label'],
      properties: {
        current: { type: 'integer', minimum: 0 },
        total: { type: 'integer', minimum: 1 },
        label: { type: 'string' },
      },
    },
    passes: {
      type: 'array',
      minItems: 1,
      maxItems: 9,
      items: {
        type: 'object',
        required: ['num', 'name', 'status', 'detail', 'findings'],
        properties: {
          num: { type: 'integer', minimum: 1 },
          name: { type: 'string' },
          status: { enum: ['PASS', 'WARN', 'FAIL'] },
          detail: { type: 'string' },
          findings: { type: 'integer', minimum: 0 },
        },
      },
    },
    severity: {
      type: 'object',
      required: ['p0', 'p1', 'p2', 'p3'],
      properties: {
        p0: { type: 'integer', minimum: 0 },
        p1: { type: 'integer', minimum: 0 },
        p2: { type: 'integer', minimum: 0 },
        p3: { type: 'integer', minimum: 0 },
      },
    },
    confidence: { type: 'integer', minimum: 0, maximum: 100 },
    reportPath: { type: 'string' },
  },
};

const MAX_WIDTH = 79;
const STATUSES = ['PASS', 'WARN', 'FAIL'];

function isInt(v) { return Number.isInteger(v); }
function isStr(v) { return typeof v === 'string'; }

function fit(str, max) {
  if (str.length <= max) return str;
  return str.slice(0, Math.max(0, max - 3)) + '...';
}

// 1247 -> "1,247" without locale/ICU dependence (determinism).
function group(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// output-format.md Component 1 thresholds.
function gradeOf(pct) {
  if (pct >= 90) return 'A';
  if (pct >= 75) return 'B';
  if (pct >= 55) return 'C';
  if (pct >= 35) return 'D';
  return 'F';
}

function barOf(pct) {
  const fill = Math.round((pct / 100) * 20);
  return '='.repeat(fill) + '-'.repeat(20 - fill);
}

function validate(input) {
  const errors = [];
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return ['input must be a JSON object'];
  }
  if (input.command !== undefined && !isStr(input.command)) errors.push('command must be a string');
  if (!input.target || typeof input.target !== 'object') {
    errors.push('target is required ({path, files, lines})');
  } else {
    if (!isStr(input.target.path) || !input.target.path) errors.push('target.path must be a non-empty string');
    if (!isInt(input.target.files) || input.target.files < 0) errors.push('target.files must be an integer >= 0');
    if (!isInt(input.target.lines) || input.target.lines < 0) errors.push('target.lines must be an integer >= 0');
  }
  if (input.scan !== undefined) {
    const s = input.scan;
    if (!s || typeof s !== 'object' || !isInt(s.current) || !isInt(s.total) || s.total < 1 || !isStr(s.label)) {
      errors.push('scan must be {current: int, total: int >= 1, label: string}');
    }
  }
  if (!Array.isArray(input.passes) || input.passes.length < 1 || input.passes.length > 9) {
    errors.push('passes must be an array of 1-9 pass rows');
  } else {
    input.passes.forEach((p, i) => {
      if (!p || !isInt(p.num) || p.num < 1) errors.push(`passes[${i}].num must be an integer >= 1`);
      if (!p || !isStr(p.name) || !p.name) errors.push(`passes[${i}].name must be a non-empty string`);
      if (!p || !STATUSES.includes(p.status)) errors.push(`passes[${i}].status must be one of ${STATUSES.join('|')}`);
      if (!p || !isStr(p.detail)) errors.push(`passes[${i}].detail must be a string`);
      if (!p || !isInt(p.findings) || p.findings < 0) errors.push(`passes[${i}].findings must be an integer >= 0`);
    });
  }
  if (!input.severity || typeof input.severity !== 'object') {
    errors.push('severity is required ({p0, p1, p2, p3})');
  } else {
    for (const k of ['p0', 'p1', 'p2', 'p3']) {
      if (!isInt(input.severity[k]) || input.severity[k] < 0) errors.push(`severity.${k} must be an integer >= 0`);
    }
  }
  if (!isInt(input.confidence) || input.confidence < 0 || input.confidence > 100) {
    errors.push('confidence must be an integer 0-100');
  }
  if (!isStr(input.reportPath) || !input.reportPath) errors.push('reportPath must be a non-empty string');
  return errors;
}

// Component 8 derivative (per-pass verdict row):
//   Pass {num}  {name:11}  {status:4}   {detail:37}  {findings}
function passRow(p) {
  const line = `  Pass ${p.num}  ${fit(p.name, 11).padEnd(11)}  ${p.status.padEnd(4)}   ${fit(p.detail, 37).padEnd(37)}  ${p.findings}`;
  return fit(line.replace(/\s+$/, ''), MAX_WIDTH);
}

function render(input) {
  const command = input.command || '/dfe';
  const sections = [];

  const stats = ` (${group(input.target.files)} files, ${group(input.target.lines)} lines)`;
  sections.push([
    `${command} — ${input.passes.length}-pass adversarial review`,
    `  Target: ${fit(input.target.path, MAX_WIDTH - 10 - stats.length)}${stats}`,
  ].join('\n'));

  if (input.scan) {
    sections.push(`  Scanning [${input.scan.current}/${input.scan.total}] ${fit(input.scan.label, 40)} ...`);
  }

  sections.push(input.passes.map(passRow).join('\n'));

  const sev = input.severity;
  const total = sev.p0 + sev.p1 + sev.p2 + sev.p3;
  const clean = input.passes.filter((p) => p.status === 'PASS').length;
  sections.push([
    `  VERDICT: ${total} findings (${sev.p0} P0, ${sev.p1} P1, ${sev.p2} P2, ${sev.p3} P3)`,
    `  Confidence: ${input.confidence}  ${gradeOf(input.confidence)}  [${barOf(input.confidence)}]   Passes: ${clean}/${input.passes.length} clean`,
  ].join('\n'));

  sections.push(`  Reports: ${fit(input.reportPath, MAX_WIDTH - 11)}`);

  return sections.join('\n\n') + '\n';
}

// Plain mode defensively strips ANSI; the contract output contains none, so
// both modes are byte-identical by design (output-format.md anti-patterns 6-8).
function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

function main() {
  const args = process.argv.slice(2);
  let mode = 'ansi';
  for (const arg of args) {
    if (arg === '--schema') {
      process.stdout.write(JSON.stringify(SCHEMA, null, 2) + '\n');
      return 0;
    }
    if (arg.startsWith('--mode=')) mode = arg.split('=')[1];
  }
  if (mode !== 'ansi' && mode !== 'plain') {
    process.stderr.write(`dfe-verdict: unknown mode "${mode}" (ansi|plain)\n`);
    return 1;
  }

  let raw;
  try {
    raw = require('node:fs').readFileSync(0, 'utf8');
  } catch {
    raw = '';
  }
  if (!raw.trim()) {
    process.stderr.write('dfe-verdict: expected a JSON state document on stdin (see --schema)\n');
    return 1;
  }
  let input;
  try {
    input = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`dfe-verdict: invalid JSON on stdin: ${err.message}\n`);
    return 1;
  }
  const errors = validate(input);
  if (errors.length > 0) {
    process.stderr.write(`dfe-verdict: invalid input:\n${errors.map((e) => `  - ${e}`).join('\n')}\n`);
    return 1;
  }
  const out = render(input);
  process.stdout.write(mode === 'plain' ? stripAnsi(out) : out);
  return 0;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = { render, validate, SCHEMA, gradeOf, barOf };
