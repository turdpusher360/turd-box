import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '..', 'forge-status.cjs');
const EXAMPLE = path.resolve(__dirname, '..', 'examples', 'forge-status.example.json');

const require = createRequire(import.meta.url);
const { render, validate } = require(BIN);

function run(input, ...args) {
  return spawnSync('node', [BIN, ...args], { input, encoding: 'utf8', timeout: 10000 });
}

const exampleJson = readFileSync(EXAMPLE, 'utf8');

// Golden output — byte-for-byte the honest marketplace forge-session shot
// content (S404 screenshot-truth pass), itself verbatim from the
// output-format.md Component 5 + 10 golden mockups.
const GOLDEN = `/forge — Phase 5: Execute
  Task: Wire bidirectional IPC between the scheduler and worker pool

  Teammates
  impl-expert       P5:execute   lib/os/scheduler/     [4/6] applied
  sonnet-execute    P5:verify    lib/os/scheduler/     tsc PASS
  security-rev      idle         --                    --

  Applying [4/6] Add keep-alive to HTTP server .......... applied
  Applying [5/6] Wire PostToolUse hook .................. running
  Applying [6/6] SQLite event log schema ................ pending

  Decisions: 3 logged   Constraints: 1 logged
  Phase 4 done   Phase 5 [4/6]   Phase 6 pending
`;

describe('forge-status.cjs golden output', () => {
  it('renders the canonical example byte-identical to the golden snapshot (plain mode)', () => {
    const result = run(exampleJson, '--mode=plain');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(GOLDEN);
  });

  it('is deterministic: two runs produce byte-identical output', () => {
    const a = run(exampleJson, '--mode=plain');
    const b = run(exampleJson, '--mode=plain');
    expect(a.stdout).toBe(b.stdout);
  });

  it('ansi mode (default) is byte-identical to plain mode — the contract is ANSI-free', () => {
    const ansi = run(exampleJson);
    const plain = run(exampleJson, '--mode=plain');
    expect(ansi.stdout).toBe(plain.stdout);
    // eslint-disable-next-line no-control-regex
    expect(ansi.stdout).not.toMatch(/\x1b\[/);
  });
});

describe('forge-status.cjs width discipline', () => {
  it('every golden line is <= 79 chars', () => {
    for (const line of GOLDEN.split('\n')) expect(line.length).toBeLessThanOrEqual(79);
  });

  it('truncates oversized free text so no line exceeds 79 chars', () => {
    const long = 'x'.repeat(200);
    const input = JSON.stringify({
      phase: { number: 5, name: long },
      task: long,
      teammates: [{ name: long, phase: long, scope: long, status: long }],
      steps: [{ current: 1, total: 2, description: long, status: 'running' }],
      decisions: 1,
      constraints: 0,
      phases: [{ label: long, status: long }],
    });
    const result = run(input, '--mode=plain');
    expect(result.status).toBe(0);
    for (const line of result.stdout.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(79);
    }
  });
});

describe('forge-status.cjs schema validation', () => {
  it('--schema prints parseable JSON schema and exits 0', () => {
    const result = run('', '--schema');
    expect(result.status).toBe(0);
    const schema = JSON.parse(result.stdout);
    expect(schema.title).toBe('forge-status input');
    expect(schema.required).toContain('phase');
  });

  it('rejects empty stdin with exit 1', () => {
    const result = run('');
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/expected a JSON state document/);
  });

  it('rejects malformed JSON with exit 1', () => {
    const result = run('{not json');
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/invalid JSON/);
  });

  it('rejects missing required fields with exit 1 and named errors', () => {
    const result = run('{}');
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/phase is required/);
    expect(result.stderr).toMatch(/task must be a non-empty string/);
    expect(result.stderr).toMatch(/teammates must be an array/);
  });

  it('rejects out-of-range phase number and bad teammate rows', () => {
    const errors = validate({
      phase: { number: 9, name: 'Bogus' },
      task: 't',
      teammates: [{ name: 'a', phase: 'b', scope: 'c', status: 42 }],
    });
    expect(errors).toContain('phase.number must be an integer 1-7');
    expect(errors.some((e) => e.includes('teammates[0].status'))).toBe(true);
  });

  it('rejects unknown mode with exit 1', () => {
    const result = run(exampleJson, '--mode=neon');
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/unknown mode/);
  });
});

describe('forge-status.cjs render edge cases', () => {
  it('renders "(no active teammates)" for an empty teammates array', () => {
    const out = render({ phase: { number: 1, name: 'Scope' }, task: 't', teammates: [] });
    expect(out).toContain('  (no active teammates)');
  });

  it('omits steps and footer sections when absent', () => {
    const out = render({ phase: { number: 1, name: 'Scope' }, task: 't', teammates: [] });
    expect(out).not.toContain('Applying');
    expect(out).not.toContain('Decisions:');
  });
});
