#!/usr/bin/env node
'use strict';

// forge-status.cjs — deterministic renderer for the /forge session status board.
//
// PURPOSE: the marketplace forge-session screenshot was a
// contract-true RECONSTRUCTION because no standalone renderer existed for the
// /forge status surface. This module is that renderer: a pure function of an
// input JSON state document, so screenshot capture (and any future surface) can
// render REAL output instead of hand-built mockups — same doctrine as the
// statusline's real-ANSI xterm capture (see the screenshot-truth doctrine in the project docs).
//
// OUTPUT CONTRACT: /forge status is governed by
// plugins/4ge/skills/wizard-engine/references/output-format.md — plain
// monospace text, NO ANSI, no color, no borders (anti-patterns 6-8), 2-space
// indents, Component 5 (Progress Line) + Component 10 (Teammate Row). Because
// the contract is ANSI-free, `--mode=ansi` (default) and `--mode=plain` emit
// byte-identical output; the flag exists for CLI uniformity with the repo's
// other renderers (hud-engine.cjs) and as a defensive strip in plain mode.
//
// DETERMINISM: same input JSON -> byte-identical stdout. No wall clock, no
// randomness, no env-dependent branches. All variable data comes from stdin.
//
// USAGE:
//   node plugins/4ge/bin/forge-status.cjs --mode=plain \
//     < plugins/4ge/bin/examples/forge-status.example.json
//   node plugins/4ge/bin/forge-status.cjs --schema
//
// INPUT SCHEMA (also printed by --schema):
//   {
//     command?:  string            // default "/forge"
//     phase:     { number: int, name: string }
//     task:      string
//     teammates: [ { name, phase, scope, status: string } ]  // may be empty
//     steps?:    [ { current: int, total: int, description, status: string } ]
//     decisions?:   int >= 0      // rendered with constraints when present
//     constraints?: int >= 0
//     phases?:   [ { label: string, status: string } ]       // summary line
//   }

const SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'forge-status input',
  type: 'object',
  required: ['phase', 'task', 'teammates'],
  additionalProperties: false,
  properties: {
    command: { type: 'string' },
    phase: {
      type: 'object',
      required: ['number', 'name'],
      properties: { number: { type: 'integer', minimum: 1, maximum: 7 }, name: { type: 'string' } },
    },
    task: { type: 'string' },
    teammates: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'phase', 'scope', 'status'],
        properties: {
          name: { type: 'string' }, phase: { type: 'string' },
          scope: { type: 'string' }, status: { type: 'string' },
        },
      },
    },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        required: ['current', 'total', 'description', 'status'],
        properties: {
          current: { type: 'integer', minimum: 0 }, total: { type: 'integer', minimum: 1 },
          description: { type: 'string' }, status: { type: 'string' },
        },
      },
    },
    decisions: { type: 'integer', minimum: 0 },
    constraints: { type: 'integer', minimum: 0 },
    phases: {
      type: 'array',
      items: {
        type: 'object',
        required: ['label', 'status'],
        properties: { label: { type: 'string' }, status: { type: 'string' } },
      },
    },
  },
};

const MAX_WIDTH = 79;
// Execute-variant Progress Line (Component 5): dot-leader pads to a fixed
// status column. Column 57 is the last dot; status begins at column 58.
const DOT_END_COL = 57;

function isInt(v) { return Number.isInteger(v); }
function isStr(v) { return typeof v === 'string'; }

// Truncate free text so no rendered line exceeds MAX_WIDTH.
function fit(str, max) {
  if (str.length <= max) return str;
  return str.slice(0, Math.max(0, max - 3)) + '...';
}

