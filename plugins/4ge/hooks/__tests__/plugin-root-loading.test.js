import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// BL-404: the public 4ge plugin must load Agentic OS modules only from its own
// tree (CLAUDE_PLUGIN_DATA / CLAUDE_PLUGIN_ROOT / __dirname vendor copies),
// never from the opened project's lib/os. Every OS module below is planted
// twice: under <project>/lib/os, and under <plugin-data>/vendor/lib/os.
// Each copy writes a marker file when it is require()d. Hooks swallow errors,
// so exit codes prove nothing; the markers are the evidence. The plugin marker
// is the positive control: it proves the hook reached its load site.

const require = createRequire(import.meta.url);
const HOOKS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN_DIR = path.resolve(HOOKS_DIR, '..', 'bin');

const OS_STUBS = {
  'index.cjs': '{}',
  'capabilities/file-integrity.cjs': '{ boot() {}, track() {} }',
  // createIPC records its arguments: the heartbeat tests pin where IPC writes.
  'services/ipc.cjs': "{ createIPC(stateDir, sessionId) { require('node:fs').writeFileSync(require('node:path').join(__dirname, 'createIPC-args.json'), JSON.stringify([stateDir, sessionId])); return { send() {}, cleanup() {} }; } }",
  'jsonl-rotate.cjs': '{ appendJsonl() {} }',
  // refreshAll records the capDir it was handed: it require()s every module
  // there, so the A7 test pins that directory as well as this module.
  'health-refresh.cjs': "{ refreshAll(capDir) { require('node:fs').writeFileSync(require('node:path').join(__dirname, 'refreshAll-capDir.txt'), String(capDir)); return {}; }, refreshCheap() { return {}; } }",
  'kernel/boot-sequence.cjs': '{ run() { return { ok: true, steps: [] }; } }',
  'kernel/feature-gates.cjs': '{ createFeatureGates() { return { isEnabled() { return false; } }; } }',
};

let tmpDir;
let projectDir;
let pluginData;
let markerDir;

function markerName(side, rel) {
  return `${side}__${rel.replace(/[/.]/g, '_')}`;
}

