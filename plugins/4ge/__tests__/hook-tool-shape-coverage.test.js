/**
 * C1 regression: security hooks must cover ALL four write-tool shapes.
 *
 * Before the S373 fix, file-content-secret-guard and agent-config-readonly
 * only matched/extracted Write|Edit, so an agent using MultiEdit or
 * NotebookEdit wrote embedded secrets or .claude/ files completely unscanned.
 * These tests assert every write-tool shape is covered.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..'); // repository root
const secretGuard = path.join(ROOT, '.claude', 'hooks', 'file-content-secret-guard.cjs');
const configGuard = path.join(ROOT, '.claude', 'hooks', 'agent-config-readonly.cjs');

// AWS example key (split so this test file itself doesn't trip secret scanners)
const AWS_KEY = 'AKIA' + 'IOSFODNN7EXAMPLE';

function runHook(hookPath, payload) {
  const env = { ...process.env };
  delete env.ALLOW_AGENT_CONFIG_WRITE; // ensure the config gate is in its blocking state
  const r = spawnSync('node', [hookPath], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env,
  });
  return r.status;
}

describe('C1: file-content-secret-guard covers all write-tool shapes', () => {
  it('blocks an embedded secret delivered via MultiEdit', () => {
    expect(runHook(secretGuard, {
      tool_name: 'MultiEdit',
      tool_input: { file_path: '/tmp/x.js', edits: [{ old_string: 'a', new_string: `const k='${AWS_KEY}'` }] },
    })).toBe(2);
  });

  it('blocks an embedded secret delivered via NotebookEdit', () => {
    expect(runHook(secretGuard, {
      tool_name: 'NotebookEdit',
      tool_input: { notebook_path: '/tmp/x.ipynb', new_source: `k='${AWS_KEY}'` },
    })).toBe(2);
  });

  it('still blocks the classic Edit path (control)', () => {
    expect(runHook(secretGuard, {
      tool_name: 'Edit',
      tool_input: { file_path: '/tmp/x.js', new_string: `k='${AWS_KEY}'` },
    })).toBe(2);
  });

  it('passes a clean MultiEdit', () => {
    expect(runHook(secretGuard, {
      tool_name: 'MultiEdit',
      tool_input: { file_path: '/tmp/x.js', edits: [{ old_string: 'a', new_string: 'const safe = 1;' }] },
    })).toBe(0);
  });
});

describe('C1: agent-config-readonly covers all write-tool shapes', () => {
  it('blocks a .claude/ write delivered via MultiEdit', () => {
    expect(runHook(configGuard, {
      tool_name: 'MultiEdit',
      tool_input: { file_path: path.join(ROOT, '.claude', 'hooks', 'x.cjs'), edits: [] },
    })).toBe(2);
  });

  it('blocks a .claude/ write delivered via NotebookEdit (notebook_path field)', () => {
    expect(runHook(configGuard, {
      tool_name: 'NotebookEdit',
      tool_input: { notebook_path: path.join(ROOT, '.claude', 'x.ipynb'), new_source: 'x' },
    })).toBe(2);
  });

  it('passes a non-.claude MultiEdit', () => {
    expect(runHook(configGuard, {
      tool_name: 'MultiEdit',
      tool_input: { file_path: '/tmp/safe.cjs', edits: [] },
    })).toBe(0);
  });
});
