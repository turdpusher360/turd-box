import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);
const store = _require(path.resolve(__dirname, '../../lib/hud-board-store.cjs'));

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-board-store-'));
});
afterEach(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('hud-board-store — constants + levelRole', () => {
  it('exposes schema version and valid levels', () => {
    expect(store.SCHEMA_VERSION).toBe(1);
    expect(store.VALID_LEVELS).toEqual(['info', 'ok', 'warn', 'alert', 'accent']);
  });

  it('maps every valid level to a palette role, alert → error', () => {
    for (const lvl of store.VALID_LEVELS) {
      expect(typeof store.levelRole(lvl)).toBe('string');
    }
    expect(store.levelRole('alert')).toBe('error');
    expect(store.levelRole('ok')).toBe('ok');
    expect(store.levelRole('bogus')).toBe('text'); // unknown falls back
  });
});

describe('hud-board-store — write/read roundtrip', () => {
  it('writes then reads back an equivalent board', () => {
    const written = store.writeBoard(dir, {
      title: 'Deploy',
      lines: [{ level: 'ok', text: 'green' }, { level: 'warn', text: 'watch cron' }],
      ttlSec: 600,
      priority: 5,
    });
    const read = store.readBoard(dir);
    expect(read).not.toBeNull();
    expect(read.title).toBe('Deploy');
    expect(read.lines).toHaveLength(2);
    expect(read.lines[0]).toEqual({ level: 'ok', text: 'green' });
    expect(read.ttlSec).toBe(600);
    expect(read.priority).toBe(5);
    expect(read.createdAt).toBe(written.createdAt);
  });

  it('writes to hud-board.json inside the state dir', () => {
    store.writeBoard(dir, { lines: [{ level: 'info', text: 'x' }] });
    expect(fs.existsSync(path.join(dir, 'hud-board.json'))).toBe(true);
  });

  it('applies the default ttl when none supplied', () => {
    store.writeBoard(dir, { lines: [{ level: 'info', text: 'x' }] });
    expect(store.readBoard(dir).ttlSec).toBe(store.DEFAULT_TTL_SEC);
  });

  it('coerces an unknown level to info on write', () => {
    store.writeBoard(dir, { lines: [{ level: 'explode', text: 'x' }] });
    expect(store.readBoard(dir).lines[0].level).toBe('info');
  });

  it('drops empty-text lines and throws when nothing survives', () => {
    expect(() => store.writeBoard(dir, { lines: [{ level: 'ok', text: '   ' }] })).toThrow();
  });
});

describe('hud-board-store — freshness / expiry', () => {
  it('isFresh is true within ttl, false past it', () => {
    const created = 1_000_000;
    const board = { createdAt: created, ttlSec: 100 };
    expect(store.isFresh(board, created + 50 * 1000)).toBe(true);
    expect(store.isFresh(board, created + 150 * 1000)).toBe(false);
  });

  it('readBoard returns null once the board has expired', () => {
    const now = Date.now();
    store.writeBoard(dir, { lines: [{ level: 'info', text: 'x' }], ttlSec: 10 }, now);
    // fresh at write time
    expect(store.readBoard(dir, now + 5 * 1000)).not.toBeNull();
    // expired 20s later
    expect(store.readBoard(dir, now + 20 * 1000)).toBeNull();
  });
});

describe('hud-board-store — corrupt / missing = invisible', () => {
  it('missing file → null (never throws)', () => {
    expect(store.readBoard(dir)).toBeNull();
  });

  it('corrupt JSON → null (never throws)', () => {
    fs.writeFileSync(path.join(dir, 'hud-board.json'), '{not valid json');
    expect(store.readBoard(dir)).toBeNull();
  });

  it('wrong schema version → null', () => {
    fs.writeFileSync(path.join(dir, 'hud-board.json'), JSON.stringify({
      v: 99, title: 't', lines: [{ level: 'ok', text: 'x' }], ttlSec: 900, createdAt: Date.now(),
    }));
    expect(store.readBoard(dir)).toBeNull();
  });

  it('zero valid lines → null', () => {
    fs.writeFileSync(path.join(dir, 'hud-board.json'), JSON.stringify({
      v: 1, title: 't', lines: [], ttlSec: 900, createdAt: Date.now(),
    }));
    expect(store.readBoard(dir)).toBeNull();
  });

  it('validateBoard accepts an ISO createdAt string', () => {
    const iso = new Date().toISOString();
    const board = store.validateBoard({
      v: 1, title: 't', lines: [{ level: 'ok', text: 'x' }], ttlSec: 900, createdAt: iso,
    });
    expect(board).not.toBeNull();
    expect(board.createdAt).toBe(Date.parse(iso));
  });
});

describe('hud-board-store — clear', () => {
  it('clearBoard removes the file and reports true, then false', () => {
    store.writeBoard(dir, { lines: [{ level: 'info', text: 'x' }] });
    expect(store.clearBoard(dir)).toBe(true);
    expect(store.readBoard(dir)).toBeNull();
    expect(store.clearBoard(dir)).toBe(false); // nothing left to clear
  });
});

describe('hud-board-store — atomic write leaves no temp files', () => {
  it('only hud-board.json remains after a write', () => {
    store.writeBoard(dir, { lines: [{ level: 'info', text: 'x' }] });
    const entries = fs.readdirSync(dir);
    expect(entries).toEqual(['hud-board.json']);
  });
});
