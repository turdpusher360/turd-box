import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('eject/adopt lifecycle', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eject-test-'));
    // Create _runs/ dir for ejected manifest
    fs.mkdirSync(path.join(tmpDir, '_runs'), { recursive: true });
    // Mock CLAUDE_PLUGIN_ROOT to the real plugin dir
    process.env.CLAUDE_PLUGIN_ROOT = path.resolve(__dirname, '..');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.CLAUDE_PLUGIN_ROOT;
  });

  it('ejects a hook to the project directory', () => {
    const { ejectComponent } = require('../lib/eject.cjs');
    // Create target dir structure
    fs.mkdirSync(path.join(tmpDir, '.claude', 'hooks'), { recursive: true });

    const result = ejectComponent('forge-heartbeat', 'hook', tmpDir);
    expect(result.ok).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.claude', 'hooks', 'forge-heartbeat.cjs'))).toBe(true);
  });

  it('blocks ejection of protected hooks', () => {
    const { ejectComponent } = require('../lib/eject.cjs');
    const result = ejectComponent('guard-git-scope', 'hook', tmpDir);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/protected/i);
  });

  it('rejects unknown component types', () => {
    const { ejectComponent } = require('../lib/eject.cjs');
    const result = ejectComponent('foo', 'banana', tmpDir);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/unknown/i);
  });

  it('prevents double ejection', () => {
    const { ejectComponent } = require('../lib/eject.cjs');
    fs.mkdirSync(path.join(tmpDir, '.claude', 'hooks'), { recursive: true });
    ejectComponent('forge-heartbeat', 'hook', tmpDir);
    const result = ejectComponent('forge-heartbeat', 'hook', tmpDir);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/already ejected/i);
  });

  it('adopt reverses an ejection', () => {
    const { ejectComponent } = require('../lib/eject.cjs');
    const { adoptComponent } = require('../lib/adopt.cjs');
    fs.mkdirSync(path.join(tmpDir, '.claude', 'hooks'), { recursive: true });

    ejectComponent('forge-heartbeat', 'hook', tmpDir);
    expect(fs.existsSync(path.join(tmpDir, '.claude', 'hooks', 'forge-heartbeat.cjs'))).toBe(true);

    const result = adoptComponent('forge-heartbeat', 'hook', tmpDir);
    expect(result.ok).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.claude', 'hooks', 'forge-heartbeat.cjs'))).toBe(false);
  });

  it('adopt fails for non-ejected component', () => {
    const { adoptComponent } = require('../lib/adopt.cjs');
    const result = adoptComponent('nonexistent', 'hook', tmpDir);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/not ejected/i);
  });

  it('returns source-not-found for missing hook', () => {
    const { ejectComponent } = require('../lib/eject.cjs');
    const result = ejectComponent('totally-fake-hook', 'hook', tmpDir);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/source not found/i);
  });

  it('blocks path traversal in name (CWE-22)', () => {
    const { ejectComponent } = require('../lib/eject.cjs');
    const cases = ['../../.env', '../secret', 'foo/bar', 'name with spaces', ''];
    for (const name of cases) {
      const result = ejectComponent(name, 'hook', tmpDir);
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/invalid component name/i);
    }
  });

  it('adopt rejects tampered manifest dest outside project root', () => {
    const { loadEjected, saveEjected } = require('../lib/eject.cjs');
    const { adoptComponent } = require('../lib/adopt.cjs');
    // Plant a poisoned manifest entry
    const ejData = { ejected: ['hook:evil'], 'hook:evil': { dest: '/tmp/should-not-delete/evil.cjs' } };
    const fp = path.join(tmpDir, '_runs', 'ejected-components.json');
    fs.writeFileSync(fp, JSON.stringify(ejData));
    const result = adoptComponent('evil', 'hook', tmpDir);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/escapes project root/i);
  });

  it('handles structurally invalid manifest gracefully', () => {
    const { ejectComponent } = require('../lib/eject.cjs');
    // Write invalid manifest (missing ejected array)
    const fp = path.join(tmpDir, '_runs', 'ejected-components.json');
    fs.writeFileSync(fp, '{"foo": "bar"}');
    fs.mkdirSync(path.join(tmpDir, '.claude', 'hooks'), { recursive: true });
    // Should not crash — loadEjected normalizes the missing array
    const result = ejectComponent('forge-heartbeat', 'hook', tmpDir);
    expect(result.ok).toBe(true);
  });

  it('ejects a skill directory with cpSync', () => {
    const { ejectComponent } = require('../lib/eject.cjs');
    fs.mkdirSync(path.join(tmpDir, '.claude', 'skills'), { recursive: true });
    const result = ejectComponent('forge', 'skill', tmpDir);
    expect(result.ok).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.claude', 'skills', 'forge', 'SKILL.md'))).toBe(true);
  });
});
