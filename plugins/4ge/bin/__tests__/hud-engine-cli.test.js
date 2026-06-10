import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = path.resolve(__dirname, '..', 'hud-engine.cjs');

function run(...args) {
  return spawnSync('node', [ENGINE, ...args], { input: '{}', encoding: 'utf8', timeout: 10000 });
}

describe('hud-engine CLI --mode and --zone flags', () => {
  it('--mode=full produces non-empty output and exits 0', { timeout: 15000 }, () => {
    const result = run('--mode=full');
    expect(result.status).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);
  });

  it('--mode=zone --zone=face produces non-empty output', { timeout: 15000 }, () => {
    const result = run('--mode=zone', '--zone=face');
    expect(result.status).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);
  });

  it('--mode=zone --zone=health produces non-empty output', { timeout: 15000 }, () => {
    const result = run('--mode=zone', '--zone=health');
    expect(result.status).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);
  });

  it('--mode=strip produces non-empty output (single-line statusline)', { timeout: 15000 }, () => {
    const result = run('--mode=strip');
    expect(result.status).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);
  });
});
