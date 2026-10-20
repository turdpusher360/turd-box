import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, '..');
const HOOK_PATH = path.join(PLUGIN_ROOT, 'hooks', 'secret-redact.cjs');
const HOOKS_JSON = path.join(PLUGIN_ROOT, 'hooks', 'hooks.json');

const tempDirs = [];

const VIRTUAL_FS_PRELOAD = `'use strict';
const fs = require('node:fs');
const path = require('node:path');

const virtualRoot = path.resolve(process.env.SECRET_REDACT_VIRTUAL_ROOT);
const physicalRoot = path.resolve(process.env.SECRET_REDACT_PHYSICAL_ROOT);

function remap(target) {
  if (typeof target !== 'string') return target;
  const resolved = path.resolve(target);
  const relative = path.relative(virtualRoot, resolved);
  const inside = relative === ''
    || (relative !== '..'
      && !relative.startsWith('..' + path.sep)
      && !path.isAbsolute(relative));
  return inside ? path.join(physicalRoot, relative) : target;
}

for (const method of ['existsSync', 'readFileSync', 'writeFileSync', 'realpathSync']) {
  const original = fs[method].bind(fs);
  fs[method] = (target, ...args) => original(remap(target), ...args);
}
`;

function mkTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-redact-'));
  tempDirs.push(dir);
  return dir;
}

function createVirtualProject(physicalRoot) {
  const virtualRoot = path.join(
    path.parse(physicalRoot).root,
    'forge-secret-redact-virtual',
    path.basename(physicalRoot),
  );
  const preload = path.join(physicalRoot, 'virtual-fs-preload.cjs');
  fs.writeFileSync(preload, VIRTUAL_FS_PRELOAD, 'utf8');
  return { physicalRoot, preload, virtualRoot };
}

/**
 * Hook env. CLAUDE_PROJECT_DIR is ALWAYS a temp dir: the hook's default target
 * is the project root, and the inherited value is the real repo.
 */
function hookEnv(projectDir, project) {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: projectDir };
  if (project) {
    env.SECRET_REDACT_PHYSICAL_ROOT = project.physicalRoot;
    env.SECRET_REDACT_VIRTUAL_ROOT = project.virtualRoot;
  }
  return env;
}

function runHook(prompt, cwd) {
  const project = createVirtualProject(cwd);
  return spawnSync(process.execPath, ['--require', project.preload, HOOK_PATH], {
    cwd: PLUGIN_ROOT,
    input: JSON.stringify({ prompt, cwd: project.virtualRoot }),
    encoding: 'utf8',
    env: hookEnv(project.physicalRoot, project),
  });
}

