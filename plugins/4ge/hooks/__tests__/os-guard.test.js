import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isProjectManaged, resolveOsRoot, resolveOsModuleIfProjectHas } = require('../os-guard.cjs');

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
  it('never resolves to a lib/os planted in the project directory (BL-404)', () => {
    // The plugin ships publicly: a repo that carries lib/os must not get its
    // code run by plugin hooks. Resolution stays inside the plugin's own tree.
    const projOs = path.join(tmpDir, 'lib', 'os');
    fs.mkdirSync(projOs, { recursive: true });
    fs.writeFileSync(path.join(projOs, 'index.cjs'), 'module.exports = {};\n');
    const saveData = process.env.CLAUDE_PLUGIN_DATA;
    const saveRoot = process.env.CLAUDE_PLUGIN_ROOT;
    delete process.env.CLAUDE_PLUGIN_DATA;
    delete process.env.CLAUDE_PLUGIN_ROOT;
    try {
      const resolved = resolveOsRoot(tmpDir);
      expect(resolved).not.toBeNull();
      expect(resolved.source).toBe('plugin-dirname');
      expect(resolved.root).not.toBe(tmpDir);
    } finally {
      if (saveData !== undefined) process.env.CLAUDE_PLUGIN_DATA = saveData;
      if (saveRoot !== undefined) process.env.CLAUDE_PLUGIN_ROOT = saveRoot;
    }
  });

  it('returns null, never the project dir, when the plugin ships no OS tree (BL-404)', () => {
    // A copy of os-guard with no vendor/ sibling stands in for a plugin build
    // without an OS tree. The planted project lib/os (and the test runner's own
    // cwd, a checkout with lib/os) must still never be chosen.
    const bareHooks = path.join(tmpDir, 'bare-plugin', 'hooks');
    fs.mkdirSync(bareHooks, { recursive: true });
    fs.copyFileSync(require.resolve('../os-guard.cjs'), path.join(bareHooks, 'os-guard.cjs'));
    const projOs = path.join(tmpDir, 'project', 'lib', 'os');
    fs.mkdirSync(projOs, { recursive: true });
    fs.writeFileSync(path.join(projOs, 'index.cjs'), 'module.exports = {};\n');
    const bare = require(path.join(bareHooks, 'os-guard.cjs'));
    const saveData = process.env.CLAUDE_PLUGIN_DATA;
    const saveRoot = process.env.CLAUDE_PLUGIN_ROOT;
    delete process.env.CLAUDE_PLUGIN_DATA;
    delete process.env.CLAUDE_PLUGIN_ROOT;
    try {
      expect(bare.resolveOsRoot(path.join(tmpDir, 'project'))).toBeNull();
      expect(bare.resolveOsModule('index.cjs')).toBeNull();
    } finally {
      if (saveData !== undefined) process.env.CLAUDE_PLUGIN_DATA = saveData;
      if (saveRoot !== undefined) process.env.CLAUDE_PLUGIN_ROOT = saveRoot;
    }
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

  it('resolveOsModuleIfProjectHas returns the plugin copy only when the project carries the module (BL-404)', () => {
    const dataRoot = path.join(tmpDir, 'plugin-data');
    const vendoredOs = path.join(dataRoot, 'vendor', 'lib', 'os');
    fs.mkdirSync(path.join(vendoredOs, 'services'), { recursive: true });
    fs.writeFileSync(path.join(vendoredOs, 'index.cjs'), 'module.exports = {};\n');
    const project = path.join(tmpDir, 'project');
    fs.mkdirSync(project, { recursive: true });
    const saveData = process.env.CLAUDE_PLUGIN_DATA;
    process.env.CLAUDE_PLUGIN_DATA = dataRoot;
    try {
      expect(resolveOsModuleIfProjectHas(project, 'services', 'ipc.cjs')).toBeNull();
      fs.mkdirSync(path.join(project, 'lib', 'os', 'services'), { recursive: true });
      fs.writeFileSync(path.join(project, 'lib', 'os', 'services', 'ipc.cjs'), 'module.exports = {};\n');
      expect(resolveOsModuleIfProjectHas(project, 'services', 'ipc.cjs'))
        .toBe(path.join(vendoredOs, 'services', 'ipc.cjs'));
    } finally {
      if (saveData !== undefined) process.env.CLAUDE_PLUGIN_DATA = saveData;
      else delete process.env.CLAUDE_PLUGIN_DATA;
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

  it('ignores a relative CLAUDE_PLUGIN_DATA or CLAUDE_PLUGIN_ROOT, which would resolve against the cwd', () => {
    // The relative value points at a real vendored tree, so only the absolute
    // check keeps it out. The dirname fallback may still answer.
    const dataRoot = path.join(tmpDir, 'plugin-data');
    const vendoredOs = path.join(dataRoot, 'vendor', 'lib', 'os');
    fs.mkdirSync(vendoredOs, { recursive: true });
    fs.writeFileSync(path.join(vendoredOs, 'index.cjs'), 'module.exports = {};\n');
    const relative = path.relative(process.cwd(), dataRoot);
    expect(path.isAbsolute(relative)).toBe(false);
    expect(fs.existsSync(path.join(relative, 'vendor', 'lib', 'os', 'index.cjs'))).toBe(true);
    const saveData = process.env.CLAUDE_PLUGIN_DATA;
    const saveRoot = process.env.CLAUDE_PLUGIN_ROOT;
    try {
      for (const [set, unset] of [['CLAUDE_PLUGIN_DATA', 'CLAUDE_PLUGIN_ROOT'], ['CLAUDE_PLUGIN_ROOT', 'CLAUDE_PLUGIN_DATA']]) {
        process.env[set] = relative;
        delete process.env[unset];
        const resolved = resolveOsRoot(tmpDir);
        expect(resolved === null || resolved.source === 'plugin-dirname').toBe(true);
      }
    } finally {
      if (saveData !== undefined) process.env.CLAUDE_PLUGIN_DATA = saveData;
      else delete process.env.CLAUDE_PLUGIN_DATA;
      if (saveRoot !== undefined) process.env.CLAUDE_PLUGIN_ROOT = saveRoot;
      else delete process.env.CLAUDE_PLUGIN_ROOT;
    }
  });
});
