/**
 * S373 regression: cross-CLI shell-guards must FAIL CLOSED on malformed input.
 *
 * Before the fix, .codex and .gemini shell-guards (and guard-dns-exfil)
 * fail-OPENed (allowed the command) on parse error / stdin error / timeout —
 * an attacker who could make the hook error bypassed it entirely. They must
 * deny on uncertainty, matching pre-bash-guards.cjs. Note the two CLIs use
 * different protocols: Codex blocks via PreToolUse deny JSON; Gemini uses a JSON
 * { decision: "deny" } payload on exit 0.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..'); // repository root
const codexGuard = path.join(ROOT, '.codex', 'hooks', 'shell-guard.cjs');
const geminiGuard = path.join(ROOT, '.gemini', 'hooks', 'shell-guard.cjs');

function run(hookPath, input) {
  return spawnSync('node', [hookPath], { input, encoding: 'utf8' });
}

const BENIGN = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls -la' } });
const DANGER = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'chmod 777 /tmp/x' } });

function expectCodexDenied(result) {
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout).hookSpecificOutput).toMatchObject({
    hookEventName: 'PreToolUse', permissionDecision: 'deny',
  });
}

describe('Codex shell-guard fail-closed (explicit deny JSON)', () => {
  it('fails closed on malformed JSON', () => {
    expectCodexDenied(run(codexGuard, 'not valid json'));
  });
  it('allows a benign command (exit 0)', () => {
    expect(run(codexGuard, BENIGN).status).toBe(0);
  });
  it('blocks a dangerous command', () => {
    expectCodexDenied(run(codexGuard, DANGER));
  });
});

describe('Gemini shell-guard fail-closed (JSON decision + exit 0)', () => {
  it('fails closed (decision: deny) on malformed JSON', () => {
    const r = run(geminiGuard, 'not valid json');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('"decision":"deny"');
  });
  it('allows a benign command', () => {
    expect(run(geminiGuard, BENIGN).stdout).toContain('"decision":"allow"');
  });
  it('blocks a dangerous command', () => {
    expect(run(geminiGuard, DANGER).stdout).toContain('"decision":"deny"');
  });
});
