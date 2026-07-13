#!/usr/bin/env node
'use strict';

/**
 * secret-redact.cjs - UserPromptSubmit hook
 *
 * Intercepts the /secret slash command (markered prompt body), parses
 * KEY=value or auto-detects a key from common token prefixes, writes
 * the secret to project .env, and BLOCKS the prompt so the model never
 * sees the value.
 *
 * Wire FIRST in UserPromptSubmit so no other hook ever logs the raw value.
 */

const fs = require('node:fs');
const path = require('node:path');
const { readStdinJson } = require('./hook-utils.cjs');
const { isProjectManaged } = require('./os-guard.cjs');

const MARKER = '##SECRET_CAPTURE##';
const END_MARKER = '##END_SECRET_CAPTURE##';

// Raw "/secret ..." (optionally plugin-prefixed, e.g. "/4ge:secret") exactly as
// typed by the user. UserPromptSubmit fires on the RAW prompt BEFORE slash-command
// expansion, so the marker form below never appears at hook time on current CC —
// the marker-only check silently passed two live /secret values into model
// context (fixed 2026-07-13). superdupersecret is the /secret alias command.
const RAW_COMMAND_RE = /^\s*\/(?:[A-Za-z0-9_-]+:)?(?:secret|superdupersecret)(?:\s+([\s\S]+?))?\s*$/;


const PREFIX_MAP = [
  [/^sbp_[a-f0-9]{40,}$/i, 'SUPABASE_PAT'],
  [/^sbp_/, 'SUPABASE_PAT'],
  [/^sk-ant-api03-/, 'ANTHROPIC_API_KEY'],
  [/^sk-ant-/, 'ANTHROPIC_API_KEY'],
  [/^sk-proj-/, 'OPENAI_API_KEY'],
  [/^sk-[A-Za-z0-9]{20,}$/, 'OPENAI_API_KEY'],
  [/^ghp_/, 'GITHUB_TOKEN'],
  [/^gho_/, 'GITHUB_OAUTH_TOKEN'],
  [/^github_pat_/, 'GITHUB_PAT'],
  [/^cfut_/, 'CLOUDFLARE_API_TOKEN'],
  [/^xox[bpars]-/, 'SLACK_TOKEN'],
  [/^AKIA[0-9A-Z]{16}$/, 'AWS_ACCESS_KEY_ID'],
  [/^AIza[0-9A-Za-z_-]{35}$/, 'GOOGLE_API_KEY'],
];

function detectKey(value) {
  for (const [re, key] of PREFIX_MAP) {
    if (re.test(value)) return key;
  }
  return null;
}

function parseInput(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let m = trimmed.match(/^([A-Z][A-Z0-9_]*)\s*=\s*(.+?)\s*$/s);
  if (m) return { key: m[1], value: m[2], mode: 'explicit' };

  m = trimmed.match(/^([A-Z][A-Z0-9_]+)\s+(.+?)\s*$/s);
  if (m) return { key: m[1], value: m[2], mode: 'explicit' };

  const value = trimmed;
  const key = detectKey(value);
  if (key) return { key, value, mode: 'auto' };

  return null;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function upsertEnv(envPath, key, value) {
  let lines = [];
  let existed = false;
  try {
    lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  } catch { /* file missing — will create */ }

  const re = new RegExp('^' + escapeRe(key) + '=');
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) {
      lines[i] = key + '=' + value;
      existed = true;
      break;
    }
  }
  if (!existed) {
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    lines.push(key + '=' + value);
    lines.push('');
  }

  const out = lines.join('\n');
  try {
    fs.writeFileSync(envPath, out, { mode: 0o600 });
  } catch {
    fs.writeFileSync(envPath, out);
  }
  return { existed };
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

async function main() {
  let payload;
  try { payload = await readStdinJson(); } catch { process.exit(0); }

  // Precedence guard (os-guard.cjs): when the project wires its own
  // secret-redact via .claude/settings.json, that copy is authoritative —
  // exit to avoid a double .env write + double block on /secret. stdin is
  // already drained by readStdinJson above (no pipe-hold zombie).
  if (isProjectManaged(payload.cwd || process.cwd(), 'secret-redact')) process.exit(0);

  const prompt = String(payload.prompt || '');

  // Two accepted forms: marker form (expanded command body — kept for harness
  // versions that expand slash commands before UserPromptSubmit) and raw slash
  // form (what the hook actually receives live — see RAW_COMMAND_RE above).
  let args = null;
  const start = prompt.indexOf(MARKER);
  if (start !== -1) {
    const end = prompt.indexOf(END_MARKER, start);
    if (end === -1) process.exit(0);
    args = prompt.slice(start + MARKER.length, end).trim();
  } else {
    const m = prompt.match(RAW_COMMAND_RE);
    if (!m) process.exit(0);
    args = (m[1] || '').trim();
  }

  const parsed = parseInput(args);

  if (!parsed) {
    emit({
      decision: 'block',
      reason: '[secret-redact] could not parse input. Try:\n  /secret KEY=value\n  /secret KEY value\n  /secret <token with recognized prefix>',
      continue: false,
      stopReason: 'secret input not parsed'
    });
    process.exit(0);
  }

  const envPath = path.join(payload.cwd || process.cwd(), '.env');
  let result;
  try {
    result = upsertEnv(envPath, parsed.key, parsed.value);
  } catch (e) {
    emit({
      decision: 'block',
      reason: '[secret-redact] failed to write .env: ' + e.message,
      continue: false,
      stopReason: 'env write failed'
    });
    process.exit(0);
  }

  const action = result.existed ? 'updated' : 'added';
  const note = parsed.mode === 'auto' ? ' (key auto-detected from prefix)' : '';
  const reason = '[secret-redact] ' + action + ' ' + parsed.key +
    ' in .env (length ' + parsed.value.length + ')' + note;

  emit({
    decision: 'block',
    reason,
    continue: false,
    stopReason: reason
  });
  process.exit(0);
}

main().catch((e) => {
  process.stderr.write('[secret-redact] error: ' + e.message + '\n');
  process.exit(0);
});
