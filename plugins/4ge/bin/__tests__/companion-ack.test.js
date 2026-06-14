import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

let tmpDir;
let ackPath;
let prevAckEnv;

function requireFresh() {
  const modPath = path.resolve(__dirname, '../companion-ack.cjs');
  delete require.cache[modPath];
  return require(modPath);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ack-'));
  ackPath = path.join(tmpDir, '.companion-ack.json');
  prevAckEnv = process.env.COMPANION_ACK_PATH;
  process.env.COMPANION_ACK_PATH = ackPath;
});

afterEach(() => {
  if (prevAckEnv === undefined) delete process.env.COMPANION_ACK_PATH;
  else process.env.COMPANION_ACK_PATH = prevAckEnv;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('companion-ack', () => {
  it('reports version drift when no ack file exists', () => {
    const ack = requireFresh();
    expect(ack.hasVersionDrift()).toBe(true);
    expect(ack.driftNotice()).toBe(ack.UPDATE_NOTICE);
  });

  it('ackVersion stamps the current plugin version and silences drift', () => {
    const ack = requireFresh();
    const v = ack.ackVersion();
    expect(typeof v).toBe('string');
    ack.clearCache();
    expect(ack.hasVersionDrift()).toBe(false);
    expect(ack.driftNotice()).toBeNull();
  });

  it('re-fires drift when the acked version differs from the current version', () => {
    const ack = requireFresh();
    // Stamp an OLD version directly, then assert drift re-appears.
    fs.writeFileSync(ackPath, JSON.stringify({ ackedVersion: '0.0.1' }));
    ack.clearCache();
    expect(ack.hasVersionDrift()).toBe(true);
  });

  it('the update notice is short enough to render under the elevated maxLen (<=110 chars)', () => {
    const ack = requireFresh();
    // The notice is posted with maxLen:110 by the engine; verify it fits so no
    // command is lost mid-word (the default 60-cap would truncate it).
    expect([...ack.UPDATE_NOTICE].length).toBeLessThanOrEqual(110);
    // And it actually contains the control hints (the part the 60-cap would eat).
    expect(ack.UPDATE_NOTICE).toContain('/hud face lively');
    expect(ack.UPDATE_NOTICE).toContain('/hud zen');
    expect(ack.UPDATE_NOTICE).toContain('/hud face ok');
  });

  it('fail-silent: a corrupt ack file does not throw and reads as drift', () => {
    fs.writeFileSync(ackPath, 'INVALID{{{');
    const ack = requireFresh();
    expect(() => ack.hasVersionDrift()).not.toThrow();
    expect(ack.hasVersionDrift()).toBe(true);
  });

  describe('postDriftNoticeIfNeeded (one-shot surfacing)', () => {
    function makeStub() {
      const calls = [];
      return { signalMessage: (text, opts) => calls.push({ text, opts }), _calls: calls };
    }

    it('posts the notice via the injected companion-state when drift exists', () => {
      const ack = requireFresh(); // no ack file → drift
      const stub = makeStub();
      const posted = ack.postDriftNoticeIfNeeded(stub);
      expect(posted).toBe(true);
      expect(stub._calls.length).toBe(1);
      expect(stub._calls[0].text).toBe(ack.UPDATE_NOTICE);
      expect(stub._calls[0].opts.tier).toBe('critical');
      // elevated maxLen so the control hint is not truncated mid-word
      expect(stub._calls[0].opts.maxLen).toBeGreaterThan(60);
    });

    it('does NOT post when there is no drift (acked)', () => {
      const ack = requireFresh();
      ack.ackVersion();
      ack.clearCache();
      const stub = makeStub();
      const posted = ack.postDriftNoticeIfNeeded(stub);
      expect(posted).toBe(false);
      expect(stub._calls.length).toBe(0);
    });

    it('fail-silent when the companion-state stub lacks signalMessage', () => {
      const ack = requireFresh();
      expect(() => ack.postDriftNoticeIfNeeded({})).not.toThrow();
      expect(ack.postDriftNoticeIfNeeded({})).toBe(false);
    });
  });
});
