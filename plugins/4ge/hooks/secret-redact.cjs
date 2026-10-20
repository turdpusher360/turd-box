#!/usr/bin/env node
'use strict';

/**
 * secret-redact.cjs - UserPromptSubmit hook (4ge plugin copy)
 *
 * Intercepts the /secret slash command (markered prompt body), parses
 * KEY=value or auto-detects a key from common token prefixes, writes
 * the secret to project .env, and BLOCKS the prompt so the model never
 * sees the value.
 *
 * This copy runs from ${CLAUDE_PLUGIN_DATA}/hooks in every project that
 * enables the plugin. It never steps aside for a project hook: a settings
 * entry that merely mentions secret-redact can be marker-only and fail open
 * (the governance pack's hook exits 0 on a raw /secret), and a skip here would
 * leave the value unblocked. A project that also wires a blocking secret-redact
 * gets two blocks and two writers of the same KEY line. Run one after the
 * other, the second finds the value already there and writes nothing. Run at
 * the same time there is no lock and no temp file: a read that lands during
 * the other copy's write can see part of the file, so the later writer can
 * drop or tear lines, on LF and CRLF files alike, and two sessions on one
 * checkout can lose an update. A CRLF file never compares equal (the join is
 * LF), so it is rewritten every time.
 *
 * No order guarantee: every UserPromptSubmit hook gets the prompt in parallel
 * and this block gates none of them, so each sibling that reads the prompt
 * skips a capture itself (secret-capture-match.cjs).
 *
 * Fail-closed: only node built-ins load at top level, and stdin is read here
 * with its own deadline. Once the raw stdin carries a /secret command or the
 * capture marker, every failure (bad, partial or oversize input, a missing end
 * marker, a sibling module that will not load, a throw) blocks the prompt.
 * Block JSON goes out on exit 0; exit 2 only when stdout itself cannot be
 * written.
 *
 * Target: the project root .env by default (CLAUDE_PROJECT_DIR; with no
 * project root the prompt is blocked, never written next to payload.cwd), or
 * the --file path. No target may sit under _runs/ (any case, also after
 * realpath of its parent), and the file is opened O_NOFOLLOW|O_NONBLOCK and
 * must be a regular file, so a symlink or FIFO cannot divert the value or
 * stall the hook into the harness timeout, which fails open.
 */

const fs = require('node:fs');
const path = require('node:path');

const MARKER = '##SECRET_CAPTURE##';
const END_MARKER = '##END_SECRET_CAPTURE##';

// Under the hook timeout (5 s in hooks.json, a margin of about 3.5 s), so a
// stalled stdin still ends in a block.
const STDIN_DEADLINE_MS = 1500;
const STDIN_CAP_BYTES = 16 * 1024 * 1024;

// A blocking open or read cannot be cut short from inside the hook: a timer
// cannot fire during a sync call, and process.exit waits for a threadpool call
// stuck in open() (measured: a FIFO open held the exit past an 8 s kill). So
// the target never blocks: O_NONBLOCK opens a FIFO at once (then the regular-
// file check rejects it), and O_NOFOLLOW refuses a final symlink (ELOOP).
// Windows has neither flag (0); a symlink needs privileges there.
const OPEN_FLAGS = fs.constants.O_RDWR | fs.constants.O_CREAT
  | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);

// Cheap pre-test on the RAW stdin text (JSON, so a multiline prompt is one
// line here). Never a bare "secret" word: cwd and transcript_path can hold it.
const RAW_PRETEST_RE = /\/(?:[\w-]+:)?(?:secret|superdupersecret)|##SECRET_CAPTURE##/i;

// Raw "/secret ..." (optionally plugin-prefixed, e.g. "/4ge:secret") exactly as
// typed by the user. UserPromptSubmit fires on the RAW prompt BEFORE slash-command
// expansion, so the marker form below never appears at hook time on current CC —
// the marker-only check silently passed two live /secret values into model
// context (fixed 2026-07-13). superdupersecret is the /secret alias command.
// Applied to the trimmed prompt; greedy tail, so it stays linear.
const RAW_COMMAND_RE = /^\/(?:[A-Za-z0-9_-]+:)?(?:secret|superdupersecret)(?:\s+([\s\S]*))?$/i;


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

  // trimmed has no trailing whitespace, so a greedy tail takes the same value
  // the old lazy-before-\s*$ form did, without its quadratic backtracking.
  let m = trimmed.match(/^([A-Z][A-Z0-9_]*)\s*=\s*(.+)$/s);
  if (m) return { key: m[1], value: m[2], mode: 'explicit' };

  m = trimmed.match(/^([A-Z][A-Z0-9_]+)\s+(.+)$/s);
  if (m) return { key: m[1], value: m[2], mode: 'explicit' };

  const value = trimmed;
  const key = detectKey(value);
  if (key) return { key, value, mode: 'auto' };

  return null;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// --- `--file <path>` target support ----------------------------------------
