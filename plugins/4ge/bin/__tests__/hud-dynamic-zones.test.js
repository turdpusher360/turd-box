import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = path.resolve(__dirname, '..', 'hud-engine.cjs');
const _require = createRequire(import.meta.url);
const { rateVisible } = _require('../hud-zone-rate-limit.cjs');

function runEngine(stdinJson) {
  return spawnSync('node', [ENGINE, '--mode=full'], {
    input: JSON.stringify(stdinJson),
    encoding: 'utf8',
    timeout: 15000,
  });
}

describe('dynamic zone visibility', () => {
  it('rate-limit zone hidden when rateLimits below threshold', { timeout: 15000 }, () => {
    // Full mode uses stdinOverride (canonical state format), not mergeHarnessStdin
    const result = runEngine({ session: { rateLimits: { fiveHour: 30, sevenDay: 10 } } });
    expect(result.status).toBe(0);
    const plain = result.stdout.replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain).not.toContain('rate limit');
  });

  it('rate-limit zone visible when rateLimits above 80%', { timeout: 15000 }, () => {
    const result = runEngine({ session: { rateLimits: { fiveHour: 90, sevenDay: 20 } } });
    expect(result.status).toBe(0);
    const plain = result.stdout.replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain).toContain('rate limit');
  });

  it('existing zones render when rate-limit is hidden', { timeout: 15000 }, () => {
    const result = runEngine({});
    expect(result.status).toBe(0);
    const plain = result.stdout.replace(/\x1b\[[0-9;]*m/g, '');
    // Face zone should always be present
    expect(plain).toContain('Agentic OS');
  });

  it('rateVisible returns false for N/A sentinel', () => {
    expect(rateVisible({ session: { rateLimits: 'N/A' } })).toBe(false);
  });

  it('rateVisible returns true for numeric threshold breach', () => {
    expect(rateVisible({ session: { rateLimits: { fiveHour: 95, sevenDay: 10 } } })).toBe(true);
  });
});
