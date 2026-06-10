import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const require = createRequire(import.meta.url);
const { readInbox: readInboxRaw, isOpen, isExpired } = require('../wizard-inbox-reader.cjs');

// Fixtures are dated 2026-04-10; pin "now" just after so the default 30-day
// purge window does not silently drop them in unrelated open/closed/dedup tests.
const FIXTURE_NOW = Date.parse('2026-04-11T00:00:00.000Z');
function readInbox(projectRoot, opts = {}) {
  return readInboxRaw(projectRoot, { now: FIXTURE_NOW, ...opts });
}

// ---------------------------------------------------------------------------
// Helpers — real tmpdir, real fs (matches project test conventions)
// ---------------------------------------------------------------------------

let tmpDir;

function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-inbox-test-'));
  fs.mkdirSync(path.join(tmpDir, '_runs'), { recursive: true });
}

function cleanup() {
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
}

function toJsonl(entries) {
  return entries.map((e) => JSON.stringify(e)).join('\n');
}

function writePrimary(entries) {
  fs.writeFileSync(
    path.join(tmpDir, '.4ge-wizard-inbox.jsonl'),
    toJsonl(entries),
    'utf-8',
  );
}

function writeSecondary(entries) {
  fs.writeFileSync(
    path.join(tmpDir, '_runs', '.fix-inbox.jsonl'),
    toJsonl(entries),
    'utf-8',
  );
}

