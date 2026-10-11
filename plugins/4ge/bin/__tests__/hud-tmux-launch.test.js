import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// hud-tmux-launch.sh must keep argument boundaries (C1.1, S702). Each case
// copies the launcher beside a dummy hud-tmux-pane.cjs into a temp dir whose
// name holds a quote and a "$(", so the real renderer never runs. A stub tmux
// first on PATH records its argv (NUL-separated). The child env is built from
// scratch with a fake TMUX socket and no TMUX_PANE, so no case can reach a real
// tmux server, and every tmux case fails unless the stub ran. The recorded pane
// command is then run the way tmux runs it (its default shell with -c), under
// sh, bash and zsh (when present), with a stub node that records the words it
// received. A stub `x` first on PATH creates the sentinel, so the "$(x)" in the
// dir name is a tripwire: if a defective launcher ever lets a shell evaluate it,
// the case fails and no host program named x can run.

const LAUNCHER = path.resolve(__dirname, '../hud-tmux-launch.sh');

function which(cmd) {
  const r = spawnSync('bash', ['-c', `command -v ${cmd}`], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
}

const BASH = process.platform === 'win32' ? '' : which('bash');
const SH = process.platform === 'win32' ? '' : which('sh');
const ZSH = process.platform === 'win32' ? '' : which('zsh');
const DIRNAME = process.platform === 'win32' ? '' : which('dirname');
const SHELLS = [SH, BASH, ...(ZSH ? [ZSH] : [])];
const WRAPPER = `-c 'node "$@"; read -r -p "HUD exited. Press Enter to close pane."' hud-tmux-pane `;

// SENTINEL is replaced with a real path per case; nothing may ever create it.
const HOSTILE = [
  'two words',
  "it's",
  '"double"',
  '; touch SENTINEL',
  '$(touch SENTINEL)',
  '`touch SENTINEL`',
  "'; touch SENTINEL; '",
  'x;',
  'line1\nline2; touch SENTINEL',
  '-n',
  '--',
  '',
  '*',
  '$HOME',
  'back\\slash',
  '#{pane_id}',
  'a&b',
];

const LAUNCHED_STDOUT = 'HUD pane launched. Use Ctrl+B then arrow keys to switch panes.\n'
  + "Press 'q' in the HUD pane to close it.\n";

let tmp;
let dir;
let stubDir;
let hudScript;
let tmuxArgv;
let nodeArgv;
let sentinel;

function writeStub(where, name, body) {
  const p = path.join(where, name);
  fs.writeFileSync(p, `#!${BASH}\n${body}`);
  fs.chmodSync(p, 0o755);
}

function env(extra = {}) {
  return {
    PATH: `${stubDir}:${process.env.PATH}`,
    HOME: tmp,
    TMUX: path.join(tmp, 'no-such-tmux-socket') + ',0,0',
    HUD_TEST_TMUX_ARGV: tmuxArgv,
    HUD_TEST_NODE_ARGV: nodeArgv,
    HUD_TEST_SENTINEL: sentinel,
    ...extra,
  };
}

function runLauncher(args, childEnv = env()) {
  return spawnSync(BASH, [path.join(dir, 'hud-tmux-launch.sh'), ...args], {
    cwd: tmp,
    env: childEnv,
    encoding: 'utf8',
  });
}

// Run a command string as tmux would; stdin at EOF so the pause prompt returns.
function runAsShell(shell, command, childEnv = env()) {
  fs.rmSync(nodeArgv, { force: true });
  return spawnSync(shell, ['-c', command], { cwd: tmp, env: childEnv, input: '', encoding: 'utf8' });
}

function readNul(file) {
  return fs.readFileSync(file, 'utf8').split('\0').slice(0, -1);
}

function paneCommand() {
  expect(fs.existsSync(tmuxArgv)).toBe(true);
  const argv = readNul(tmuxArgv);
  expect(argv.slice(0, 5)).toEqual(['split-window', '-v', '-b', '-l', '60%']);
  expect(argv).toHaveLength(6);
  return argv[5];
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hud-tmux-launch-')));
  dir = path.join(tmp, "bin it's $(x)");
  fs.mkdirSync(dir);
  fs.copyFileSync(LAUNCHER, path.join(dir, 'hud-tmux-launch.sh'));
  hudScript = path.join(dir, 'hud-tmux-pane.cjs');
  fs.writeFileSync(hudScript, '// dummy: the real renderer never runs in these tests\n');
  stubDir = path.join(tmp, 'stubs');
  fs.mkdirSync(stubDir);
  tmuxArgv = path.join(tmp, 'tmux-argv');
  nodeArgv = path.join(tmp, 'node-argv');
  sentinel = path.join(tmp, 'sentinel');
  writeStub(stubDir, 'tmux', 'printf \'%s\\0\' "$@" > "$HUD_TEST_TMUX_ARGV"\nexit "${HUD_TEST_TMUX_EXIT:-0}"\n');
  writeStub(stubDir, 'node', 'printf \'%s\\0\' "$@" > "$HUD_TEST_NODE_ARGV"\n');
  writeStub(stubDir, 'x', ': > "$HUD_TEST_SENTINEL"\n');
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe.skipIf(!BASH || !SH || !DIRNAME)('hud-tmux-launch.sh argument boundaries', () => {
  it('hands each hostile argument to node as one literal word, under every shell', () => {
    const args = HOSTILE.map((a) => a.replaceAll('SENTINEL', sentinel));
    const r = runLauncher(args);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(LAUNCHED_STDOUT);

    const command = paneCommand();
    // A trailing ';' on a tmux argv element is a tmux command separator.
    expect(command.endsWith("'")).toBe(true);
    // The launcher's own bash, by absolute path, runs the fixed pause wrapper.
    expect(command.startsWith(`exec '${BASH}' ${WRAPPER}`)).toBe(true);

    for (const shell of SHELLS) {
      runAsShell(shell, command);
      expect(readNul(nodeArgv)).toEqual([hudScript, ...args]);
    }
    expect(fs.existsSync(sentinel)).toBe(false);
  });

  it('keeps the no-argument launch unchanged', () => {
    const r = runLauncher([]);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(LAUNCHED_STDOUT);

    const command = paneCommand();
    for (const shell of SHELLS) {
      runAsShell(shell, command);
      expect(readNul(nodeArgv)).toEqual([hudScript]);
    }
    expect(fs.existsSync(sentinel)).toBe(false);
  });

  it('runs the pane when the shell PATH holds no bash (absolute bash path)', () => {
    const r = runLauncher(['--theme', 'dark']);
    expect(r.status).toBe(0);
    const command = paneCommand();
    runAsShell(SH, command, env({ PATH: stubDir }));
    expect(readNul(nodeArgv)).toEqual([hudScript, '--theme', 'dark']);
  });

  it("returns tmux's exit status when split-window fails", () => {
    const r = runLauncher(['--theme', 'x'], env({ HUD_TEST_TMUX_EXIT: '3' }));
    expect(r.status).toBe(3);
    expect(r.stdout).not.toContain('HUD pane launched');
    paneCommand();
  });

  it('outside tmux, prints a paste-safe command and exits 1 without calling tmux', () => {
    const args = HOSTILE.map((a) => a.replaceAll('SENTINEL', sentinel));
    const childEnv = env();
    delete childEnv.TMUX;
    const r = runLauncher(args, childEnv);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('Error: not inside a tmux session.');
    expect(fs.existsSync(tmuxArgv)).toBe(false);

    const marker = 'Or run the HUD pane directly:\n  ';
    const at = r.stdout.indexOf(marker);
    expect(at).toBeGreaterThan(-1);
    const shown = r.stdout.slice(at + marker.length, -1);
    expect(shown.startsWith('node ')).toBe(true);

    for (const shell of SHELLS) {
      runAsShell(shell, shown);
      expect(readNul(nodeArgv)).toEqual([hudScript, ...args]);
    }
    expect(fs.existsSync(sentinel)).toBe(false);
  });

  it('exits 1 without calling tmux when node is not on PATH', () => {
    const bare = path.join(tmp, 'bare');
    fs.mkdirSync(bare);
    fs.symlinkSync(DIRNAME, path.join(bare, 'dirname'));
    writeStub(bare, 'tmux', 'printf \'%s\\0\' "$@" > "$HUD_TEST_TMUX_ARGV"\n');
    const r = runLauncher([], env({ PATH: bare }));
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('Error: node not found on PATH.\n');
    expect(fs.existsSync(tmuxArgv)).toBe(false);
  });

  it('exits 1 without calling tmux when the pane script is missing', () => {
    fs.rmSync(hudScript);
    const r = runLauncher([]);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe(`Error: HUD script not found at ${hudScript}\n`);
    expect(fs.existsSync(tmuxArgv)).toBe(false);
  });
});
