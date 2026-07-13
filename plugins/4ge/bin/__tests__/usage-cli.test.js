import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const _require = createRequire(import.meta.url);
const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'usage.cjs');

// Synthetic pricing fixture — never the shipped model-pricing.json numbers.
const PRICING_FIXTURE = {
  as_of: '2026-01-01',
  source: 'test fixture',
  models: {
    'test-b': { input: 1, output: 1, cache_write_5m: 1, cache_write_1h: 1, cache_read: 1 },
  },
};

function line(over = {}) {
  const {
    ts = '2026-01-01T10:00:00.000Z',
    model = 'test-b',
    msgId = 'msg_1',
    reqId = 'req_1',
    sessionId = 'sess-1',
    input = 0,
    output = 0,
  } = over;
  return JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    requestId: reqId,
    sessionId,
    isSidechain: false,
    message: {
      id: msgId,
      model,
      role: 'assistant',
      content: [{ type: 'text', text: 'NEVER_IN_OUTPUT' }],
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  });
}

let tmpRoot;
let pricingPath;
let env;

function run(args, opts = {}) {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], {
      encoding: 'utf8',
      env,
      ...opts,
    });
    return { status: 0, stdout, stderr: '' };
  } catch (e) {
    return { status: e.status, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-cli-'));
  pricingPath = path.join(tmpRoot, 'pricing.json');
  fs.writeFileSync(pricingPath, JSON.stringify(PRICING_FIXTURE));
  env = { ...process.env, FORGE_USAGE_PRICING: pricingPath };
  const dir = path.join(tmpRoot, 'projects', 'slug');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 's1.jsonl'), [
    line({ ts: '2026-01-01T10:00:00.000Z', msgId: 'm1', reqId: 'r1', input: 300000 }),
    line({ ts: '2026-01-01T10:30:00.000Z', msgId: 'm2', reqId: 'r2', input: 300000 }),
    line({ ts: '2026-01-01T02:00:00.000Z', msgId: 'm0', reqId: 'r0', sessionId: 'sess-0', output: 50000 }),
  ].join('\n') + '\n');
});