function plantOsTree(osDir, side) {
  for (const [rel, exportsSrc] of Object.entries(OS_STUBS)) {
    const file = path.join(osDir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const marker = path.join(markerDir, markerName(side, rel));
    fs.writeFileSync(
      file,
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, '1');\nmodule.exports = ${exportsSrc};\n`,
    );
  }
}

function markers() {
  return fs.readdirSync(markerDir).sort();
}

function cwdMarkers() {
  return markers().filter((m) => m.startsWith('cwd__'));
}

function hookEnv() {
  const env = { ...process.env };
  for (const k of ['CLAUDE_PLUGIN_ROOT', 'CLAUDE_PLUGIN_DATA', 'CLAUDE_PROJECT_DIR', 'CLAUDE_SESSION_ID']) {
    delete env[k];
  }
  env.CLAUDE_PLUGIN_DATA = pluginData;
  return env;
}

// A forge session whose next heartbeat, the 10th call, is the throttled full
// update that broadcasts over IPC. Returns the heartbeat file.
function armHeartbeat(osState) {
  fs.writeFileSync(path.join(projectDir, '.forge-session.json'), JSON.stringify({ teammates: [] }));
  fs.mkdirSync(path.join(projectDir, '_runs'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, '_runs', '.os-state.json'), JSON.stringify(osState));
  const hbFile = path.join(pluginData, 'forge', '.forge-heartbeat.json');
  fs.mkdirSync(path.dirname(hbFile), { recursive: true });
  fs.writeFileSync(hbFile, JSON.stringify({ call_count: 9, teammates: {} }));
  return hbFile;
}

// [stateDir, sessionId] the plugin's createIPC stub received, or null.
function ipcArgs() {
  const f = path.join(pluginData, 'vendor', 'lib', 'os', 'services', 'createIPC-args.json');
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
}

function runHook(hookFile, args, input) {
  return spawnSync(process.execPath, [path.join(HOOKS_DIR, hookFile), ...args], {
    cwd: projectDir,
    env: hookEnv(),
    input,
    encoding: 'utf8',
    timeout: 15000,
  });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl404-plugin-root-'));
  projectDir = path.join(tmpDir, 'project');
  pluginData = path.join(tmpDir, 'plugin-data');
  markerDir = path.join(tmpDir, 'markers');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(markerDir, { recursive: true });
  plantOsTree(path.join(projectDir, 'lib', 'os'), 'cwd');
  plantOsTree(path.join(pluginData, 'vendor', 'lib', 'os'), 'plugin');
  // file-integrity-guard resolves hook-utils under CLAUDE_PLUGIN_DATA/hooks.
  fs.mkdirSync(path.join(pluginData, 'hooks'), { recursive: true });
  fs.copyFileSync(path.join(HOOKS_DIR, 'hook-utils.cjs'), path.join(pluginData, 'hooks', 'hook-utils.cjs'));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('BL-404: plugin hooks never load OS modules from the project directory', () => {
  it('file-integrity-guard boot (SessionStart) loads the plugin copy, not <cwd>/lib/os', () => {
    runHook('file-integrity-guard.cjs', ['boot'], '');
    expect(cwdMarkers()).toEqual([]);
    expect(markers()).toContain(markerName('plugin', 'capabilities/file-integrity.cjs'));
  });

  it('file-integrity-guard track (PostToolUse Write) loads the plugin copy, not <cwd>/lib/os', () => {
    const input = JSON.stringify({
      session_id: 'bl404',
      tool_name: 'Write',
      tool_input: { file_path: path.join(projectDir, 'x.txt') },
    });
    runHook('file-integrity-guard.cjs', [], input);
    expect(cwdMarkers()).toEqual([]);
    expect(markers()).toContain(markerName('plugin', 'capabilities/file-integrity.cjs'));
  });

  it('with no plugin OS tree, file-integrity-guard skips instead of falling back to <cwd>/lib/os', () => {
    // Hook copies with no vendor/ sibling and no CLAUDE_PLUGIN_DATA: the plugin
    // ships no OS tree, so the feature is skipped and nothing is loaded at all.
    const bareHooks = path.join(tmpDir, 'bare-plugin', 'hooks');
    fs.mkdirSync(bareHooks, { recursive: true });
    for (const f of ['file-integrity-guard.cjs', 'os-guard.cjs', 'hook-utils.cjs']) {
      fs.copyFileSync(path.join(HOOKS_DIR, f), path.join(bareHooks, f));
    }
    const env = hookEnv();
    delete env.CLAUDE_PLUGIN_DATA;
    const r = spawnSync(process.execPath, [path.join(bareHooks, 'file-integrity-guard.cjs'), 'boot'], {
      cwd: projectDir,
      env,
      encoding: 'utf8',
      timeout: 15000,
    });
    expect(r.status).toBe(0);
    expect(markers()).toEqual([]);
  });

  it('file-integrity-guard exits 0 beside an older or missing os-guard.cjs (mid-upgrade sync)', () => {
    // sync-to-data.cjs copies hooks one file at a time, so a new hook can run
    // next to the previous os-guard.cjs, which lacks resolveOsModuleIfProjectHas,
    // or before os-guard.cjs exists at all.
    const variants = {
      older: 'module.exports = { isProjectManaged() { return false; }, resolveOsRoot() { return null; } };\n',
      missing: null,
    };
    for (const [name, osGuardSrc] of Object.entries(variants)) {
      const hooks = path.join(tmpDir, `upgrade-${name}`, 'hooks');
      fs.mkdirSync(hooks, { recursive: true });
      fs.copyFileSync(path.join(HOOKS_DIR, 'file-integrity-guard.cjs'), path.join(hooks, 'file-integrity-guard.cjs'));
      if (osGuardSrc !== null) fs.writeFileSync(path.join(hooks, 'os-guard.cjs'), osGuardSrc);
      const run = (args, input) => spawnSync(process.execPath, [path.join(hooks, 'file-integrity-guard.cjs'), ...args], {
        cwd: projectDir,
        env: hookEnv(),
        input,
        encoding: 'utf8',
        timeout: 15000,
      });
      const boot = run(['boot'], '');
      const track = run([], JSON.stringify({
        session_id: 'bl404',
        tool_name: 'Write',
        tool_input: { file_path: path.join(projectDir, 'x.txt') },
      }));
      expect({ name, boot: boot.status, track: track.status }).toEqual({ name, boot: 0, track: 0 });
    }
    expect(markers()).toEqual([]);
  });

  it('with no plugin OS tree, os-boot and os-accounting skip instead of falling back to <cwd>/lib/os', () => {
    const bareHooks = path.join(tmpDir, 'bare-plugin', 'hooks');
    fs.mkdirSync(bareHooks, { recursive: true });
    for (const f of ['os-boot.cjs', 'os-accounting.cjs', 'os-guard.cjs', 'hook-utils.cjs']) {
      fs.copyFileSync(path.join(HOOKS_DIR, f), path.join(bareHooks, f));
    }
    const env = hookEnv();
    delete env.CLAUDE_PLUGIN_DATA;
    const run = (file, input) => spawnSync(process.execPath, [path.join(bareHooks, file)], {
      cwd: projectDir,
      env,
      input,
      encoding: 'utf8',
      timeout: 15000,
    });
    const boot = run('os-boot.cjs', JSON.stringify({ session_id: 'bl404', source: 'startup' }));
    const acct = run('os-accounting.cjs', '{}');
    expect(boot.status).toBe(0);
    expect(boot.stderr).toContain('no vendored OS tree found');
    expect(acct.status).toBe(0);
    expect(markers()).toEqual([]);
  });

  it('forge-heartbeat IPC broadcast loads the plugin ipc.cjs, not <cwd>/lib/os', () => {
    // The shape os-boot writes: <cwd>/_runs/os and the session UUID.
    const stateDir = path.join(projectDir, '_runs', 'os');
    const sessionId = '6ac42dcc-ba97-496f-affb-2b02831642e7';
    armHeartbeat({ stateDir, sessionId });
    runHook('forge-heartbeat.cjs', [], '{}');
    expect(cwdMarkers()).toEqual([]);
    expect(markers()).toContain(markerName('plugin', 'services/ipc.cjs'));
    expect(ipcArgs()).toEqual([stateDir, sessionId]);
  });

  it('forge-heartbeat skips IPC when .os-state.json names another directory or a path-like session id', () => {
    // IPC writes under <stateDir>/ipc/<sessionId> and cleanup() deletes there,
    // so either field could aim both outside the project.
    const cases = {
      traversal: { stateDir: path.join(projectDir, '_runs', 'os'), sessionId: '../../../escape' },
      foreignDir: { stateDir: path.join(tmpDir, 'elsewhere'), sessionId: 'bl404' },
    };
    for (const [name, osState] of Object.entries(cases)) {
      const hbFile = armHeartbeat(osState);
      runHook('forge-heartbeat.cjs', [], '{}');
      // Positive control: the 10th call ran the full update.
      expect({ name, calls: JSON.parse(fs.readFileSync(hbFile, 'utf8')).call_count }).toEqual({ name, calls: 10 });
      expect({ name, ipc: ipcArgs() }).toEqual({ name, ipc: null });
    }
    expect(markers()).toEqual([]);
  });

  it('forge-heartbeat skips IPC when any component of _runs/os/ipc/<id> is a symlink, and broadcasts through real dirs', () => {
    // The real vendored ipc.cjs (plus the marker line), so the heartbeat
    // writes and its cleanup deletes for real. Everything stays under tmpDir.
    const ipcMarker = path.join(markerDir, markerName('plugin', 'services/ipc.cjs'));
    fs.writeFileSync(
      path.join(pluginData, 'vendor', 'lib', 'os', 'services', 'ipc.cjs'),
      `require('node:fs').writeFileSync(${JSON.stringify(ipcMarker)}, '1');\n`
        + fs.readFileSync(path.join(HOOKS_DIR, '..', 'vendor', 'lib', 'os', 'services', 'ipc.cjs'), 'utf8'),
    );
    const sessionId = 'x';
    const ipcPath = path.join('_runs', 'os', 'ipc', sessionId);
    const outside = path.join(tmpDir, 'outside');
    const hourAgo = Date.now() / 1000 - 3600;
    const plantStale = (dir) => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'stale.json'), '{}');
      fs.utimesSync(path.join(dir, 'stale.json'), hourAgo, hourAgo);
    };
    for (const link of ['_runs', path.join('_runs', 'os'), path.join('_runs', 'os', 'ipc'), ipcPath]) {
      fs.rmSync(path.join(projectDir, '_runs'), { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
      // The directory IPC would use once it follows the link: it holds an old *.json.
      const victim = path.join(outside, path.relative(link, ipcPath));
      plantStale(victim);
      fs.mkdirSync(path.join(projectDir, path.dirname(link)), { recursive: true });
      fs.symlinkSync(outside, path.join(projectDir, link), 'dir');
      const hbFile = armHeartbeat({ stateDir: path.join(projectDir, '_runs', 'os'), sessionId });
      runHook('forge-heartbeat.cjs', [], '{}');
      // Positive control: the 10th call ran the full update.
      expect({ link, calls: JSON.parse(fs.readFileSync(hbFile, 'utf8')).call_count }).toEqual({ link, calls: 10 });
      expect({ link, victim: fs.readdirSync(victim) }).toEqual({ link, victim: ['stale.json'] });
      expect({ link, ipcLoaded: fs.existsSync(ipcMarker) }).toEqual({ link, ipcLoaded: false });
    }
    // Canonical case through real directories: IPC loads, writes the
    // heartbeat and cleans the stale file, all inside the project.
    fs.rmSync(path.join(projectDir, '_runs'), { recursive: true, force: true });
    const real = path.join(projectDir, ipcPath);
    plantStale(real);
    armHeartbeat({ stateDir: path.join(projectDir, '_runs', 'os'), sessionId });
    runHook('forge-heartbeat.cjs', [], '{}');
    expect(fs.existsSync(ipcMarker)).toBe(true);
    const left = fs.readdirSync(real);
    expect(left).not.toContain('stale.json');
    expect(left.filter((f) => f.endsWith('.json'))).toHaveLength(1);
    // The last link case left its stale file at the root of outside; untouched.
    expect(fs.readdirSync(outside)).toEqual(['stale.json']);
  });

  it('os-boot (SessionStart) boots the vendored OS, not <cwd>/lib/os', () => {
    runHook('os-boot.cjs', [], JSON.stringify({ session_id: 'bl404', source: 'startup' }));
    expect(cwdMarkers()).toEqual([]);
    expect(markers()).toContain(markerName('plugin', 'kernel/boot-sequence.cjs'));
  });

  it('os-accounting (tool calls) reads feature gates from the vendored OS, not <cwd>/lib/os', () => {
    runHook('os-accounting.cjs', [], '{}');
    expect(cwdMarkers()).toEqual([]);
    expect(markers()).toContain(markerName('plugin', 'kernel/feature-gates.cjs'));
  });

  describe('in-process loaders', () => {
    let saveData;
    let saveRoot;

    beforeEach(() => {
      saveData = process.env.CLAUDE_PLUGIN_DATA;
      saveRoot = process.env.CLAUDE_PLUGIN_ROOT;
      process.env.CLAUDE_PLUGIN_DATA = pluginData;
      delete process.env.CLAUDE_PLUGIN_ROOT;
    });

    afterEach(() => {
      if (saveData !== undefined) process.env.CLAUDE_PLUGIN_DATA = saveData;
      else delete process.env.CLAUDE_PLUGIN_DATA;
      if (saveRoot !== undefined) process.env.CLAUDE_PLUGIN_ROOT = saveRoot;
    });

    it('forge-scope-check drift logging loads the plugin jsonl-rotate, not <cwd>/lib/os', () => {
      vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
      const { checkScopeDrift } = require('../forge-scope-check.cjs');
      const session = { teammates: [{ name: 'tm', scope: ['src/'] }] };
      const result = checkScopeDrift('docs/outside.md', 'tm', session);
      expect(result.inScope).toBe(false);
      expect(cwdMarkers()).toEqual([]);
      expect(markers()).toContain(markerName('plugin', 'jsonl-rotate.cjs'));
    });

    it('hud-data-loader expensive refresh probes the vendored OS, not <cwd>/lib/os', () => {
      const { loadHudData } = require(path.join(BIN_DIR, 'hud-data-loader.cjs'));
      loadHudData({ cwd: projectDir, stateDir: path.join(tmpDir, 'state'), runExpensiveProbes: true });
      expect(cwdMarkers()).toEqual([]);
      expect(markers()).toContain(markerName('plugin', 'health-refresh.cjs'));
      const vendoredOs = path.join(pluginData, 'vendor', 'lib', 'os');
      expect(fs.readFileSync(path.join(vendoredOs, 'refreshAll-capDir.txt'), 'utf8'))
        .toBe(path.join(vendoredOs, 'capabilities'));
    });
  });

  // The hooks above only ever ran where the project carried lib/os. In a
  // project without it they must stay inert: the plugin copy is not loaded
  // either. Each case keeps a positive control proving the hook ran.
  describe('projects without lib/os stay inert', () => {
    beforeEach(() => {
      fs.rmSync(path.join(projectDir, 'lib'), { recursive: true, force: true });
    });

    it('file-integrity-guard boot and track load nothing', () => {
      const boot = runHook('file-integrity-guard.cjs', ['boot'], '');
      const track = runHook('file-integrity-guard.cjs', [], JSON.stringify({
        session_id: 'bl404',
        tool_name: 'Write',
        tool_input: { file_path: path.join(projectDir, 'x.txt') },
      }));
      expect(boot.status).toBe(0);
      expect(track.status).toBe(0);
      expect(markers()).toEqual([]);
    });

    it('forge-heartbeat skips the IPC broadcast but still writes its heartbeat', () => {
      const hbFile = armHeartbeat({ stateDir: path.join(projectDir, '_runs', 'os'), sessionId: 'bl404' });
      runHook('forge-heartbeat.cjs', [], '{}');
      expect(markers()).toEqual([]);
      expect(JSON.parse(fs.readFileSync(hbFile, 'utf8')).call_count).toBe(10);
    });

    describe('in-process loaders', () => {
      let saveData;
      let saveRoot;

      beforeEach(() => {
        saveData = process.env.CLAUDE_PLUGIN_DATA;
        saveRoot = process.env.CLAUDE_PLUGIN_ROOT;
        process.env.CLAUDE_PLUGIN_DATA = pluginData;
        delete process.env.CLAUDE_PLUGIN_ROOT;
      });

      afterEach(() => {
        if (saveData !== undefined) process.env.CLAUDE_PLUGIN_DATA = saveData;
        else delete process.env.CLAUDE_PLUGIN_DATA;
        if (saveRoot !== undefined) process.env.CLAUDE_PLUGIN_ROOT = saveRoot;
      });

      it('forge-scope-check logs drift by plain append, loading no jsonl-rotate', () => {
        vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
        fs.mkdirSync(path.join(projectDir, '_runs'), { recursive: true });
        const { checkScopeDrift } = require('../forge-scope-check.cjs');
        const session = { teammates: [{ name: 'tm', scope: ['src/'] }] };
        expect(checkScopeDrift('docs/outside.md', 'tm', session).inScope).toBe(false);
        expect(markers()).toEqual([]);
        const log = fs.readFileSync(path.join(projectDir, '_runs', 'scope-drift.jsonl'), 'utf8');
        expect(JSON.parse(log.trim()).file).toBe('docs/outside.md');
      });

      it('hud-data-loader expensive refresh probes nothing', () => {
        const { loadHudData } = require(path.join(BIN_DIR, 'hud-data-loader.cjs'));
        const data = loadHudData({ cwd: projectDir, stateDir: path.join(tmpDir, 'state'), runExpensiveProbes: true });
        expect(data).toBeTypeOf('object');
        expect(markers()).toEqual([]);
      });
    });
  });
});
