import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const _require = createRequire(import.meta.url);
const meter = _require('../usage-meter.cjs');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(HERE, 'fixtures', 'usage-meter-advisor');
const FIXTURE_FILE = path.join(FIXTURE_DIR, 'sample-advisor-records.jsonl');
const M = 1e6;

// Real assistant records from a session with advisor calls (cut to
// {type, uuid, timestamp, message:{id, model, usage}}). All four repeat the
// same message.id: one API response split over several transcript records.
function fixtureLines() {
  return fs.readFileSync(FIXTURE_FILE, 'utf8').split('\n').filter(Boolean);
}
function fixtureRecord() {
  return JSON.parse(fixtureLines()[0]);
}

// Synthetic, deliberately distinct rates so a wrong-model price is detectable.
const PRICING = {
  models: {
    'claude-opus-5-5': { input: 3, output: 7, cache_write_5m: 11, cache_write_1h: 13, cache_read: 0.5 },
    'claude-fable-5-1': { input: 17, output: 19, cache_write_5m: 23, cache_write_1h: 29, cache_read: 0.7 },
  },
};

function sumBy(list, pick) {
  return list.reduce((s, it) => s + pick(it), 0);
}

let tmpRoot;
beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-meter-advisor-'));
});
afterEach(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function writeTranscript(rel, lines) {
  const p = path.join(tmpRoot, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

/** Fixture record with extra advisor iterations appended (deep copy). */
function withAdvisors(extra) {
  const raw = fixtureRecord();
  for (const a of extra) {
    raw.message.usage.iterations.push({
      input_tokens: a.input,
      output_tokens: a.output,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      type: 'advisor_message',
      model: a.model || 'claude-fable-5-1',
    });
  }
  return raw;
}

describe('fixture shape (guards the assumptions the fixes rest on)', () => {
  it('top-level usage equals the sum of the message iterations only', () => {
    const u = fixtureRecord().message.usage;
    const msgIters = u.iterations.filter((i) => i.type === 'message');
    expect(u.iterations.some((i) => i.type === 'advisor_message')).toBe(true);
    expect(u.input_tokens).toBe(sumBy(msgIters, (i) => i.input_tokens));
    expect(u.output_tokens).toBe(sumBy(msgIters, (i) => i.output_tokens));
    expect(u.cache_read_input_tokens).toBe(sumBy(msgIters, (i) => i.cache_read_input_tokens));
    expect(u.cache_creation_input_tokens).toBe(sumBy(msgIters, (i) => i.cache_creation_input_tokens));
  });
});

describe('extractEntries: advisor iterations (bug 2)', () => {
  it('emits the unchanged top-level entry plus one advisor entry priced at the iteration model', () => {
    const raw = fixtureRecord();
    const u = raw.message.usage;
    const adv = u.iterations.find((i) => i.type === 'advisor_message');
    const entries = meter.extractEntries(raw);
    expect(entries.length).toBe(2);

    const [main, advisor] = entries;
    expect(main.model).toBe(raw.message.model);
    expect(main.input).toBe(u.input_tokens);
    expect(main.output).toBe(u.output_tokens);
    expect(main.cacheCreate).toBe(u.cache_creation_input_tokens);
    expect(main.cacheRead).toBe(u.cache_read_input_tokens);
    expect(main.advisor).toBeUndefined();

    expect(advisor.model).toBe(adv.model);
    expect(advisor.input).toBe(adv.input_tokens);
    expect(advisor.output).toBe(adv.output_tokens);
    expect(advisor.cacheRead).toBe(0);
    expect(advisor.cacheCreate).toBe(0);
    expect(advisor.advisor).toBe(true);
    expect(advisor.ts).toBe(main.ts);
    expect(advisor.messageId).toBe(main.messageId);
  });

  it('prices the advisor entry at its own model row, not the parent model row', () => {
    const raw = fixtureRecord();
    const adv = raw.message.usage.iterations.find((i) => i.type === 'advisor_message');
    const advisor = meter.extractEntries(raw)[1];
    const { costUSD, unpriced } = meter.entryCostUSD(advisor, PRICING);
    const f = PRICING.models['claude-fable-5-1'];
    const o = PRICING.models['claude-opus-5-5'];
    expect(unpriced).toBe(false);
    expect(costUSD).toBeCloseTo((adv.input_tokens * f.input + adv.output_tokens * f.output) / M, 10);
    expect(costUSD).not.toBeCloseTo((adv.input_tokens * o.input + adv.output_tokens * o.output) / M, 6);
  });

  it('a record with no advisor iteration yields exactly one entry', () => {
    const raw = fixtureRecord();
    raw.message.usage.iterations = raw.message.usage.iterations.filter((i) => i.type === 'message');
    expect(meter.extractEntries(raw).length).toBe(1);
  });

  it('emits one advisor entry per advisor iteration, each at its own model', () => {
    const raw = withAdvisors([{ input: 1000, output: 10, model: 'claude-opus-5-5' }]);
    const advisors = meter.extractEntries(raw).filter((e) => e.advisor);
    expect(advisors.map((e) => e.model)).toEqual(['claude-fable-5-1', 'claude-opus-5-5']);
  });

  it('keeps privacy: only usage numbers, model and ids leave the record', () => {
    const raw = fixtureRecord();
    raw.message.content = [{ type: 'text', text: 'SECRET_PAYLOAD_XYZ' }];
    raw.message.usage.iterations[1].note = 'SECRET_ITERATION_FIELD';
    const json = JSON.stringify(meter.extractEntries(raw));
    expect(json).not.toContain('SECRET_PAYLOAD_XYZ');
    expect(json).not.toContain('SECRET_ITERATION_FIELD');
  });

  it('quarantines a hostile or missing advisor model under the invalid-model sentinel', () => {
    const hostile = withAdvisors([{ input: 5, output: 5, model: 'evil\u001b[31m\nmodel' }]);
    const missing = withAdvisors([{ input: 6, output: 6 }]);
    delete missing.message.usage.iterations[missing.message.usage.iterations.length - 1].model;
    for (const raw of [hostile, missing]) {
      const last = meter.extractEntries(raw).filter((e) => e.advisor).pop();
      expect(last.model).toBe(meter.INVALID_MODEL);
      expect(meter.entryCostUSD(last, PRICING).unpriced).toBe(true);
      expect(last.input).toBeGreaterThan(0); // tokens stay visible
    }
  });

  it('returns nothing for a record extractEntry rejects', () => {
    const raw = fixtureRecord();
    raw.message.model = '<synthetic>';
    expect(meter.extractEntries(raw)).toEqual([]);
    expect(meter.extractEntries(null)).toEqual([]);
  });
});

describe('loadEntries: advisor dedupe (bug 2)', () => {
  it('does not count advisor cost more than once when the message.id repeats across records and files', async () => {
    const lines = fixtureLines();
    expect(lines.length).toBeGreaterThan(1);
    writeTranscript('slug/main.jsonl', lines);
    writeTranscript('slug/sess/subagents/agent-a.jsonl', lines); // same responses seen again
    const both = await meter.loadEntries({ dirs: [tmpRoot] });

    const single = path.join(tmpRoot, 'single');
    fs.mkdirSync(single);
    fs.writeFileSync(path.join(single, 's.jsonl'), lines[0] + '\n');
    const one = await meter.loadEntries({ dirs: [single] });

    const advOf = (res) => res.entries.filter((e) => e.advisor);
    expect(advOf(both).length).toBe(1);
    expect(both.entries.length).toBe(one.entries.length);

    const rollBoth = meter.rollup(both.entries, PRICING);
    const rollOne = meter.rollup(one.entries, PRICING);
    expect(rollBoth.models['claude-fable-5-1'].entryCount).toBe(1);
    expect(rollBoth.models['claude-fable-5-1'].costUSD)
      .toBeCloseTo(rollOne.models['claude-fable-5-1'].costUSD, 10);
    expect(rollBoth.costUSD).toBeCloseTo(rollOne.costUSD, 10);
  });

  it('keeps two advisor iterations of one response distinct through dedupe', async () => {
    const raw = withAdvisors([{ input: 2000, output: 20 }]);
    const l = JSON.stringify(raw);
    writeTranscript('slug/a.jsonl', [l, l]);
    const res = await meter.loadEntries({ dirs: [tmpRoot] });
    const advisors = res.entries.filter((e) => e.advisor);
    expect(advisors.length).toBe(2);
    expect(advisors.map((e) => e.input).sort((a, b) => a - b))
      .toEqual([2000, raw.message.usage.iterations[1].input_tokens].sort((a, b) => a - b));
  });

  it('an early streaming snapshot without iterations does not hide or duplicate the advisor', async () => {
    const final = fixtureRecord();
    const early = JSON.parse(JSON.stringify(final));
    delete early.message.usage.iterations;
    early.message.usage.output_tokens = 7;
    early.timestamp = '2026-09-29T23:09:19.000Z';
    writeTranscript('slug/a.jsonl', [JSON.stringify(early), JSON.stringify(final)]);
    const res = await meter.loadEntries({ dirs: [tmpRoot] });
    expect(res.entries.filter((e) => e.advisor).length).toBe(1);
    const main = res.entries.find((e) => !e.advisor);
    expect(main.output).toBe(final.message.usage.output_tokens);
  });
});

describe('shipped pricing: Fable 5.1 (bug 3)', () => {
  const shipped = meter.loadPricing({ env: {} });

  it('claude-fable-5-1 has its own row and no longer prefix-matches claude-fable-5', () => {
    expect(shipped.error).toBeNull();
    expect(shipped.models['claude-fable-5-1']).toBeTruthy();
    expect(meter.resolveModelPricing(shipped, 'claude-fable-5-1')).toBe(shipped.models['claude-fable-5-1']);
    expect(meter.resolveModelPricing(shipped, 'claude-fable-5-1')).not.toBe(shipped.models['claude-fable-5']);
    expect(meter.resolveModelPricing(shipped, 'claude-fable-5-1[1m]')).toBe(shipped.models['claude-fable-5-1']);
    expect(meter.resolveModelPricing(shipped, 'claude-fable-5')).toBe(shipped.models['claude-fable-5']);
  });

  // Literal rates on purpose: the packet fixes these two rows. They advance
  // only when the operator records a new Fable rate in model-pricing.json
  // (this test then fails with the old number in the message, so the fix is a
  // read of that row, not an investigation).
  it('prices Fable 5.1 cache reads at 0.25 and leaves the claude-fable-5 row unchanged', () => {
    const f51 = shipped.models['claude-fable-5-1'];
    expect(f51.input).toBe(10);
    expect(f51.output).toBe(50);
    expect(f51.cache_read).toBe(0.25);
    const f5 = shipped.models['claude-fable-5'];
    expect(f5).toMatchObject({
      input: 10, output: 50, cache_write_5m: 12.5, cache_write_1h: 20, cache_read: 1,
    });
  });

  it('Fable 5.1 cache writes follow the 1.25x / 2x input convention the other rows use', () => {
    const f51 = shipped.models['claude-fable-5-1'];
    expect(f51.cache_write_5m).toBeCloseTo(f51.input * 1.25, 10);
    expect(f51.cache_write_1h).toBeCloseTo(f51.input * 2, 10);
    expect(typeof f51.verified).toBe('boolean');
    expect(typeof f51.basis).toBe('string');
  });

  it('a Fable 5.1 cache read costs less than the same read on claude-fable-5', () => {
    const e = { model: 'claude-fable-5-1', input: 0, output: 0, cacheCreate: 0, cacheRead: M, cache5m: null, cache1h: null };
    const old = { ...e, model: 'claude-fable-5' };
    expect(meter.entryCostUSD(e, shipped).costUSD).toBeLessThan(meter.entryCostUSD(old, shipped).costUSD);
    expect(meter.entryCostUSD(e, shipped).unpriced).toBe(false);
  });
});

describe('cache-write split from iterations (bug 4)', () => {
  it('sums the message iterations: split totals the top-level creation, 5m carries the missing 3213', () => {
    const raw = fixtureRecord();
    const u = raw.message.usage;
    const e = meter.extractEntry(raw);
    expect(e.cache5m + e.cache1h).toBe(u.cache_creation_input_tokens);
    expect(e.cacheCreate).toBe(u.cache_creation_input_tokens);
    // Fixture facts (checked-in data, not a moving value): 10761 is 1h in
    // iteration 0, 3213 is 5m in iteration 2; the top-level split shows only iteration 0.
    expect(e.cache1h).toBe(10761);
    expect(e.cache5m).toBe(3213);
    expect(u.cache_creation.ephemeral_5m_input_tokens).toBe(0);
  });

  it('prices the derived split per tier (relationship from the fixture, injected rates)', () => {
    const raw = fixtureRecord();
    const u = raw.message.usage;
    const e = meter.extractEntry(raw);
    const p = PRICING.models['claude-opus-5-5'];
    const expected = (u.input_tokens * p.input + u.output_tokens * p.output
      + 3213 * p.cache_write_5m + 10761 * p.cache_write_1h
      + u.cache_read_input_tokens * p.cache_read) / M;
    expect(meter.entryCostUSD(e, PRICING).costUSD).toBeCloseTo(expected, 10);
  });

  it('excludes advisor iterations from the split', () => {
    const raw = fixtureRecord();
    raw.message.usage.iterations.find((i) => i.type === 'advisor_message').cache_creation = {
      ephemeral_5m_input_tokens: 999, ephemeral_1h_input_tokens: 888,
    };
    const e = meter.extractEntry(raw);
    expect(e.cache5m).toBe(3213);
    expect(e.cache1h).toBe(10761);
  });

  it('a message iteration without a split counts its creation tokens at the 5m tier', () => {
    const raw = fixtureRecord();
    const last = raw.message.usage.iterations[2];
    delete last.cache_creation;
    const e = meter.extractEntry(raw);
    expect(e.cache5m + e.cache1h).toBe(raw.message.usage.cache_creation_input_tokens);
    expect(e.cache5m).toBe(last.cache_creation_input_tokens);
  });

  it('falls back to the top-level split when no message iteration exists', () => {
    const raw = fixtureRecord();
    raw.message.usage.iterations = raw.message.usage.iterations.filter((i) => i.type === 'advisor_message');
    const e = meter.extractEntry(raw);
    expect(e.cache5m).toBe(raw.message.usage.cache_creation.ephemeral_5m_input_tokens);
    expect(e.cache1h).toBe(raw.message.usage.cache_creation.ephemeral_1h_input_tokens);
  });

  it('a single-iteration record keeps its top-level split', () => {
    const raw = fixtureRecord();
    raw.message.usage.iterations = [raw.message.usage.iterations[0]];
    raw.message.usage.cache_creation_input_tokens = 10761;
    const e = meter.extractEntry(raw);
    expect(e.cache5m).toBe(0);
    expect(e.cache1h).toBe(10761);
  });
});

describe('records without iterations price exactly as before', () => {
  function plain() {
    return {
      type: 'assistant',
      timestamp: '2026-01-01T10:00:00.000Z',
      requestId: 'req_1',
      sessionId: 'sess-1',
      message: {
        id: 'msg_1',
        model: 'claude-opus-5-5',
        usage: {
          input_tokens: 5,
          output_tokens: 7,
          cache_creation_input_tokens: 11,
          cache_read_input_tokens: 13,
          cache_creation: { ephemeral_5m_input_tokens: 4, ephemeral_1h_input_tokens: 7 },
        },
      },
    };
  }

  it('extractEntries returns exactly the extractEntry result, with the top-level split', () => {
    const raw = plain();
    const entries = meter.extractEntries(raw);
    expect(entries.length).toBe(1);
    expect(entries[0]).toEqual(meter.extractEntry(raw));
    expect(entries[0]).toMatchObject({
      input: 5, output: 7, cacheCreate: 11, cacheRead: 13, cache5m: 4, cache1h: 7,
    });
    expect(entries[0].advisor).toBeUndefined();
  });

  it('prices from the top-level split, and from the blended 5m fallback when the split is absent', () => {
    const p = PRICING.models['claude-opus-5-5'];
    const split = meter.extractEntry(plain());
    expect(meter.entryCostUSD(split, PRICING).costUSD).toBeCloseTo(
      (5 * p.input + 7 * p.output + 4 * p.cache_write_5m + 7 * p.cache_write_1h + 13 * p.cache_read) / M, 12);

    const raw = plain();
    delete raw.message.usage.cache_creation;
    const blended = meter.extractEntry(raw);
    expect(blended.cache5m).toBeNull();
    expect(blended.cache1h).toBeNull();
    expect(meter.entryCostUSD(blended, PRICING).costUSD).toBeCloseTo(
      (5 * p.input + 7 * p.output + 11 * p.cache_write_5m + 13 * p.cache_read) / M, 12);
  });
});