describe('secret-redact hook', () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('auto-detects Cloudflare user tokens from cfut_ prefix', () => {
    const cwd = mkTempDir();
    const token = 'cfut_' + 'exampletoken'.repeat(8);
    const prompt = `##SECRET_CAPTURE##\n${token}\n##END_SECRET_CAPTURE##`;

    const result = runHook(prompt, cwd);
    const decision = JSON.parse(result.stdout);
    const envText = fs.readFileSync(path.join(cwd, '.env'), 'utf8');

    expect(result.status).toBe(0);
    expect(decision.decision).toBe('block');
    expect(decision.reason).toContain('added CLOUDFLARE_API_TOKEN');
    expect(decision.reason).toContain('key auto-detected from prefix');
    expect(decision.reason).not.toContain(token);
    expect(envText).toBe(`CLOUDFLARE_API_TOKEN=${token}\n`);
  });

  it('does not include any secret preview in the block reason', () => {
    const cwd = mkTempDir();
    const token = 'abc1' + 'middle-secret-value'.repeat(3) + '9876';
    const prompt = `##SECRET_CAPTURE##\nSENSITIVE_TOKEN=${token}\n##END_SECRET_CAPTURE##`;

    const result = runHook(prompt, cwd);
    const decision = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(decision.decision).toBe('block');
    expect(decision.reason).toContain('added SENSITIVE_TOKEN');
    expect(decision.reason).toContain(`length ${token.length}`);
    expect(decision.reason).not.toContain('preview');
    expect(decision.reason).not.toContain(token);
    expect(decision.reason).not.toContain(token.slice(0, 4));
    expect(decision.reason).not.toContain(token.slice(-4));
    expect(fs.existsSync(path.join(path.parse(cwd).root, 'forge-secret-redact-virtual'))).toBe(false);
  });

  it('is wired before other UserPromptSubmit hooks in the plugin manifest', () => {
    const manifest = JSON.parse(fs.readFileSync(HOOKS_JSON, 'utf8'));
    const firstHook = manifest.hooks?.UserPromptSubmit?.[0]?.hooks?.[0];

    expect(firstHook).toBeDefined();
    expect(firstHook.command).toContain('secret-redact.cjs');
  });

  // --- `--file <path>` target (smoke; other projects run this copy) --------

  it('--file writes to the named env file and never leaks the value', () => {
    const cwd = mkTempDir();
    const result = runHook('/secret --file .env.local FILE_TOKEN=hunter2filesecret', cwd);
    const decision = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(decision.decision).toBe('block');
    expect(decision.reason).toContain('FILE_TOKEN');
    expect(decision.reason).toContain('.env.local');
    expect(decision.reason).not.toContain('hunter2filesecret');
    expect(fs.readFileSync(path.join(cwd, '.env.local'), 'utf8')).toContain('FILE_TOKEN=hunter2filesecret');
    expect(fs.existsSync(path.join(path.parse(cwd).root, 'forge-secret-redact-virtual'))).toBe(false);
    // default project .env must NOT be touched
    expect(fs.existsSync(path.join(cwd, '.env'))).toBe(false);
  });

  it('--file refuses a target inside _runs/ and writes nothing', () => {
    const cwd = mkTempDir();
    const result = runHook('/secret --file _runs/leak.env LEAK_KEY=nope', cwd);
    const decision = JSON.parse(result.stdout);

    expect(decision.decision).toBe('block');
    expect(decision.reason).toContain('_runs');
    expect(fs.existsSync(path.join(cwd, '_runs'))).toBe(false);
  });
});

// ─── SRF Layer B: this copy runs in other projects, so it fails closed too ──

const LIB_MATCHER = path.resolve(PLUGIN_ROOT, '..', '..', 'lib', 'secret-capture-match.cjs');
const PLUGIN_MATCHER = path.join(PLUGIN_ROOT, 'hooks', 'secret-capture-match.cjs');
const PROJECT_HOOK = path.resolve(PLUGIN_ROOT, '..', '..', '.claude', 'hooks', 'secret-redact.cjs');

// A project settings.json that wires `command` under each named event.
function wireSettings(projectDir, byEvent) {
  const hooks = {};
  for (const [event, command] of Object.entries(byEvent)) {
    hooks[event] = [{ hooks: [{ type: 'command', command }] }];
  }
  fs.mkdirSync(path.join(projectDir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, '.claude', 'settings.json'), JSON.stringify({ hooks }));
}

function blocked(res) {
  if (res.status === 2) return true;
  if (res.status !== 0) return false;
  try {
    const out = JSON.parse((res.stdout || '').trim());
    return out.decision === 'block' && out.continue === false;
  } catch {
    return false;
  }
}

// The hook plus only the named sibling files, in a bare temp hooks dir.
function loneHook(withFiles = []) {
  const dir = path.join(mkTempDir(), 'hooks');
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ['secret-redact.cjs', ...withFiles]) {
    fs.copyFileSync(path.join(PLUGIN_ROOT, 'hooks', f), path.join(dir, f));
  }
  return path.join(dir, 'secret-redact.cjs');
}

function runRawHook(hook, raw, cwd) {
  return spawnSync(process.execPath, [hook], { cwd, input: raw, encoding: 'utf8', timeout: 10000, env: hookEnv(cwd) });
}

