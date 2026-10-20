// HUD history is keyed by session (SP1 D3, 2026-10-15). hud-history.json is shared by every
// session rendering the repo, so one flat sample list made two sessions interleave into a
// sawtooth `rate trend`, and the 30 s same-value dedupe only compared with the last sample
// of any session. Per the S594 per-instance ruling a statusline reads only its own samples.
// Synthetic fixtures only.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const _require = createRequire(import.meta.url);
const {
  loadHudData,
  mergeHarnessStdin,
  appendHudHistorySample,
} = _require('../hud-data-loader.cjs');
const { buildCanonicalState } = _require('../hud-state.cjs');
const { rateHistoryValues } = _require('../hud-zone-rate-limit.cjs');

let root;
let stateDir;
let historyFile;

function readSamples() {
  return JSON.parse(fs.readFileSync(historyFile, 'utf8')).samples;
}

function sessionState(id, extra = {}) {
  return { projectRoot: root, session: { id, contextPct: 0, rateLimits: 'N/A', ...extra } };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-history-session-'));
  stateDir = path.join(root, '_runs', 'os');
  historyFile = path.join(stateDir, 'hud-history.json');
  fs.mkdirSync(stateDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('appendHudHistorySample keys samples by session', () => {
  it('tags each sample with its session id', () => {
    const a = sessionState('sess-a');
    a.session.contextPct = 20;
    appendHudHistorySample(a, { includeContext: true });
    expect(readSamples()[0].sid).toBe('sess-a');
  });

  it('dedupes the 30 s same-value rule per session, not against the last sample of any session', () => {
    const now = Date.now();
    const a = sessionState('sess-a');
    const b = sessionState('sess-b');

    a.session.contextPct = 20;
    appendHudHistorySample(a, { includeContext: true, now });
    b.session.contextPct = 70;
    appendHudHistorySample(b, { includeContext: true, now: now + 1000 });
    // Same value from the same session inside 30 s: a duplicate, whoever wrote in between.
    appendHudHistorySample(a, { includeContext: true, now: now + 2000 });

    expect(readSamples().map((sample) => sample.sid)).toEqual(['sess-a', 'sess-b']);
  });

  it('gives each session only its own trend', () => {
    const now = Date.now();
    const a = sessionState('sess-a');
    const b = sessionState('sess-b');
    const aValues = [20, 22, 24];
    const bValues = [70, 10, 90];

    aValues.forEach((value, i) => {
      a.session.contextPct = value;
      appendHudHistorySample(a, { includeContext: true, now: now + i * 2000 });
      b.session.contextPct = bValues[i];
      appendHudHistorySample(b, { includeContext: true, now: now + i * 2000 + 1000 });
    });

    expect(a.session.contextPctHistory).toEqual(aValues);
    expect(b.session.contextPctHistory).toEqual(bValues);
  });

  it('caps the history per session, so a busy session cannot evict a quiet one', () => {
    const now = Date.now();
    const quiet = sessionState('sess-quiet');
    quiet.session.contextPct = 5;
    appendHudHistorySample(quiet, { includeContext: true, now });

    const busy = sessionState('sess-busy');
    for (let i = 0; i < 160; i += 1) {
      busy.session.contextPct = 10 + (i % 80);
      appendHudHistorySample(busy, { includeContext: true, now: now + 1000 + i * 1000 });
    }

    const samples = readSamples();
    expect(samples.filter((sample) => sample.sid === 'sess-quiet')).toHaveLength(1);
    const busyCount = samples.filter((sample) => sample.sid === 'sess-busy').length;
    expect(busyCount).toBeGreaterThan(1);
    expect(busyCount).toBeLessThan(160);
  });
});

describe('loadHudData scopes the history to the live session', () => {
  function writeHistory(samples) {
    const base = Date.now() - 300_000;
    fs.writeFileSync(historyFile, JSON.stringify({
      v: 1,
      samples: samples.map((sample, i) => ({ ts: new Date(base + i * 10_000).toISOString(), ...sample })),
    }));
  }

  const load = (extra = {}) => loadHudData({ stateDir, cwd: root, runExpensiveProbes: false, ...extra });

  it('reads only the live session samples when the caller names a session', () => {
    writeHistory([
      { contextPct: 11 },
      { sid: 'sess-a', contextPct: 20 },
      { sid: 'sess-b', contextPct: 70 },
      { sid: 'sess-a', contextPct: 24 },
    ]);

    expect(load({ sessionId: 'sess-a' }).session.contextPctHistory).toEqual([20, 24]);
    expect(load({ sessionId: 'sess-b' }).session.contextPctHistory).toEqual([70]);
  });

  it('gives a session with no samples no history, and never another session\'s', () => {
    writeHistory([{ sid: 'sess-a', contextPct: 20, rateFiveHour: 40, rateSevenDay: 5 }]);

    const raw = load({ sessionId: 'sess-c' });
    expect(raw.session.contextPctHistory).toBeUndefined();
    expect(raw.session.rateLimitHistory).toBeUndefined();
  });

  it('keeps the whole file for callers with no live session (fleet and full HUD)', () => {
    writeHistory([
      { contextPct: 11 },
      { sid: 'sess-a', contextPct: 20 },
      { sid: 'sess-b', contextPct: 70 },
    ]);

    expect(load().session.contextPctHistory).toEqual([11, 20, 70]);
  });
});

describe('a rate tier the stdin did not carry is absent, never 0', () => {
  it('records only the tiers present in rate_limits', () => {
    const state = sessionState('sess-a');
    mergeHarnessStdin(state, {
      session_id: 'sess-a',
      rate_limits: { five_hour: { used_percentage: 81 }, seven_day: {} },
    });

    const [sample] = readSamples();
    expect(sample.rateFiveHour).toBe(81);
    expect(sample).not.toHaveProperty('rateSevenDay');
    expect(state.session.rateLimitHistory).toHaveLength(1);
    expect(state.session.rateLimitHistory[0].fiveHour).toBe(81);
    expect(state.session.rateLimitHistory[0]).not.toHaveProperty('sevenDay');
    // The row-1 figure keeps its defaulted 0 (hud-data-loader.test.js pins it).
    expect(state.session.rateLimits.sevenDay).toBe(0);
  });

  it('keeps an absent tier absent through the canonical state', () => {
    const state = buildCanonicalState({
      session: { rateLimitHistory: [{ ts: '2026-10-15T00:00:00.000Z', fiveHour: 81 }] },
    });
    expect(state.session.rateLimitHistory).toEqual([{ ts: '2026-10-15T00:00:00.000Z', fiveHour: 81 }]);
    expect(rateHistoryValues(state.session, 'sevenDay')).toEqual([]);
  });

  it('keeps one session\'s 7d trend free of another session\'s zeros', () => {
    const a = sessionState('sess-a');
    const b = sessionState('sess-b');
    const sevenDay = [80, 81, 82];

    sevenDay.forEach((value, i) => {
      mergeHarnessStdin(a, {
        session_id: 'sess-a',
        rate_limits: { five_hour: { used_percentage: 10 + i }, seven_day: { used_percentage: value } },
      });
      // The other session's stdin carries the 5h window only.
      mergeHarnessStdin(b, {
        session_id: 'sess-b',
        rate_limits: { five_hour: { used_percentage: 40 + i } },
      });
    });

    const trend = canonicalSevenDay(a);
    expect(trend).toEqual(sevenDay);
    // The relationship that matters for the sparkline: no sample sits far below the others.
    expect(Math.min(...trend)).toBeGreaterThanOrEqual(80);
  });
});

function canonicalSevenDay(state) {
  const canonical = buildCanonicalState({ session: { rateLimitHistory: state.session.rateLimitHistory } });
  return rateHistoryValues(canonical.session, 'sevenDay');
}
