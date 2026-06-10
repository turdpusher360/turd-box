import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isProjectManaged, resolveOsRoot } = require('../os-guard.cjs');

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'os-guard-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeSettings(obj) {
  const dir = path.join(tmpDir, '.claude');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(obj, null, 2));
}

describe('isProjectManaged', () => {
  it('returns false when no .claude/settings.json exists', () => {
    expect(isProjectManaged(tmpDir, 'os-boot')).toBe(false);
  });

  it('returns false when settings has no hooks', () => {
    writeSettings({ env: { FOO: '1' } });
    expect(isProjectManaged(tmpDir, 'os-boot')).toBe(false);
  });

  it('detects a project-wired os-boot under SessionStart', () => {
    writeSettings({
      hooks: {
        SessionStart: [
          {
            hooks: [
              { type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/os-boot.cjs"' },
            ],
          },
        ],
      },
    });
    expect(isProjectManaged(tmpDir, 'os-boot')).toBe(true);
  });

  it('detects os-accounting independently of os-boot', () => {
    writeSettings({
      hooks: {
        PostToolUse: [
          { hooks: [{ type: 'command', command: 'node .claude/hooks/os-accounting.cjs' }] },
        ],
      },
    });
    expect(isProjectManaged(tmpDir, 'os-accounting')).toBe(true);
    expect(isProjectManaged(tmpDir, 'os-boot')).toBe(false);
  });

  it('returns false for unrelated hooks', () => {
    writeSettings({
      hooks: {
        SessionStart: [
          { hooks: [{ type: 'command', command: 'node .claude/hooks/session-reaper.cjs' }] },
        ],
      },
    });
    expect(isProjectManaged(tmpDir, 'os-boot')).toBe(false);
  });

  it('returns false (not throw) on malformed settings JSON', () => {
    const dir = path.join(tmpDir, '.claude');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'settings.json'), '{ not valid json');
    expect(isProjectManaged(tmpDir, 'os-boot')).toBe(false);
  });
});

describe('resolveOsRoot', () => {
  it('prefers the project lib/os when present', () => {
    const projOs = path.join(tmpDir, 'lib', 'os');
    fs.mkdirSync(projOs, { recursive: true });
    fs.writeFileSync(path.join(projOs, 'index.cjs'), 'module.exports = {};\n');
    const resolved = resolveOsRoot(tmpDir);
    expect(resolved).not.toBeNull();
    expect(resolved.source).toBe('project');
    expect(resolved.root).toBe(tmpDir);
  });

  it('falls back to the vendored tree shipped next to the hooks dir', () => {
    // tmpDir has no lib/os; CLAUDE_PLUGIN_DATA/ROOT are unset in the test env,
    // so resolution lands on __dirname/../vendor — the real vendored tree.
    const saveData = process.env.CLAUDE_PLUGIN_DATA;
    const saveRoot = process.env.CLAUDE_PLUGIN_ROOT;
    delete process.env.CLAUDE_PLUGIN_DATA;
    delete process.env.CLAUDE_PLUGIN_ROOT;
    try {
      const resolved = resolveOsRoot(tmpDir);
      expect(resolved).not.toBeNull();
      expect(resolved.source).toBe('plugin-dirname');
      expect(fs.existsSync(path.join(resolved.root, 'lib', 'os', 'index.cjs'))).toBe(true);
    } finally {
      if (saveData !== undefined) process.env.CLAUDE_PLUGIN_DATA = saveData;
      if (saveRoot !== undefined) process.env.CLAUDE_PLUGIN_ROOT = saveRoot;
    }
  });

  it('honors CLAUDE_PLUGIN_DATA over the dirname fallback', () => {
    const dataRoot = path.join(tmpDir, 'plugin-data');
    const vendoredOs = path.join(dataRoot, 'vendor', 'lib', 'os');
    fs.mkdirSync(vendoredOs, { recursive: true });
    fs.writeFileSync(path.join(vendoredOs, 'index.cjs'), 'module.exports = {};\n');
    const saveData = process.env.CLAUDE_PLUGIN_DATA;
    process.env.CLAUDE_PLUGIN_DATA = dataRoot;
    try {
      const resolved = resolveOsRoot(tmpDir);
      expect(resolved).not.toBeNull();
      expect(resolved.source).toBe('plugin-data');
      expect(resolved.root).toBe(path.join(dataRoot, 'vendor'));
    } finally {
      if (saveData !== undefined) process.env.CLAUDE_PLUGIN_DATA = saveData;
      else delete process.env.CLAUDE_PLUGIN_DATA;
    }
  });
});