function validate(input) {
  const errors = [];
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return ['input must be a JSON object'];
  }
  if (input.command !== undefined && !isStr(input.command)) errors.push('command must be a string');
  if (!input.phase || typeof input.phase !== 'object') {
    errors.push('phase is required ({number, name})');
  } else {
    if (!isInt(input.phase.number) || input.phase.number < 1 || input.phase.number > 7) {
      errors.push('phase.number must be an integer 1-7');
    }
    if (!isStr(input.phase.name) || !input.phase.name) errors.push('phase.name must be a non-empty string');
  }
  if (!isStr(input.task) || !input.task) errors.push('task must be a non-empty string');
  if (!Array.isArray(input.teammates)) {
    errors.push('teammates must be an array (may be empty)');
  } else {
    input.teammates.forEach((t, i) => {
      for (const k of ['name', 'phase', 'scope', 'status']) {
        if (!t || !isStr(t[k])) errors.push(`teammates[${i}].${k} must be a string`);
      }
    });
  }
  if (input.steps !== undefined) {
    if (!Array.isArray(input.steps)) {
      errors.push('steps must be an array');
    } else {
      input.steps.forEach((s, i) => {
        if (!s || !isInt(s.current) || s.current < 0) errors.push(`steps[${i}].current must be an integer >= 0`);
        if (!s || !isInt(s.total) || s.total < 1) errors.push(`steps[${i}].total must be an integer >= 1`);
        if (!s || !isStr(s.description)) errors.push(`steps[${i}].description must be a string`);
        if (!s || !isStr(s.status)) errors.push(`steps[${i}].status must be a string`);
      });
    }
  }
  if (input.decisions !== undefined && (!isInt(input.decisions) || input.decisions < 0)) {
    errors.push('decisions must be an integer >= 0');
  }
  if (input.constraints !== undefined && (!isInt(input.constraints) || input.constraints < 0)) {
    errors.push('constraints must be an integer >= 0');
  }
  if (input.phases !== undefined) {
    if (!Array.isArray(input.phases)) {
      errors.push('phases must be an array');
    } else {
      input.phases.forEach((p, i) => {
        if (!p || !isStr(p.label)) errors.push(`phases[${i}].label must be a string`);
        if (!p || !isStr(p.status)) errors.push(`phases[${i}].status must be a string`);
      });
    }
  }
  return errors;
}

// Component 10 (Teammate Row): {name:16}  {phase:11}  {scope:20}  {status}
function teammateRow(t) {
  const line = `  ${fit(t.name, 16).padEnd(16)}  ${fit(t.phase, 11).padEnd(11)}  ${fit(t.scope, 20).padEnd(20)}  ${t.status}`;
  return fit(line.replace(/\s+$/, ''), MAX_WIDTH);
}

// Component 5 (Progress Line, execute variant with dot-leader).
function stepRow(s) {
  const prefix = `  Applying [${s.current}/${s.total}] `;
  const maxDesc = DOT_END_COL - prefix.length - 1 - 3; // keep >= 3 dots
  const desc = fit(s.description, maxDesc);
  const dots = '.'.repeat(Math.max(3, DOT_END_COL - prefix.length - desc.length - 1));
  return fit(`${prefix}${desc} ${dots} ${s.status}`, MAX_WIDTH);
}

function render(input) {
  const command = input.command || '/forge';
  const sections = [];

  sections.push([
    `${command} — Phase ${input.phase.number}: ${fit(input.phase.name, MAX_WIDTH - 20)}`,
    `  Task: ${fit(input.task, MAX_WIDTH - 8)}`,
  ].join('\n'));

  const teamLines = ['  Teammates'];
  if (input.teammates.length === 0) {
    teamLines.push('  (no active teammates)');
  } else {
    for (const t of input.teammates) teamLines.push(teammateRow(t));
  }
  sections.push(teamLines.join('\n'));

  if (Array.isArray(input.steps) && input.steps.length > 0) {
    sections.push(input.steps.map(stepRow).join('\n'));
  }

  const footer = [];
  if (input.decisions !== undefined || input.constraints !== undefined) {
    footer.push(`  Decisions: ${input.decisions || 0} logged   Constraints: ${input.constraints || 0} logged`);
  }
  if (Array.isArray(input.phases) && input.phases.length > 0) {
    footer.push(fit(`  ${input.phases.map((p) => `${p.label} ${p.status}`).join('   ')}`, MAX_WIDTH));
  }
  if (footer.length > 0) sections.push(footer.join('\n'));

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
    process.stderr.write(`forge-status: unknown mode "${mode}" (ansi|plain)\n`);
    return 1;
  }

  let raw;
  try {
    raw = require('node:fs').readFileSync(0, 'utf8');
  } catch {
    raw = '';
  }
  if (!raw.trim()) {
    process.stderr.write('forge-status: expected a JSON state document on stdin (see --schema)\n');
    return 1;
  }
  let input;
  try {
    input = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`forge-status: invalid JSON on stdin: ${err.message}\n`);
    return 1;
  }
  const errors = validate(input);
  if (errors.length > 0) {
    process.stderr.write(`forge-status: invalid input:\n${errors.map((e) => `  - ${e}`).join('\n')}\n`);
    return 1;
  }
  const out = render(input);
  process.stdout.write(mode === 'plain' ? stripAnsi(out) : out);
  return 0;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = { render, validate, SCHEMA };