describe('secret-redact plugin copy: fail-closed (SRF Layer B)', () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the harness gives every child a temp CLAUDE_PROJECT_DIR, never the real repo', () => {
    const cwd = mkTempDir();
    const probe = "require('node:fs').writeFileSync(require('node:path').join(process.env.CLAUDE_PROJECT_DIR, 'pin-probe.txt'), 'ok')";
    const res = spawnSync(process.execPath, ['-e', probe], { cwd: PLUGIN_ROOT, encoding: 'utf8', env: hookEnv(cwd) });
    expect(res.status).toBe(0);
    expect(fs.readFileSync(path.join(cwd, 'pin-probe.txt'), 'utf8')).toBe('ok');
  });

  it('blocks when none of its sibling modules load', () => {
    const cwd = mkTempDir();
    const res = runRawHook(loneHook(), JSON.stringify({ prompt: '/secret FOO_KEY=plgvalueone', cwd }), cwd);
    expect(blocked(res)).toBe(true);
    expect(res.stdout + res.stderr).not.toContain('plgvalueone');
    expect(fs.existsSync(path.join(cwd, '.env'))).toBe(false);
  });

  it('a pack-style secret-redact in the project settings does not make this copy step aside', () => {
    const cwd = mkTempDir();
    wireSettings(cwd, { UserPromptSubmit: 'node .claude/hooks/governance/secret-redact.cjs' });
    const res = runHook('/secret PACK_KEY=plgvaluetwo', cwd);
    expect(blocked(res)).toBe(true);
    expect(fs.readFileSync(path.join(cwd, '.env'), 'utf8')).toBe('PACK_KEY=plgvaluetwo\n');
    expect(res.stdout + res.stderr).not.toContain('plgvaluetwo');
  });

  it('a secret-redact mentioned only under PostToolUse does not make this copy step aside', () => {
    const cwd = mkTempDir();
    wireSettings(cwd, { PostToolUse: 'node ${CLAUDE_PROJECT_DIR}/.claude/hooks/secret-redact.cjs' });
    const res = runHook('/secret POST_KEY=plgvaluesix', cwd);
    expect(blocked(res)).toBe(true);
    expect(fs.readFileSync(path.join(cwd, '.env'), 'utf8')).toBe('POST_KEY=plgvaluesix\n');
    expect(res.stdout + res.stderr).not.toContain('plgvaluesix');
  });

  it('blocks on malformed stdin that carries a /secret command', () => {
    const cwd = mkTempDir();
    const res = runRawHook(HOOK_PATH, '{"prompt":"/secret FOO_KEY=plgvaluethree"', cwd);
    expect(blocked(res)).toBe(true);
    expect(res.stdout + res.stderr).not.toContain('plgvaluethree');
  });

  it('blocks a capture marker with no end marker', () => {
    const cwd = mkTempDir();
    const res = runHook('##SECRET_CAPTURE##FOO_KEY=plgvaluefour', cwd);
    expect(blocked(res)).toBe(true);
    expect(res.stdout + res.stderr).not.toContain('plgvaluefour');
  });

  it('with the project secret-redact also wired, both hooks block and .env holds one KEY line', () => {
    const cwd = mkTempDir();
    wireSettings(cwd, { UserPromptSubmit: 'node ${CLAUDE_PROJECT_DIR}/.claude/hooks/secret-redact.cjs' });
    const raw = JSON.stringify({ prompt: '/secret DUAL_KEY=plgvaluefive', cwd });
    for (const order of [[PROJECT_HOOK, HOOK_PATH], [HOOK_PATH, PROJECT_HOOK]]) {
      fs.rmSync(path.join(cwd, '.env'), { force: true });
      for (const hook of order) {
        const res = runRawHook(hook, raw, cwd);
        expect(blocked(res)).toBe(true);
        expect(res.stdout + res.stderr).not.toContain('plgvaluefive');
      }
      expect(fs.readFileSync(path.join(cwd, '.env'), 'utf8')).toBe('DUAL_KEY=plgvaluefive\n');
    }
  });

  it('a KEY that already holds the value is not rewritten by either copy, a new value still is', () => {
    for (const hook of [HOOK_PATH, PROJECT_HOOK]) {
      const cwd = mkTempDir();
      const envFile = path.join(cwd, '.env');
      fs.writeFileSync(envFile, 'A=1\nSKIP_KEY=plgvalueskip\nZ=2\n');
      const old = new Date(Date.now() - 60000);
      fs.utimesSync(envFile, old, old);
      const before = fs.statSync(envFile);
      const same = runRawHook(hook, JSON.stringify({ prompt: '/secret SKIP_KEY=plgvalueskip', cwd }), cwd);
      expect(blocked(same)).toBe(true);
      expect(same.stdout + same.stderr).not.toContain('plgvalueskip');
      expect(fs.readFileSync(envFile, 'utf8')).toBe('A=1\nSKIP_KEY=plgvalueskip\nZ=2\n');
      expect(fs.statSync(envFile).mtimeMs).toBe(before.mtimeMs);
      const next = runRawHook(hook, JSON.stringify({ prompt: '/secret SKIP_KEY=plgvaluenew', cwd }), cwd);
      expect(blocked(next)).toBe(true);
      expect(fs.readFileSync(envFile, 'utf8')).toBe('A=1\nSKIP_KEY=plgvaluenew\nZ=2\n');
    }
  });

  it('a prompt that only mentions secrets proceeds untouched', () => {
    const cwd = mkTempDir();
    const res = runHook('where do we keep secrets?', cwd);
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe('');
  });

  it('T14: the plugin matcher is a byte-identical copy of lib/secret-capture-match.cjs', () => {
    expect(fs.existsSync(PLUGIN_MATCHER)).toBe(true);
    expect(fs.readFileSync(PLUGIN_MATCHER)).toEqual(fs.readFileSync(LIB_MATCHER));
  });

  it('the inline raw pre-test is the matcher RAW_CAPTURE_RE', () => {
    const { RAW_CAPTURE_RE } = require(LIB_MATCHER);
    expect(fs.readFileSync(HOOK_PATH, 'utf8')).toContain(`/${RAW_CAPTURE_RE.source}/${RAW_CAPTURE_RE.flags}`);
  });

  it('/secret on line 2 is blocked as "not alone" and saves nothing', () => {
    const cwd = mkTempDir();
    const res = runHook('context first\n/secret ALONE_KEY=plgvaluealone', cwd);
    expect(blocked(res)).toBe(true);
    expect(JSON.parse(res.stdout).reason).toContain('whole prompt');
    expect(res.stdout + res.stderr).not.toContain('plgvaluealone');
    expect(fs.existsSync(path.join(cwd, '.env'))).toBe(false);
  });
});

