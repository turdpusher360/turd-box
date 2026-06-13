import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '..', 'dfe-verdict.cjs');
const EXAMPLE = path.resolve(__dirname, '..', 'examples', 'dfe-verdict.example.json');

const require = createRequire(import.meta.url);
const { render, validate, gradeOf, barOf } = require(BIN);

function run(input, ...args) {
  return spawnSync('node', [BIN, ...args], { input, encoding: 'utf8', timeout: 10000 });
}

const exampleJson = readFileSync(EXAMPLE, 'utf8');
const example = JSON.parse(exampleJson);

// Golden output — byte-for-byte the honest marketplace dfe-review shot content
// (S404 screenshot-truth pass), built from the /dfe command's output contract
// (output-format.md Components 8, 3, 1).
const GOLDEN = `/dfe — 6-pass adversarial review
  Target: src/api/ (8 files, 1,247 lines)

  Scanning [5/5] dfe-pass5 complete ...

  Pass 1  existence    PASS   imports resolve, packages verified     0
  Pass 2  security     WARN   unvalidated input at routes.ts:42      1
  Pass 3  logic        PASS   no race conditions, bounds checked     0
  Pass 4  runtime      PASS   await verified, env matches            0
  Pass 5  trust        WARN   type assertion hides error at db:89    1
  Pass 6  artifacts    PASS   no dead exports, no orphaned vars      0

  VERDICT: 2 findings (0 P0, 0 P1, 1 P2, 1 P3)
  Confidence: 91  A  [==================--]   Passes: 4/6 clean

  Reports: _runs/review/dfe-adversarial-2026-06-10.md
`;

describe('dfe-verdict.cjs golden output', () => {
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

describe('dfe-verdict.cjs derived fields (output-format.md formulas)', () => {
  it('grade thresholds: A=90, B=75, C=55, D=35, F below', () => {
    expect(gradeOf(100)).toBe('A');
    expect(gradeOf(90)).toBe('A');
    expect(gradeOf(89)).toBe('B');
    expect(gradeOf(75)).toBe('B');
    expect(gradeOf(74)).toBe('C');
    expect(gradeOf(55)).toBe('C');
    expect(gradeOf(54)).toBe('D');
    expect(gradeOf(35)).toBe('D');
    expect(gradeOf(34)).toBe('F');
    expect(gradeOf(0)).toBe('F');
  });

  it('bar is always 20 chars, fill = round(pct/100*20)', () => {
    expect(barOf(91)).toBe('==================--');
    expect(barOf(100)).toBe('====================');
    expect(barOf(0)).toBe('--------------------');
    for (const pct of [0, 1, 33, 50, 67, 91, 100]) expect(barOf(pct)).toHaveLength(20);
  });

  it('passes-clean count and findings total are derived, not input', () => {
    const out = render({ ...example, severity: { p0: 1, p1: 2, p2: 3, p3: 4 } });
    expect(out).toContain('VERDICT: 10 findings (1 P0, 2 P1, 3 P2, 4 P3)');
    expect(out).toContain('Passes: 4/6 clean');
  });
});

describe('dfe-verdict.cjs width discipline', () => {
  it('every golden line is <= 79 chars', () => {
    for (const line of GOLDEN.split('\n')) expect(line.length).toBeLessThanOrEqual(79);
  });

  it('truncates oversized free text so no line exceeds 79 chars', () => {
    const long = 'y'.repeat(200);
    const input = JSON.stringify({
      target: { path: long, files: 1234567, lines: 89012345 },
      scan: { current: 1, total: 5, label: long },
      passes: [{ num: 1, name: long, status: 'FAIL', detail: long, findings: 3 }],
      severity: { p0: 3, p1: 0, p2: 0, p3: 0 },
      confidence: 12,
      reportPath: long,
    });
    const result = run(input, '--mode=plain');
    expect(result.status).toBe(0);
    for (const line of result.stdout.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(79);
    }
  });
});

describe('dfe-verdict.cjs schema validation', () => {
  it('--schema prints parseable JSON schema and exits 0', () => {
    const result = run('', '--schema');
    expect(result.status).toBe(0);
    const schema = JSON.parse(result.stdout);
    expect(schema.title).toBe('dfe-verdict input');
    expect(schema.required).toContain('passes');
  });

  it('rejects empty stdin and malformed JSON with exit 1', () => {
    expect(run('').status).toBe(1);
    expect(run('[1,2').status).toBe(1);
  });

  it('rejects missing required fields with named errors', () => {
    const result = run('{}');
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/target is required/);
    expect(result.stderr).toMatch(/passes must be an array/);
    expect(result.stderr).toMatch(/severity is required/);
    expect(result.stderr).toMatch(/confidence must be an integer 0-100/);
    expect(result.stderr).toMatch(/reportPath must be a non-empty string/);
  });

  it('rejects bad pass status enum and out-of-range confidence', () => {
    const errors = validate({
      target: { path: 'src/', files: 1, lines: 1 },
      passes: [{ num: 1, name: 'existence', status: 'OK', detail: 'd', findings: 0 }],
      severity: { p0: 0, p1: 0, p2: 0, p3: 0 },
      confidence: 101,
      reportPath: 'r.md',
    });
    expect(errors.some((e) => e.includes('passes[0].status'))).toBe(true);
    expect(errors).toContain('confidence must be an integer 0-100');
  });

  it('rejects unknown mode with exit 1', () => {
    const result = run(exampleJson, '--mode=neon');
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/unknown mode/);
  });
});
