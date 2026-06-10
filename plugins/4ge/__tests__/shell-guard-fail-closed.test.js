/**
 * S373 regression: cross-CLI shell-guards must FAIL CLOSED on malformed input.
 *
 * Before the fix, .codex and .gemini shell-guards (and guard-dns-exfil)
 * fail-OPENed (allowed the command) on parse error / stdin error / timeout —
 * an attacker who could make the hook error bypassed it entirely. They must
 * deny on uncertainty, matching pre-bash-guards.cjs. Note the two CLIs use
 * different protocols: Codex blocks via exit 2; Gemini blocks via a JSON
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

describe('Codex shell-guard fail-closed (exit 2 = block)', () => {
  it('fails closed (exit 2) on malformed JSON', () => {
    expect(run(codexGuard, 'not valid json').status).toBe(2);
  });
  it('allows a benign command (exit 0)', () => {
    expect(run(codexGuard, BENIGN).status).toBe(0);
  });
  it('blocks a dangerous command (exit 2)', () => {
    expect(run(codexGuard, DANGER).status).toBe(2);
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