// `--file <path>` may appear before or after the KEY=value / token in the
// args. The path must be an env-style file the operator named, resolved
// against payload.cwd; absent, the default is the project root .env.
// Rejection reasons NEVER echo the offending token — a mistyped "path" can be
// the secret value itself.
const FILE_FLAG_TOKEN = /(^|\s)--file(=|\s|$)/;
const FILE_FLAG_CAPTURE = /(^|\s)--file(?:=|\s+)(\S+)/;

function extractFileFlag(args) {
  const m = args.match(FILE_FLAG_CAPTURE);
  if (m) {
    const before = args.slice(0, m.index);
    const after = args.slice(m.index + m[0].length);
    return { filePath: m[2], rest: (before + after).trim() };
  }
  if (FILE_FLAG_TOKEN.test(args)) return { missingPath: true };
  return { filePath: null, rest: args };
}

function isEnvStyle(base) {
  return base === '.env' || base.startsWith('.env.') || /\.env$/.test(base);
}

// The harness sets CLAUDE_PROJECT_DIR for plugin hooks too. This copy lives in
// the plugin data dir, so __dirname says nothing about the project: with no
// absolute CLAUDE_PROJECT_DIR there is no default target. Never payload.cwd:
// it follows a cd into _runs/ or a worktree.
function projectRoot() {
  const dir = process.env.CLAUDE_PROJECT_DIR;
  return dir && path.isAbsolute(dir) ? dir : null;
}

const hasRunsSegment = (p) => p.split(/[\\/]+/).some((seg) => seg.toLowerCase() === '_runs');

// Every target: never persist a secret into the session-artifact tree. Checked
// on the path as given, then again after realpath of the parent, so a
// symlinked directory cannot divert the value there.
function checkTarget(abs) {
  if (hasRunsSegment(abs)) return { error: 'target may not be inside _runs/' };
  let dir;
  try {
    dir = fs.realpathSync(path.dirname(abs));
  } catch {
    return { error: 'target directory does not exist' };
  }
  const real = path.join(dir, path.basename(abs));
  if (hasRunsSegment(real)) return { error: 'target may not be inside _runs/' };
  return { path: real };
}

function resolveTarget(cwd, filePath) {
  const abs = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(cwd || process.cwd(), filePath);
  const base = path.basename(abs);
  // Env-style filename only. Checked first so a mistyped KEY=value "path" is
  // rejected here without echoing it back.
  if (!isEnvStyle(base)) {
    return { error: '--file target must be an env-style file (.env, .env.local, *.env)' };
  }
  const target = checkTarget(abs);
  if (target.error) return { error: '--file ' + target.error };
  return { path: target.path, label: base };
}

function upsertEnv(envPath, key, value) {
  const fd = fs.openSync(envPath, OPEN_FLAGS, 0o600);
  try {
    // A FIFO, device or directory is never a secret store.
    if (!fs.fstatSync(fd).isFile()) {
      const err = new Error('not a regular file');
      err.code = 'ENOTREG';
      throw err;
    }
    // A new file reads as '' and takes the same path as an empty one.
    const text = fs.readFileSync(fd, 'utf8');
    const lines = text.split(/\r?\n/);
    let existed = false;

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

    const joined = lines.join('\n');
    // The KEY line already holds this value (the other secret-redact copy, wired
    // on the same prompt, got there first): write nothing. Rewriting what was
    // read halfway through that run's write and truncate would put its old tail
    // back. A CRLF file never compares equal (the join is LF) and is rewritten.
    if (joined === text) return { existed };
    const out = Buffer.from(joined, 'utf8');
    fs.writeSync(fd, out, 0, out.length, 0);
    fs.ftruncateSync(fd, out.length);
    return { existed };
  } finally {
    fs.closeSync(fd);
  }
}

// Emit a block and exit. Reasons never carry the value. If stdout cannot be
// written, exit 2 with a value-free stderr line.
function block(reason, stopReason) {
  try {
    process.stdout.write(JSON.stringify({ decision: 'block', reason, continue: false, stopReason }) + '\n');
  } catch {
    try { process.stderr.write('[secret-redact] blocked; stdout unavailable\n'); } catch { /* nothing left to report on */ }
    process.exit(2);
  }
  process.exit(0);
}

function failClosed(why) {
  block(
    '[secret-redact] blocked: ' + why + '. Nothing was saved. Resend /secret on its own as the whole prompt.',
    'secret capture failed closed'
  );
}