// ─── SRF Layer B target: CLAUDE_PROJECT_DIR, else block (ruling B-1 (a)) ────
// This copy runs from the plugin data dir, so its own location says nothing
// about the project, and payload.cwd follows a cd into _runs/ or a worktree.

function runIn(raw, { cwd, projectDir, timeout = 10000 }) {
  const env = hookEnv(projectDir);
  if (projectDir === undefined) delete env.CLAUDE_PROJECT_DIR;
  const t0 = process.hrtime.bigint();
  const res = spawnSync(process.execPath, [HOOK_PATH], { cwd, input: raw, encoding: 'utf8', timeout, env });
  return { stdout: res.stdout || '', stderr: res.stderr || '', status: res.status, ms: Number(process.hrtime.bigint() - t0) / 1e6 };
}

describe('secret-redact plugin copy: target (SRF Layer B)', () => {
  const posixOnly = process.platform === 'win32' ? it.skip : it;

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('blocks with no project root and writes nothing next to payload.cwd', () => {
    const cwd = mkTempDir();
    const res = runIn(JSON.stringify({ prompt: '/secret ROOT_KEY=plgvaluenoroot', cwd }), { cwd });
    expect(blocked(res)).toBe(true);
    expect(JSON.parse(res.stdout).reason).toContain('no project root');
    expect(res.stdout + res.stderr).not.toContain('plgvaluenoroot');
    expect(fs.existsSync(path.join(cwd, '.env'))).toBe(false);
  });

  it('a payload.cwd that wires secret-redact does not skip the no-project-root block', () => {
    const cwd = mkTempDir();
    wireSettings(cwd, { UserPromptSubmit: 'node ${CLAUDE_PROJECT_DIR}/.claude/hooks/secret-redact.cjs' });
    const res = runIn(JSON.stringify({ prompt: '/secret ROOT_KEY=plgvaluecwdwire', cwd }), { cwd });
    expect(blocked(res)).toBe(true);
    expect(JSON.parse(res.stdout).reason).toContain('no project root');
    expect(res.stdout + res.stderr).not.toContain('plgvaluecwdwire');
    expect(fs.existsSync(path.join(cwd, '.env'))).toBe(false);
  });

  it('an empty or relative CLAUDE_PROJECT_DIR is no project root', () => {
    for (const projectDir of ['', 'rel/project']) {
      const cwd = mkTempDir();
      fs.mkdirSync(path.join(cwd, 'rel', 'project'), { recursive: true });
      const res = runIn(JSON.stringify({ prompt: '/secret ROOT_KEY=plgvaluerel', cwd }), { cwd, projectDir });
      expect(blocked(res)).toBe(true);
      expect(JSON.parse(res.stdout).reason).toContain('no project root');
      expect(res.stdout + res.stderr).not.toContain('plgvaluerel');
      expect(fs.existsSync(path.join(cwd, '.env'))).toBe(false);
      expect(fs.existsSync(path.join(cwd, 'rel', 'project', '.env'))).toBe(false);
    }
  });

  it('the default target is CLAUDE_PROJECT_DIR, not payload.cwd', () => {
    const cwd = mkTempDir();
    const projectDir = mkTempDir();
    const res = runIn(JSON.stringify({ prompt: '/secret PROJ_KEY=plgvalueproj', cwd }), { cwd, projectDir });
    expect(blocked(res)).toBe(true);
    expect(fs.readFileSync(path.join(projectDir, '.env'), 'utf8')).toBe('PROJ_KEY=plgvalueproj\n');
    expect(fs.existsSync(path.join(cwd, '.env'))).toBe(false);
    expect(res.stdout + res.stderr).not.toContain('plgvalueproj');
  });

  posixOnly('a FIFO at the target blocks within 5 s instead of hanging', () => {
    const projectDir = mkTempDir();
    expect(spawnSync('mkfifo', [path.join(projectDir, '.env')]).status).toBe(0);
    const res = runIn(JSON.stringify({ prompt: '/secret FIFO_KEY=plgvaluefifo', cwd: projectDir }), { cwd: projectDir, projectDir, timeout: 8000 });
    expect(blocked(res)).toBe(true);
    expect(res.ms).toBeLessThan(5000);
    expect(res.stdout + res.stderr).not.toContain('plgvaluefifo');
  }, 15000);

  posixOnly('a symlinked target blocks, and the file it points at is untouched', () => {
    const projectDir = mkTempDir();
    const victim = path.join(mkTempDir(), 'victim.env');
    fs.writeFileSync(victim, 'KEEP=1\n');
    fs.symlinkSync(victim, path.join(projectDir, '.env'));
    const res = runIn(JSON.stringify({ prompt: '/secret LINK_KEY=plgvaluelink', cwd: projectDir }), { cwd: projectDir, projectDir });
    expect(blocked(res)).toBe(true);
    expect(fs.readFileSync(victim, 'utf8')).toBe('KEEP=1\n');
    expect(res.stdout + res.stderr).not.toContain('plgvaluelink');
  });

  it('a project root under _RUNS blocks the default target and saves nothing', () => {
    const projectDir = path.join(mkTempDir(), '_RUNS', 'proj');
    fs.mkdirSync(projectDir, { recursive: true });
    const res = runIn(JSON.stringify({ prompt: '/secret RUNS_KEY=plgvalueruns', cwd: projectDir }), { cwd: projectDir, projectDir });
    expect(blocked(res)).toBe(true);
    expect(JSON.parse(res.stdout).reason).toContain('_runs');
    expect(fs.existsSync(path.join(projectDir, '.env'))).toBe(false);
    expect(res.stdout + res.stderr).not.toContain('plgvalueruns');
  });

  posixOnly('--file through a symlinked directory into _runs blocks and saves nothing', () => {
    const base = mkTempDir();
    const runsDir = path.join(base, '_runs', 'x');
    fs.mkdirSync(runsDir, { recursive: true });
    const cwd = path.join(base, 'work');
    fs.mkdirSync(cwd);
    fs.symlinkSync(runsDir, path.join(cwd, 'cfg'));
    const res = runIn(JSON.stringify({ prompt: '/secret --file cfg/.env.local VIA_KEY=plgvaluevia', cwd }), { cwd, projectDir: cwd });
    expect(blocked(res)).toBe(true);
    expect(JSON.parse(res.stdout).reason).toContain('_runs');
    expect(fs.existsSync(path.join(runsDir, '.env.local'))).toBe(false);
    expect(res.stdout + res.stderr).not.toContain('plgvaluevia');
  });
});