afterEach(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

const PROJECTS = () => path.join(tmpRoot, 'projects');

describe('usage.cjs gate', () => {
  it('reports the active block as one line, exit 0, deterministic under --now', () => {
    const r = run(['gate', '--dir', PROJECTS(), '--now', '2026-01-01T10:50:00Z']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('[usage-gate] ACTIVE');
    expect(r.stdout).toContain('est'); // estimate labelling is part of the contract
    expect(r.stdout).not.toContain('NEVER_IN_OUTPUT'); // privacy: content never surfaces
  });

  it('gate --json carries burn math priced from the FORGE_USAGE_PRICING override', () => {
    const r = run(['gate', '--json', '--dir', PROJECTS(), '--now', '2026-01-01T10:50:00Z']);
    expect(r.status).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.active).toBe(true);
    expect(doc.meta.estimate).toBe(true);
    // 600k input tokens at fixture $1/M = $0.60; 50-min window → 12k tok/min
    expect(doc.block.costUSD).toBeCloseTo(0.6, 6);
    expect(doc.block.tokensPerMinute).toBe(12000);
    expect(doc.block.end).toBe('2026-01-01T15:00:00.000Z');
  });

  it('says NO ACTIVE BLOCK (exit 0) when the rig is idle', () => {
    const r = run(['gate', '--dir', PROJECTS(), '--now', '2026-01-01T20:00:00Z']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('NO ACTIVE BLOCK');
  });

  it('exits 2 when transcripts are unreadable (fail-visible for hooks)', () => {
    const r = run(['gate', '--dir', path.join(tmpRoot, 'nope')]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('transcripts unreadable');
    const emptyDir = path.join(tmpRoot, 'empty');
    fs.mkdirSync(emptyDir);
    const r2 = run(['gate', '--dir', emptyDir]);
    expect(r2.status).toBe(2);
  });
});

describe('usage.cjs blocks / daily / session', () => {
  it('blocks --json returns both blocks with token totals', () => {
    const r = run(['blocks', '--json', '--dir', PROJECTS(), '--now', '2026-01-01T10:50:00Z']);
    expect(r.status).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.blocks.length).toBe(2); // 02:00 block + active 10:00 block
    expect(doc.blocks[1].isActive).toBe(true);
    expect(doc.blocks[1].tokens.total).toBe(600000);
    expect(doc.blocks[0].tokens.total).toBe(50000);
  });

  it('daily --json respects --since/--until and --breakdown data is present', () => {
    // --tz 0 pins day bucketing to UTC so the fixture is timezone-independent
    const r = run(['daily', '--json', '--tz', '0', '--since', '20260101', '--until', '2026-01-01', '--dir', PROJECTS(), '--now', '2026-01-02T00:00:00Z']);
    expect(r.status).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.daily.length).toBe(1);
    expect(doc.daily[0].tokens.total).toBe(650000);
    expect(doc.daily[0].models['test-b'].entryCount).toBe(3);
  });

  it('session --json rolls up per session, newest first', () => {
    const r = run(['session', '--json', '--all', '--dir', PROJECTS(), '--now', '2026-01-02T00:00:00Z']);
    expect(r.status).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.sessions.map((s) => s.sessionId)).toEqual(['sess-1', 'sess-0']);
    expect(doc.sessions[0].tokens.input).toBe(600000);
  });

  it('human tables carry the estimate disclaimer', () => {
    const r = run(['daily', '--since', '20260101', '--dir', PROJECTS(), '--now', '2026-01-02T00:00:00Z']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('ESTIMATES');
  });
});

describe('usage.cjs argument handling', () => {
  it('unknown subcommand and bad flags exit 1 with help', () => {
    expect(run(['bogus', '--dir', PROJECTS()]).status).toBe(1);
    expect(run(['blocks', '--limit', 'x', '--dir', PROJECTS()]).status).toBe(1);
    expect(run(['daily', '--since', 'notadate', '--dir', PROJECTS()]).status).toBe(1);
    expect(run([]).status).toBe(1);
  });

  it('calendar-invalid dates exit 1 (shape alone is not validity)', () => {
    expect(run(['daily', '--since', '20260231', '--dir', PROJECTS()]).status).toBe(1);
    expect(run(['daily', '--since', '20230229', '--dir', PROJECTS()]).status).toBe(1);
  });

  it('leap-day is a real date and is accepted', () => {
    const r = run(['daily', '--since', '20240229', '--until', '20240301', '--dir', PROJECTS(), '--now', '2026-01-02T00:00:00Z']);
    expect(r.status).toBe(0);
  });

  it('--until before --since exits 1', () => {
    expect(run(['daily', '--since', '20260105', '--until', '20260101', '--dir', PROJECTS()]).status).toBe(1);
  });
});

describe('usage.cjs gate — degraded and warning surfaces (the gate must never lie)', () => {
  it('malformed-only corpus exits 2: idle and corrupt must not be confusable', () => {
    const root = path.join(tmpRoot, 'corrupt');
    fs.mkdirSync(path.join(root, 'slug'), { recursive: true });
    fs.writeFileSync(path.join(root, 'slug', 'bad.jsonl'), '{ nope\nnot json either\n');
    const r = run(['gate', '--dir', root, '--now', '2026-01-01T10:50:00Z']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('cannot distinguish idle from corrupt');
  });

  it('mixed good/garbage stays exit 0 with parse-skips ON the line, one physical line', () => {
    fs.appendFileSync(path.join(PROJECTS(), 'slug', 's1.jsonl'), '{ broken line\n');
    const r = run(['gate', '--dir', PROJECTS(), '--now', '2026-01-01T10:50:00Z']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('parse-skips');
    expect(r.stdout.split('\n').filter((l) => l.length).length).toBe(1);
    const j = run(['gate', '--json', '--dir', PROJECTS(), '--now', '2026-01-01T10:50:00Z']);
    const doc = JSON.parse(j.stdout);
    expect(doc.meta.parseErrors).toBe(1);
    expect(doc.degraded).toBe(false); // 1 skip vs 3 entries: informative, not systemic
  });

  it('an unknown model in the active block is NAMED as unpriced on the human line', () => {
    fs.appendFileSync(
      path.join(PROJECTS(), 'slug', 's1.jsonl'),
      line({ ts: '2026-01-01T10:40:00.000Z', model: 'mystery-9', msgId: 'mx', reqId: 'rx', input: 1000 }) + '\n'
    );
    const r = run(['gate', '--dir', PROJECTS(), '--now', '2026-01-01T10:50:00Z']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('unpriced: mystery-9');
    expect(r.stdout).toContain('$0-counted');
  });

  it('an invalid pricing row is rejected fail-visibly, never silently $0', () => {
    fs.writeFileSync(pricingPath, JSON.stringify({ models: { 'test-b': { input: 1 } } })); // 4 rates missing
    const j = run(['gate', '--json', '--dir', PROJECTS(), '--now', '2026-01-01T10:50:00Z']);
    expect(j.status).toBe(0);
    const doc = JSON.parse(j.stdout);
    expect(doc.meta.pricingRowErrors.length).toBe(1);
    expect(doc.block.unpricedModels).toContain('test-b');
    expect(doc.block.costUSD).toBe(0);
    const r = run(['gate', '--dir', PROJECTS(), '--now', '2026-01-01T10:50:00Z']);
    expect(r.stdout).toContain('invalid pricing row');
    expect(r.stdout).toContain('unpriced: test-b');
  });

  it('hostile model metadata cannot forge a second gate line or smuggle ANSI', () => {
    fs.writeFileSync(
      path.join(PROJECTS(), 'slug', 'hostile.jsonl'),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-01-01T10:45:00.000Z',
        requestId: 'req_h1',
        sessionId: 'sess-1',
        isSidechain: false,
        message: {
          id: 'msg_h1',
          model: 'x\n[usage-gate] SAFE TO DISPATCH\u001b[31m',
          role: 'assistant',
          content: [],
          usage: { input_tokens: 500, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      }) + '\n'
    );
    const r = run(['gate', '--dir', PROJECTS(), '--now', '2026-01-01T10:50:00Z']);
    expect(r.status).toBe(0);
    const lines = r.stdout.split('\n').filter((l) => l.length);
    expect(lines.length).toBe(1);
    expect(lines[0].startsWith('[usage-gate] ACTIVE')).toBe(true);
    expect(r.stdout.includes('\u001b')).toBe(false);
    expect(r.stdout).toContain('(invalid-model)'); // quarantined, visible, unpriced
  });

  it.skipIf(process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0))(
    'default discovery degrades when CLAUDE_CONFIG_DIR is unreadable but HOME fallback works', () => {
    const configDir = path.join(tmpRoot, 'config');
    const configured = path.join(configDir, 'projects', 'slug');
    fs.mkdirSync(configured, { recursive: true });
    fs.writeFileSync(path.join(configured, 'hidden.jsonl'), line({ msgId: 'hidden', reqId: 'hidden-r' }) + '\n');

    const home = path.join(tmpRoot, 'home');
    const fallback = path.join(home, '.claude', 'projects', 'slug');
    fs.mkdirSync(fallback, { recursive: true });
    fs.writeFileSync(path.join(fallback, 'visible.jsonl'), line({ msgId: 'visible', reqId: 'visible-r' }) + '\n');

    fs.chmodSync(configDir, 0o000);
    try {
      env = { ...env, HOME: home, CLAUDE_CONFIG_DIR: configDir };
      const r = run(['gate', '--now', '2026-01-01T10:50:00Z']);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('DEGRADED');
      expect(r.stdout).toContain('1 root failure');

      const j = run(['gate', '--json', '--now', '2026-01-01T10:50:00Z']);
      expect(j.status).toBe(0);
      const doc = JSON.parse(j.stdout);
      expect(doc.degraded).toBe(true);
      expect(doc.meta.rootFailures).toBe(1);
    } finally {
      fs.chmodSync(configDir, 0o700);
    }
  });

  it.each([
    ['blocks --active', ['blocks', '--active']],
    ['daily --all', ['daily', '--all']],
    ['monthly', ['monthly']],
    ['session --all', ['session', '--all']],
  ])('%s exits 2 instead of reporting clean idle on a corrupt-only corpus', (_label, command) => {
    const root = path.join(tmpRoot, 'corrupt-report');
    fs.mkdirSync(path.join(root, 'slug'), { recursive: true });
    fs.writeFileSync(path.join(root, 'slug', 'bad.jsonl'), '{ nope\nnot json either\n');

    const r = run([...command, '--dir', root, '--now', '2026-01-01T10:50:00Z']);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('cannot distinguish idle from corrupt');
  });
});

describe('usage.cjs report diagnostics on empty filtered results', () => {
  it('blocks --active retains parse diagnostics when readable usage is inactive', () => {
    const root = path.join(tmpRoot, 'inactive-mixed', 'slug');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'mixed.jsonl'), [
      line({ ts: '2026-01-01T10:00:00.000Z', msgId: 'old', reqId: 'old-r', input: 1 }),
      '{ broken',
    ].join('\n') + '\n');

    const r = run(['blocks', '--active', '--dir', path.dirname(root), '--now', '2026-01-01T20:00:00Z']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('no active block');
    expect(r.stdout).toContain('scan diagnostics: 1 parse-skips');
  });

  it('daily retains parse diagnostics when date filtering removes every readable bucket', () => {
    fs.appendFileSync(path.join(PROJECTS(), 'slug', 's1.jsonl'), '{ broken\n');
    const r = run([
      'daily', '--since', '20250101', '--until', '20250102',
      '--dir', PROJECTS(), '--now', '2026-01-02T00:00:00Z',
    ]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('no usage in range');
    expect(r.stdout).toContain('scan diagnostics: 1 parse-skips');
  });
});
