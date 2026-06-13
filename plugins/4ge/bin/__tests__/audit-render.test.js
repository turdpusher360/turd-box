import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '..', 'audit-render.cjs');
const EXAMPLE = path.resolve(__dirname, '..', 'examples', 'audit-render.example.json');

const require = createRequire(import.meta.url);
const { render, validate, statusOf } = require(BIN);

function run(input, ...args) {
  return spawnSync('node', [BIN, ...args], { input, encoding: 'utf8', timeout: 10000 });
}

const exampleJson = readFileSync(EXAMPLE, 'utf8');
const example = JSON.parse(exampleJson);

// Golden output — byte-for-byte the honest marketplace audit-dashboard shot
// content (S404 screenshot-truth pass), built from output-format.md
// Component 1 (Score Bar) + Component 2 (Category Row).
const GOLDEN = `/4ge:audit — implementation quality
  Scope: src/ (24 modules, 3,891 lines)

  Health: 93  A  [===================-]

  Security         19/20  A  PASS  [===================-]   1 findings
  Dependencies     18/20  A  PASS  [==================--]   1 findings
  Dead Code        20/20  A  PASS  [====================]   0 findings
  Complexity       17/20  B  PASS  [=================---]   2 findings
  Test Coverage    18/20  A  PASS  [==================--]   1 findings
  Hook Hygiene     20/20  A  PASS  [====================]   0 findings
  Config           19/20  A  PASS  [===================-]   0 findings
  Documentation    17/20  B  PASS  [=================---]   1 findings

  6 findings total   0 P0   0 P1   3 P2   3 P3
  Grade A   Scan: 12s   Categories: 8/8 PASS
`;

describe('audit-render.cjs golden output', () => {
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

describe('audit-render.cjs derived fields (output-format.md formulas)', () => {
  it('status thresholds: PASS >= 80, WARN 50-79, FAIL < 50', () => {
    expect(statusOf(80)).toBe('PASS');
    expect(statusOf(79)).toBe('WARN');
    expect(statusOf(50)).toBe('WARN');
    expect(statusOf(49)).toBe('FAIL');
    expect(statusOf(0)).toBe('FAIL');
  });

  it('category grade/status/bar derive from score (golden mockup 06/20 case)', () => {
    const out = render({
      ...example,
      categories: [{ name: 'Security', score: 6, findings: 5 }],
    });
    // 6/20 = 30% -> grade F, FAIL, fill = round(30/100*20) = 6
    expect(out).toContain('  Security         06/20  F  FAIL  [======--------------]   5 findings');
    expect(out).toContain('Categories: 0/1 PASS');
  });

  it('findings total derives from severity buckets', () => {
    const out = render({ ...example, severity: { p0: 1, p1: 1, p2: 2, p3: 3 } });
    expect(out).toContain('  7 findings total   1 P0   1 P1   2 P2   3 P3');
  });

  it('healthDelta renders as (+N)/(-N) and is omitted when absent', () => {
    expect(render({ ...example, healthDelta: 8 })).toContain('  Health: 93  A  [===================-]  (+8)');
    expect(render({ ...example, healthDelta: -3 })).toContain('  Health: 93  A  [===================-]  (-3)');
    expect(render(example)).toContain('  Health: 93  A  [===================-]\n');
  });
});

describe('audit-render.cjs width discipline', () => {
  it('every golden line is <= 79 chars', () => {
    for (const line of GOLDEN.split('\n')) expect(line.length).toBeLessThanOrEqual(79);
  });

  it('truncates oversized free text so no line exceeds 79 chars', () => {
    const long = 'z'.repeat(200);
    const input = JSON.stringify({
      title: long,
      scope: { path: long, modules: 1234567, lines: 987654321 },
      health: 42,
      categories: [{ name: 'Fifteen-chars-x', score: 9, findings: 12 }],
      severity: { p0: 4, p1: 4, p2: 2, p3: 2 },
      scanSeconds: 9999,
    });
    const result = run(input, '--mode=plain');
    expect(result.status).toBe(0);
    for (const line of result.stdout.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(79);
    }
  });
});

describe('audit-render.cjs schema validation', () => {
  it('--schema prints parseable JSON schema and exits 0', () => {
    const result = run('', '--schema');
    expect(result.status).toBe(0);
    const schema = JSON.parse(result.stdout);
    expect(schema.title).toBe('audit-render input');
    expect(schema.required).toContain('categories');
  });

  it('rejects empty stdin and malformed JSON with exit 1', () => {
    expect(run('').status).toBe(1);
    expect(run('nope').status).toBe(1);
  });

  it('rejects missing required fields with named errors', () => {
    const result = run('{}');
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/title must be a non-empty string/);
    expect(result.stderr).toMatch(/scope is required/);
    expect(result.stderr).toMatch(/health must be an integer 0-100/);
    expect(result.stderr).toMatch(/categories must be an array/);
    expect(result.stderr).toMatch(/severity is required/);
  });

  it('rejects category name over 15 chars (Component 2 field width) and score over 20', () => {
    const errors = validate({
      title: 't',
      scope: { path: 'src/', modules: 1, lines: 1 },
      health: 90,
      categories: [{ name: 'Sixteen-chars-xx', score: 21, findings: 0 }],
      severity: { p0: 0, p1: 0, p2: 0, p3: 0 },
      scanSeconds: 1,
    });
    expect(errors.some((e) => e.includes('exceeds 15 chars'))).toBe(true);
    expect(errors.some((e) => e.includes('score must be an integer 0-20'))).toBe(true);
  });

  it('rejects unknown mode with exit 1', () => {
    const result = run(exampleJson, '--mode=neon');
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/unknown mode/);
  });
});
