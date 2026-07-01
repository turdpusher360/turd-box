import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const hookPath = path.join(ROOT, '.gemini', 'hooks', 'session-start.cjs');

function runSessionStart(input) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-session-start-'));
  const result = spawnSync('node', [hookPath], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: {
      ...process.env,
      GEMINI_PROJECT_DIR: tmpRoot,
    },
  });
  return { result, tmpRoot };
}

describe('Gemini SessionStart parity context', () => {
  it('injects the same startup proof boundaries Codex and Claude use', () => {
    const { result, tmpRoot } = runSessionStart({
      session_id: 'gemini-session-test',
      timestamp: '2026-06-23T16:30:00.000Z',
      cwd: '/path/to/project',
    });

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    const context = payload.hookSpecificOutput.additionalContext;

    expect(context).toContain('Latest handoff is a claim, not truth');
    expect(context).toContain('TASKING.md');
    expect(context).toContain('_runs/.decisions.jsonl');
    expect(context).toContain('_runs/.constraints.jsonl');
    expect(context).toContain('Run: git status --short');
    expect(context).toContain('Search dev-memory MCP before implementing anything');
    expect(context).toContain('_runs/os/boot-status.json');
    expect(context).toContain('Do not create a new _runs/HANDOFF-S*.md');
    expect(context).toContain('_runs/gemini-costs.jsonl');
    expect(context).toContain('Do not hardcode gemini-3.5-pro');

    const logPath = path.join(tmpRoot, '_runs', 'gemini-sessions.jsonl');
    expect(fs.readFileSync(logPath, 'utf8')).toContain('gemini-session-test');
  });
});
