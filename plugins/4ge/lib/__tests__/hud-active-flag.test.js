import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const hudState = require('../hud-active-flag.cjs');

describe('hud-active-flag', () => {
  let tmpCwd;

  beforeEach(() => {
    tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-state-test-'));
  });

  afterEach(() => {
    try { fs.rmSync(tmpCwd, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('returns false when state file is missing', () => {
    expect(hudState.isActive(tmpCwd)).toBe(false);
  });

  it('returns true after setActive within TTL window', () => {
    hudState.setActive(tmpCwd, 60000);
    expect(hudState.isActive(tmpCwd)).toBe(true);
  });

  it('returns true after setActive with default TTL (no argument)', () => {
    const before = Date.now();
    hudState.setActive(tmpCwd);
    expect(hudState.isActive(tmpCwd)).toBe(true);
    const state = JSON.parse(fs.readFileSync(hudState.getStatePath(tmpCwd), 'utf8'));
    const expiresAt = new Date(state.expires_at).getTime();
    expect(expiresAt - before).toBeGreaterThanOrEqual(hudState.DEFAULT_TTL_MS);
  });

  it('returns false after TTL expires', () => {
    // Write state with expires_at in the past
    const dst = hudState.getStatePath(tmpCwd);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, JSON.stringify({
      active: true,
      since: new Date(Date.now() - 120000).toISOString(),
      expires_at: new Date(Date.now() - 60000).toISOString(),
    }));
    expect(hudState.isActive(tmpCwd)).toBe(false);
  });

  it('returns false after explicit setIdle', () => {
    hudState.setActive(tmpCwd, 60000);
    expect(hudState.isActive(tmpCwd)).toBe(true);
    hudState.setIdle(tmpCwd);
    expect(hudState.isActive(tmpCwd)).toBe(false);
  });

  it('returns false on malformed state file', () => {
    const dst = hudState.getStatePath(tmpCwd);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, 'not valid json {{{');
    expect(hudState.isActive(tmpCwd)).toBe(false);
  });

  it('returns false on state file missing expires_at', () => {
    const dst = hudState.getStatePath(tmpCwd);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, JSON.stringify({ active: true }));
    expect(hudState.isActive(tmpCwd)).toBe(false);
  });

  it('uses default TTL when ttlMs is invalid', () => {
    hudState.setActive(tmpCwd, 'not a number');
    expect(hudState.isActive(tmpCwd)).toBe(true);
    const raw = JSON.parse(fs.readFileSync(hudState.getStatePath(tmpCwd), 'utf8'));
    const ttl = new Date(raw.expires_at).getTime() - new Date(raw.since).getTime();
    expect(ttl).toBe(hudState.DEFAULT_TTL_MS);
  });

  it('refreshes expires_at on subsequent setActive', async () => {
    hudState.setActive(tmpCwd, 60000);
    const first = JSON.parse(fs.readFileSync(hudState.getStatePath(tmpCwd), 'utf8'));
    await new Promise(r => setTimeout(r, 10));
    hudState.setActive(tmpCwd, 60000);
    const second = JSON.parse(fs.readFileSync(hudState.getStatePath(tmpCwd), 'utf8'));
    expect(new Date(second.expires_at).getTime()).toBeGreaterThan(new Date(first.expires_at).getTime());
  });

  describe('getFreezeTime', () => {
    it('returns null when flag is active', () => {
      hudState.setActive(tmpCwd, 60000);
      expect(hudState.getFreezeTime(tmpCwd)).toBeNull();
    });

    it('returns `at` timestamp after setIdle', () => {
      const before = Date.now();
      hudState.setIdle(tmpCwd);
      const after = Date.now();
      const freeze = hudState.getFreezeTime(tmpCwd);
      expect(freeze).not.toBeNull();
      expect(freeze).toBeGreaterThanOrEqual(before);
      expect(freeze).toBeLessThanOrEqual(after);
    });

    it('returns same timestamp across repeated calls (stable freeze)', async () => {
      hudState.setIdle(tmpCwd);
      const first = hudState.getFreezeTime(tmpCwd);
      await new Promise(r => setTimeout(r, 20));
      const second = hudState.getFreezeTime(tmpCwd);
      expect(second).toBe(first);
    });

    it('falls back to expires_at when flag is TTL-expired active state', () => {
      const expiresAt = new Date(Date.now() - 60000).toISOString();
      const dst = hudState.getStatePath(tmpCwd);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.writeFileSync(dst, JSON.stringify({
        active: true,
        since: new Date(Date.now() - 120000).toISOString(),
        expires_at: expiresAt,
      }));
      expect(hudState.isActive(tmpCwd)).toBe(false);
      expect(hudState.getFreezeTime(tmpCwd)).toBe(new Date(expiresAt).getTime());
    });

    it('returns null on missing state file', () => {
      expect(hudState.getFreezeTime(tmpCwd)).toBeNull();
    });

    it('returns null on malformed state file', () => {
      const dst = hudState.getStatePath(tmpCwd);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.writeFileSync(dst, 'garbage');
      expect(hudState.getFreezeTime(tmpCwd)).toBeNull();
    });
  });
});