function entry(overrides = {}) {
  return {
    ts: '2026-04-10T00:00:00.000Z',
    description: 'Fix something',
    category: 'hooks',
    source: 'manual',
    status: 'open',
    confidence: 0.9,
    tier: 'auto',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => setup());
afterEach(() => cleanup());

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('wizard-inbox-reader', () => {
  describe('readInbox()', () => {

    it('empty files — both files empty, returns empty result', () => {
      writePrimary([]);
      writeSecondary([]);

      const result = readInbox(tmpDir);

      expect(result.total).toBe(0);
      expect(result.categories).toEqual({});
      expect(result.entries).toEqual([]);
    });

    it('missing files — both missing (ENOENT), returns empty result', () => {
      // Don't write any files — tmpDir has no inbox files
      const result = readInbox(tmpDir);

      expect(result.total).toBe(0);
      expect(result.categories).toEqual({});
      expect(result.entries).toEqual([]);
    });

    it('single file with entries — 3 open entries across 2 categories, counts correct', () => {
      writePrimary([
        entry({ category: 'hooks', description: 'Fix hook A' }),
        entry({ category: 'hooks', description: 'Fix hook B' }),
        entry({ category: 'dead_code', description: 'Remove dead function' }),
      ]);

      const result = readInbox(tmpDir);

      expect(result.total).toBe(3);
      expect(result.categories.hooks).toBe(2);
      expect(result.categories.dead_code).toBe(1);
    });

    it('both files merged — entries from both files combined', () => {
      writePrimary([
        entry({ description: 'Primary entry 1', category: 'hooks' }),
      ]);
      writeSecondary([
        entry({ description: 'Secondary entry 1', category: 'dead_code', source: 'hook-health-validator' }),
        entry({ description: 'Secondary entry 2', category: 'hooks', source: 'hook-health-validator' }),
      ]);

      const result = readInbox(tmpDir);

      expect(result.total).toBe(3);
      expect(result.categories.hooks).toBe(2);
      expect(result.categories.dead_code).toBe(1);
    });

    it('deduplication — same description in both files counted once', () => {
      const desc = 'Duplicate fix item';
      writePrimary([entry({ description: desc, category: 'hooks', source: 'manual' })]);
      writeSecondary([entry({ description: desc, category: 'hooks', source: 'hook-health-validator' })]);

      const result = readInbox(tmpDir);

      expect(result.total).toBe(1);
      expect(result.entries[0].source).toBe('manual'); // primary wins
    });

    it('status filter — entries with status "resolved" or "closed" excluded', () => {
      writePrimary([
        entry({ description: 'Open item', status: 'open' }),
        entry({ description: 'Resolved item', status: 'resolved' }),
        entry({ description: 'Closed item', status: 'closed' }),
      ]);

      const result = readInbox(tmpDir);

      expect(result.total).toBe(1);
      expect(result.entries[0].description).toBe('Open item');
    });

    it('missing status — entry without status field treated as open', () => {
      const e = entry({ description: 'No status entry' });
      delete e.status;
      writePrimary([e]);

      const result = readInbox(tmpDir);

      expect(result.total).toBe(1);
    });

    it('sanitization — control characters in description stripped', () => {
      writePrimary([entry({ description: 'Fix\x00 bug\x1f here\x7f' })]);

      const result = readInbox(tmpDir);

      expect(result.entries[0].description).toBe('Fix bug here');
    });

    it('malformed JSON — bad line skipped, good lines still parsed', () => {
      const good = entry({ description: 'Good entry', category: 'hooks' });
      const content = `${JSON.stringify(good)}\n{bad json here\n${JSON.stringify(good)}`;
      fs.writeFileSync(path.join(tmpDir, '.4ge-wizard-inbox.jsonl'), content, 'utf-8');

      const result = readInbox(tmpDir);

      // Two good lines with same description -> dedup -> 1
      expect(result.total).toBe(1);
      expect(result.entries[0].description).toBe('Good entry');
    });

    it('missing description — entry without description field skipped', () => {
      const noDesc = { ts: '2026-04-10T00:00:00.000Z', category: 'hooks', status: 'open' };
      const withDesc = entry({ description: 'Valid entry' });
      writePrimary([noDesc, withDesc]);

      const result = readInbox(tmpDir);

      expect(result.total).toBe(1);
      expect(result.entries[0].description).toBe('Valid entry');
    });

    it('missing category — entry without category field gets "uncategorized"', () => {
      const e = entry({ description: 'No category entry' });
      delete e.category;
      writePrimary([e]);

      const result = readInbox(tmpDir);

      expect(result.total).toBe(1);
      expect(result.categories.uncategorized).toBe(1);
      expect(result.entries[0].category).toBe('uncategorized');
    });

    it('case-insensitive dedup — "Fix bug" and "fix bug" are duplicates', () => {
      writePrimary([entry({ description: 'Fix bug', source: 'manual' })]);
      writeSecondary([entry({ description: 'fix bug', source: 'hook-health-validator' })]);

      const result = readInbox(tmpDir);

      expect(result.total).toBe(1);
      // Primary source wins — e1 has source 'manual'
      expect(result.entries[0].source).toBe('manual');
    });

    // ── Lifecycle: status vocabulary (C5) ────────────────────────────────────

    it('status "applied" — writer-applied items are closed and excluded', () => {
      writePrimary([
        entry({ description: 'applied item', status: 'applied' }),
        entry({ description: 'open item', status: 'open' }),
      ]);

      const result = readInbox(tmpDir);

      expect(result.total).toBe(1);
      expect(result.entries[0].description).toBe('open item');
    });

    it('status "dismissed" — writer-dismissed items are closed and excluded', () => {
      writePrimary([
        entry({ description: 'dismissed item', status: 'dismissed' }),
        entry({ description: 'open item', status: 'open' }),
      ]);

      const result = readInbox(tmpDir);

      expect(result.total).toBe(1);
      expect(result.entries[0].description).toBe('open item');
    });

    it('status vocabulary is case-insensitive (Applied/DISMISSED close)', () => {
      writePrimary([
        entry({ description: 'a', status: 'Applied' }),
        entry({ description: 'b', status: 'DISMISSED' }),
        entry({ description: 'c', status: 'open' }),
      ]);

      const result = readInbox(tmpDir);

      expect(result.total).toBe(1);
      expect(result.entries[0].description).toBe('c');
    });

    // ── Lifecycle: 30-day auto-purge (C5) ────────────────────────────────────

    it('purge — entries older than max_age_days are dropped from the open set', () => {
      writePrimary([
        entry({ ts: '2026-02-01T00:00:00.000Z', description: 'ancient', status: 'open' }), // ~69d before FIXTURE_NOW
        entry({ ts: '2026-04-10T00:00:00.000Z', description: 'recent', status: 'open' }),   // 1d before
      ]);

      const result = readInbox(tmpDir); // default 30-day window, now=FIXTURE_NOW

      expect(result.total).toBe(1);
      expect(result.entries[0].description).toBe('recent');
    });

    it('purge — undated entries (missing/unparseable ts) are kept (fail-safe)', () => {
      const e1 = entry({ description: 'no ts' });
      delete e1.ts;
      const e2 = entry({ ts: 'not-a-date', description: 'bad ts' });
      writePrimary([e1, e2]);

      const result = readInbox(tmpDir);

      expect(result.total).toBe(2);
    });

    it('purge — disabled when max_age_days <= 0', () => {
      writePrimary([
        entry({ ts: '2025-01-01T00:00:00.000Z', description: 'very old', status: 'open' }),
      ]);

      const result = readInbox(tmpDir, { maxAgeDays: 0 });

      expect(result.total).toBe(1);
    });

  });

  // ── Predicate units (exported for reachability proofs) ─────────────────────

  describe('isOpen()', () => {
    it('treats applied/dismissed/resolved/closed as closed', () => {
      expect(isOpen({ status: 'applied' })).toBe(false);
      expect(isOpen({ status: 'dismissed' })).toBe(false);
      expect(isOpen({ status: 'resolved' })).toBe(false);
      expect(isOpen({ status: 'closed' })).toBe(false);
    });
    it('treats open / missing status as open', () => {
      expect(isOpen({ status: 'open' })).toBe(true);
      expect(isOpen({})).toBe(true);
      expect(isOpen({ status: null })).toBe(true);
    });
  });

  describe('isExpired()', () => {
    const now = Date.parse('2026-06-09T00:00:00.000Z');
    it('expires entries past the window', () => {
      expect(isExpired({ ts: '2026-04-01T00:00:00.000Z' }, 30, now)).toBe(true);
    });
    it('keeps entries inside the window', () => {
      expect(isExpired({ ts: '2026-06-01T00:00:00.000Z' }, 30, now)).toBe(false);
    });
    it('never expires undated entries', () => {
      expect(isExpired({}, 30, now)).toBe(false);
      expect(isExpired({ ts: 'garbage' }, 30, now)).toBe(false);
    });
    it('disabled when maxAgeDays <= 0', () => {
      expect(isExpired({ ts: '2020-01-01T00:00:00.000Z' }, 0, now)).toBe(false);
    });
  });
});
