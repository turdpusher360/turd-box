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

function mkTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-redact-'));
  tempDirs.push(dir);
  return dir;
}

function runHook(prompt, cwd) {
  return spawnSync(process.execPath, [HOOK_PATH], {
    cwd: PLUGIN_ROOT,
    input: JSON.stringify({ prompt, cwd }),
    encoding: 'utf8',
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
  });

  it('is wired before other UserPromptSubmit hooks in the plugin manifest', () => {
    const manifest = JSON.parse(fs.readFileSync(HOOKS_JSON, 'utf8'));
    const firstHook = manifest.hooks?.UserPromptSubmit?.[0]?.hooks?.[0];

    expect(firstHook).toBeDefined();
    expect(firstHook.command).toContain('secret-redact.cjs');
  });
});