// Raw stdin with a deadline and a size cap. Never rejects.
function readRawStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let done = false;
    let timer = null;
    const finish = (complete, oversize) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      process.stdin.removeAllListeners('data');
      process.stdin.removeAllListeners('end');
      process.stdin.removeAllListeners('error');
      process.stdin.pause();
      resolve({ text: Buffer.concat(chunks).toString('utf8'), complete, oversize });
    };
    timer = setTimeout(() => finish(false, false), STDIN_DEADLINE_MS);
    process.stdin.on('data', (chunk) => {
      const room = STDIN_CAP_BYTES - size;
      if (chunk.length > room) {
        chunks.push(chunk.subarray(0, room));
        size += room;
        finish(false, true);
        return;
      }
      chunks.push(chunk);
      size += chunk.length;
    });
    process.stdin.on('end', () => finish(true, false));
    process.stdin.on('error', () => finish(false, false));
  });
}

async function main() {
  const raw = await readRawStdin();

  // Fast path. Residual: input cut off at the deadline or the cap before any
  // /secret text arrived proceeds.
  if (!RAW_PRETEST_RE.test(raw.text)) process.exit(0);

  if (raw.oversize) return failClosed('hook input over the size cap');

  let payload;
  try {
    payload = JSON.parse(raw.text);
  } catch {
    return failClosed(raw.complete ? 'hook input is not valid JSON' : 'hook input arrived incomplete');
  }
  if (!payload || typeof payload !== 'object') return failClosed('hook input is not a JSON object');

  // Sibling modules load only after a hit, so a missing or broken copy blocks
  // a capture (main().catch below) and costs every other prompt nothing.
  const { isSecretCapturePrompt } = require('./secret-capture-match.cjs');
  const prompt = typeof payload.prompt === 'string' ? payload.prompt : '';
  // The pre-test hit elsewhere (a path, another field): not a capture.
  if (!isSecretCapturePrompt(prompt)) process.exit(0);

  // Two accepted forms: marker form (expanded command body — kept for harness
  // versions that expand slash commands before UserPromptSubmit) and raw slash
  // form (what the hook actually receives live — see RAW_COMMAND_RE above).
  let args = null;
  const start = prompt.indexOf(MARKER);
  if (start !== -1) {
    const end = prompt.indexOf(END_MARKER, start);
    if (end === -1) return failClosed('capture marker without an end marker');
    args = prompt.slice(start + MARKER.length, end).trim();
  } else {
    const m = prompt.trim().match(RAW_COMMAND_RE);
    if (!m) {
      return block(
        '[secret-redact] /secret must be the whole prompt, on its own. Nothing was saved, and the prompt was blocked so the value stays out of the conversation.',
        'secret command not alone'
      );
    }
    args = (m[1] || '').trim();
  }

  const fileFlag = extractFileFlag(args);
  if (fileFlag.missingPath) {
    return block(
      '[secret-redact] --file requires a path, e.g. /secret --file .env.local KEY=value',
      'secret --file missing path'
    );
  }

  let envPath, targetLabel;
  if (fileFlag.filePath) {
    const target = resolveTarget(payload.cwd, fileFlag.filePath);
    if (target.error) {
      return block('[secret-redact] ' + target.error, 'secret --file target rejected');
    }
    envPath = target.path;
    targetLabel = target.label;
  } else {
    const root = projectRoot();
    if (!root) {
      return block(
        '[secret-redact] blocked: no project root (CLAUDE_PROJECT_DIR is not set). Nothing was saved. Use /secret --file <path.env> KEY=value.',
        'secret target rejected'
      );
    }
    const target = checkTarget(path.join(root, '.env'));
    if (target.error) {
      return block('[secret-redact] ' + target.error, 'secret target rejected');
    }
    envPath = target.path;
    targetLabel = '.env';
  }

  const parsed = parseInput(fileFlag.rest);

  if (!parsed) {
    return block(
      '[secret-redact] could not parse input. Try:\n  /secret KEY=value\n  /secret KEY value\n  /secret --file <path.env> KEY=value\n  /secret <token with recognized prefix>',
      'secret input not parsed'
    );
  }

  let result;
  try {
    result = upsertEnv(envPath, parsed.key, parsed.value);
  } catch (e) {
    // The code only: e.message carries the filesystem path.
    return block('[secret-redact] failed to write ' + targetLabel + ' (' + ((e && e.code) || 'error') + ')', 'env write failed');
  }

  const action = result.existed ? 'updated' : 'added';
  const note = parsed.mode === 'auto' ? ' (key auto-detected from prefix)' : '';
  const reason = '[secret-redact] ' + action + ' ' + parsed.key +
    ' in ' + targetLabel + ' (length ' + parsed.value.length + ')' + note;

  return block(reason, reason);
}

// Anything that throws got here before the pre-test settled or after a hit:
// fail closed either way.
main().catch(() => failClosed('internal error'));
