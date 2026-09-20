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

for (const method of ['existsSync', 'readFileSync', 'writeFileSync']) {
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

function runHook(prompt, cwd) {
  const project = createVirtualProject(cwd);
  return spawnSync(process.execPath, ['--require', project.preload, HOOK_PATH], {
    cwd: PLUGIN_ROOT,
    input: JSON.stringify({ prompt, cwd: project.virtualRoot }),
    encoding: 'utf8',
    env: {
      ...process.env,
      SECRET_REDACT_PHYSICAL_ROOT: project.physicalRoot,
      SECRET_REDACT_VIRTUAL_ROOT: project.virtualRoot,
    },
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
