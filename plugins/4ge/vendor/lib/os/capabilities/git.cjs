'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

/**
 * Run a git command synchronously.
 * @param {string[]} args - git subcommand and arguments
 * @param {object} [opts] - spawnSync options override
 * @returns {{ ok: boolean, stdout: string, stderr: string, code: number }}
 */
function git(args, opts = {}) {
  const result = spawnSync('git', args, {
    timeout: 30_000,
    encoding: 'utf8',
    ...opts,
    env: { ...process.env, ...(opts.env || {}), GIT_OPTIONAL_LOCKS: '0' },
  });
  return {
    ok: result.status === 0,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
    code: result.status ?? -1,
  };
}

/**
 * Run the verification pipeline (tsc + eslint + vitest).
 * Sets the superpowers-remind marker file on success.
 * @returns {{ ok: boolean, results: object[], error?: string }}
 */
function runVerification() {
  const steps = [
    { name: 'typecheck', cmd: 'npm', args: ['run', 'type-check'] },
    { name: 'test', cmd: 'npm', args: ['test'] },
    { name: 'lint', cmd: 'npm', args: ['run', 'lint'] },
  ];

  const results = [];
  for (const step of steps) {
    const result = spawnSync(step.cmd, step.args, {
      timeout: 120_000,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    const passed = result.status === 0;
    results.push({ name: step.name, passed, code: result.status ?? -1 });
    if (!passed) {
      return {
        ok: false,
        results,
        error: `${step.name} failed (exit ${result.status})`,
      };
    }
  }

  // Set marker file so superpowers-remind.cjs knows verification ran
  try {
    const markerDir = path.join(process.cwd(), '_runs');
    fs.mkdirSync(markerDir, { recursive: true });
    fs.writeFileSync(
      path.join(markerDir, '.verification-ran'),
      new Date().toISOString()
    );
  } catch { /* best-effort */ }

  return { ok: true, results };
}

module.exports = {
  manifest: {
    name: 'git',
    version: '1.0.0',
    description: 'Delivery pipeline: dirty state, commit, ship, PR',
    depends_on: [],
    actions: {
      dirty:  { description: 'List changed files', args: [] },
      status: { description: 'Branch name, ahead/behind, stash count', args: [] },
      commit: { description: 'Verify + commit (test -> lint -> commit)', args: ['message', 'files'] },
      ship:   { description: 'Verify + commit + push', args: ['message', 'files'] },
      pr:     { description: 'Verify + commit + push + gh pr create', args: ['title', 'body', 'files'] },
    },
    health() {
      return { ...(this._healthCache || { ok: false, reason: 'not initialized' }) };
    },
    resources: {},
  },

  _os: null,
  _stateDir: null,
  _healthCache: { ok: false, reason: 'not initialized' },

  probeCost: 'cheap',
  probe() {
    try {
      const res = spawnSync('git', ['--version'], { timeout: 5000, encoding: 'utf8' });
      if (res.status === 0) {
        const result = { ok: true, version: (res.stdout || '').trim() };
        this._healthCache = result;
        return result;
      }
      const result = { ok: false, reason: `git exited ${res.status}` };
      this._healthCache = result;
      return result;
    } catch (e) {
      const result = { ok: false, reason: `probe threw: ${e.message}` };
      this._healthCache = result;
      return result;
    }
  },

  init(os) {
    const obs = os.observability;
    const t0 = Date.now();
    obs.log('capability', 'init-start', { capability: 'git', severity: 'info' });

    try {
      this._os = os;
      this._stateDir = os.capDir;

      const check = git(['--version']);
      this._healthCache = check.ok
        ? { ok: true, version: check.stdout }
        : { ok: false, reason: 'git not found' };

      obs.log('capability', 'init-complete', {
        capability: 'git',
        severity: 'info',
        durationMs: Date.now() - t0,
        version: check.ok ? check.stdout : null,
      });
    } catch (e) {
      obs.log('capability', 'init-error', {
        capability: 'git',
        severity: 'error',
        message: e.message,
        durationMs: Date.now() - t0,
      });
      throw e;
    }
  },

  shutdown() {},

  actions: {
    dirty(_args, _os) {
      const result = git(['status', '--porcelain']);
      if (!result.ok) {
        return { error: `git status failed: ${result.stderr}` };
      }
      const files = result.stdout
        .split('\n')
        .filter(Boolean)
        .map(line => ({
          status: line.slice(0, 2).trim(),
          path: line.slice(3),
        }));
      return { files, count: files.length };
    },

    status(_args, _os) {
      const branch = git(['branch', '--show-current']);
      const ahead = git(['rev-list', '--count', '@{u}..HEAD']);
      const behind = git(['rev-list', '--count', 'HEAD..@{u}']);
      const stash = git(['stash', 'list']);

      return {
        branch: branch.ok ? branch.stdout : '(detached)',
        ahead: ahead.ok ? parseInt(ahead.stdout, 10) || 0 : 0,
        behind: behind.ok ? parseInt(behind.stdout, 10) || 0 : 0,
        stashes: stash.ok ? stash.stdout.split('\n').filter(Boolean).length : 0,
      };
    },

    commit(args, _os) {
      const { message, files } = args || {};
      if (!message) return { error: 'message required' };
      if (!files || !Array.isArray(files) || files.length === 0) {
        return { error: 'files array required (use explicit paths, not git add .)' };
      }

      // CWE-22: reject path traversal
      const unsafe = files.filter(f => /\.\.[/\\]/.test(f) || path.isAbsolute(f));
      if (unsafe.length > 0) {
        return { error: `Path traversal rejected: ${unsafe.join(', ')}` };
      }

      const verify = runVerification();
      if (!verify.ok) return { error: verify.error, verification: verify.results };

      const addResult = git(['add', ...files]);
      if (!addResult.ok) return { error: `git add failed: ${addResult.stderr}` };

      const commitResult = git(['commit', '-m', message]);
      if (!commitResult.ok) return { error: `git commit failed: ${commitResult.stderr}` };

      // Emit git-cmd event for commit
      const os = module.exports._os;
      if (os && os.observability) {
        os.observability.log('capability', 'git-cmd', {
          capability: 'git',
          severity: 'info',
          cmd: 'commit',
          message: message.slice(0, 80),
          fileCount: files.length,
        });
      }

      return { committed: true, message, files, output: commitResult.stdout };
    },

    ship(args, _os) {
      const { message, files } = args || {};
      if (!message) return { error: 'message required' };

      const commitResult = this.actions.commit.call(this, { message, files }, _os);
      if (commitResult.error) return commitResult;

      const pushResult = git(['push']);
      if (!pushResult.ok) {
        // Regular push failed — do not automatically escalate to force-push.
        return { error: `git push failed: ${pushResult.stderr}. Use --force-with-lease manually if needed.` };
      }

      // Emit git-cmd event for push
      const os = module.exports._os;
      if (os && os.observability) {
        os.observability.log('capability', 'git-cmd', {
          capability: 'git',
          severity: 'info',
          cmd: 'push',
          message: message.slice(0, 80),
        });
      }

      return { ...commitResult, pushed: true };
    },

    pr(args, _os) {
      const { title, body, files, message } = args || {};
      if (!title) return { error: 'title required' };

      const shipResult = this.actions.ship.call(this, {
        message: message || title,
        files,
      }, _os);
      if (shipResult.error) return shipResult;

      const prArgs = ['pr', 'create', '--title', title];
      if (body) prArgs.push('--body', body);

      const prResult = spawnSync('gh', prArgs, {
        timeout: 30_000,
        encoding: 'utf8',
      });

      if (prResult.status !== 0) {
        return { error: `gh pr create failed: ${(prResult.stderr || '').trim()}` };
      }

      return { ...shipResult, pr_url: (prResult.stdout || '').trim() };
    },
  },
};
