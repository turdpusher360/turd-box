#!/usr/bin/env node
'use strict';

// audit-render.cjs — deterministic renderer for the /4ge:audit dashboard.
//
// PURPOSE: the marketplace audit-dashboard screenshot was
// a contract-true RECONSTRUCTION because no standalone renderer existed for
// the /4ge:audit dashboard surface. This module is that renderer: a pure
// function of an input JSON state document, so screenshot capture (and any
// future surface) can render REAL output instead of hand-built mockups — same
// doctrine as the statusline's real-ANSI xterm capture
// (see the screenshot-truth doctrine in the project docs).
//
// OUTPUT CONTRACT: /4ge:audit dashboards are governed by
// plugins/4ge/skills/wizard-engine/references/output-format.md — plain
// monospace text, NO ANSI, no color, no borders (anti-patterns 6-8),
// Component 1 (Score Bar) + Component 2 (Category Row). Because the contract
// is ANSI-free, `--mode=ansi` (default) and `--mode=plain` emit byte-identical
// output; the flag exists for CLI uniformity with the repo's other renderers
// (hud-engine.cjs) and as a defensive strip in plain mode.
//
// DERIVED FIELDS (output-format.md formulas — not accepted as input, so the
// render can never contradict its own scores; category percentage = score/20):
//   grade  = A 90-100 | B 75-89 | C 55-74 | D 35-54 | F 0-34
//   status = PASS >= 80 | WARN 50-79 | FAIL < 50
//   bar    = 20 chars, '=' filled '-' empty, fill = round(pct/100*20)
//   findings total  = severity.p0 + p1 + p2 + p3
//   categories PASS = count of categories whose derived status is PASS
//
// DETERMINISM: same input JSON -> byte-identical stdout. No wall clock, no
// randomness, no env-dependent branches (scan duration arrives in the input).
//
// USAGE:
//   node plugins/4ge/bin/audit-render.cjs --mode=plain \
//     < plugins/4ge/bin/examples/audit-render.example.json
//   node plugins/4ge/bin/audit-render.cjs --schema
//
// INPUT SCHEMA (also printed by --schema):
//   {
//     command?:    string          // default "/4ge:audit"
//     title:       string          // e.g. "implementation quality"
//     scope:       { path: string, modules: int, lines: int }
//     health:      int 0-100
//     healthDelta?: int            // renders "(+N)"/"(-N)" after the Score Bar
//     categories:  [ { name: string (<=15 chars), score: int 0-20,
//                      findings: int } ]   // 1..12 rows, display order
//     severity:    { p0: int, p1: int, p2: int, p3: int }
//     scanSeconds: int >= 0
//   }

const SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'audit-render input',
  type: 'object',
  required: ['title', 'scope', 'health', 'categories', 'severity', 'scanSeconds'],
  additionalProperties: false,
  properties: {
    command: { type: 'string' },
    title: { type: 'string' },
    scope: {
      type: 'object',
      required: ['path', 'modules', 'lines'],
      properties: {
        path: { type: 'string' },
        modules: { type: 'integer', minimum: 0 },
        lines: { type: 'integer', minimum: 0 },
      },
    },
    health: { type: 'integer', minimum: 0, maximum: 100 },
    healthDelta: { type: 'integer' },
    categories: {
      type: 'array',
      minItems: 1,
      maxItems: 12,
      items: {
        type: 'object',
        required: ['name', 'score', 'findings'],
        properties: {
          name: { type: 'string', maxLength: 15 },
          score: { type: 'integer', minimum: 0, maximum: 20 },
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
    scanSeconds: { type: 'integer', minimum: 0 },
  },
};

const MAX_WIDTH = 79;

function isInt(v) { return Number.isInteger(v); }
function isStr(v) { return typeof v === 'string'; }

function fit(str, max) {
  if (str.length <= max) return str;
  return str.slice(0, Math.max(0, max - 3)) + '...';
}

// 3891 -> "3,891" without locale/ICU dependence (determinism).
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

// output-format.md status thresholds: PASS >= 80%, WARN 50-79%, FAIL < 50%.
function statusOf(pct) {
  if (pct >= 80) return 'PASS';
  if (pct >= 50) return 'WARN';
  return 'FAIL';
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
  if (!isStr(input.title) || !input.title) errors.push('title must be a non-empty string');
  if (!input.scope || typeof input.scope !== 'object') {
    errors.push('scope is required ({path, modules, lines})');
  } else {
    if (!isStr(input.scope.path) || !input.scope.path) errors.push('scope.path must be a non-empty string');
    if (!isInt(input.scope.modules) || input.scope.modules < 0) errors.push('scope.modules must be an integer >= 0');
    if (!isInt(input.scope.lines) || input.scope.lines < 0) errors.push('scope.lines must be an integer >= 0');
  }
  if (!isInt(input.health) || input.health < 0 || input.health > 100) {
    errors.push('health must be an integer 0-100');
  }
  if (input.healthDelta !== undefined && !isInt(input.healthDelta)) {
    errors.push('healthDelta must be an integer');
  }
  if (!Array.isArray(input.categories) || input.categories.length < 1 || input.categories.length > 12) {
    errors.push('categories must be an array of 1-12 rows');
  } else {
    input.categories.forEach((c, i) => {
      if (!c || !isStr(c.name) || !c.name) errors.push(`categories[${i}].name must be a non-empty string`);
      else if (c.name.length > 15) errors.push(`categories[${i}].name exceeds 15 chars (Component 2 field width)`);
      if (!c || !isInt(c.score) || c.score < 0 || c.score > 20) errors.push(`categories[${i}].score must be an integer 0-20`);
      if (!c || !isInt(c.findings) || c.findings < 0) errors.push(`categories[${i}].findings must be an integer >= 0`);
    });
  }
  if (!input.severity || typeof input.severity !== 'object') {
    errors.push('severity is required ({p0, p1, p2, p3})');
  } else {
    for (const k of ['p0', 'p1', 'p2', 'p3']) {
      if (!isInt(input.severity[k]) || input.severity[k] < 0) errors.push(`severity.${k} must be an integer >= 0`);
    }
  }
  if (!isInt(input.scanSeconds) || input.scanSeconds < 0) errors.push('scanSeconds must be an integer >= 0');
  return errors;
}

// Component 2 (Category Row):
//   {name:15}  {NN/20}  {grade}  {status:4}  [{bar:20}]  {count:>2} findings
function categoryRow(c) {
  const pct = (c.score / 20) * 100;
  const score = `${String(c.score).padStart(2, '0')}/20`;
  return `  ${c.name.padEnd(15)}  ${score}  ${gradeOf(pct)}  ${statusOf(pct).padEnd(4)}  [${barOf(pct)}]  ${String(c.findings).padStart(2)} findings`;
}

function render(input) {
  const command = input.command || '/4ge:audit';
  const sections = [];

  const stats = ` (${group(input.scope.modules)} modules, ${group(input.scope.lines)} lines)`;
  sections.push([
    `${command} — ${fit(input.title, MAX_WIDTH - command.length - 3)}`,
    `  Scope: ${fit(input.scope.path, MAX_WIDTH - 9 - stats.length)}${stats}`,
  ].join('\n'));

  // Component 1 (Score Bar); delta omitted entirely when no prior run exists.
  const delta = input.healthDelta === undefined
    ? ''
    : `  (${input.healthDelta >= 0 ? '+' : ''}${input.healthDelta})`;
  sections.push(`  Health: ${input.health}  ${gradeOf(input.health)}  [${barOf(input.health)}]${delta}`);

  sections.push(input.categories.map(categoryRow).join('\n'));

  const sev = input.severity;
  const total = sev.p0 + sev.p1 + sev.p2 + sev.p3;
  const passCount = input.categories.filter((c) => statusOf((c.score / 20) * 100) === 'PASS').length;
  sections.push([
    `  ${total} findings total   ${sev.p0} P0   ${sev.p1} P1   ${sev.p2} P2   ${sev.p3} P3`,
    `  Grade ${gradeOf(input.health)}   Scan: ${input.scanSeconds}s   Categories: ${passCount}/${input.categories.length} PASS`,
  ].join('\n'));

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
    process.stderr.write(`audit-render: unknown mode "${mode}" (ansi|plain)\n`);
    return 1;
  }

  let raw;
  try {
    raw = require('node:fs').readFileSync(0, 'utf8');
  } catch {
    raw = '';
  }
  if (!raw.trim()) {
    process.stderr.write('audit-render: expected a JSON state document on stdin (see --schema)\n');
    return 1;
  }
  let input;
  try {
    input = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`audit-render: invalid JSON on stdin: ${err.message}\n`);
    return 1;
  }
  const errors = validate(input);
  if (errors.length > 0) {
    process.stderr.write(`audit-render: invalid input:\n${errors.map((e) => `  - ${e}`).join('\n')}\n`);
    return 1;
  }
  const out = render(input);
  process.stdout.write(mode === 'plain' ? stripAnsi(out) : out);
  return 0;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = { render, validate, SCHEMA, gradeOf, statusOf, barOf };
