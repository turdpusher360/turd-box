import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const _require = createRequire(import.meta.url);
const writer = _require('../forge-progress-writer.cjs');
const {
  renderForgeProgressZone,
  forgeProgressVisible,
} = _require('../../bin/hud-zone-forge-progress.cjs');
const { resolvePalette, stripAnsi } = _require('../../bin/hud-palette.cjs');

const palette = resolvePalette({ name: 'plain' });

let tmpRoot;
let stateDir;
let opts;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-progress-'));
  stateDir = path.join(tmpRoot, '_runs', 'os');
  opts = { stateDir };
});

afterEach(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('forge-progress-writer — write → read-back', () => {
  it('startSession writes the file with the required schema', () => {
    writer.startSession({ session: 'S396', task: 'Build the writer' }, opts);
    const doc = writer.readProgress(opts);
    expect(doc).not.toBeNull();
    expect(doc.session).toBe('S396');
    expect(doc.task).toBe('Build the writer');
    expect(typeof doc.startedAt).toBe('string');
    expect(Array.isArray(doc.waves)).toBe(true);
    expect(doc.totals).toEqual({ shipped: 0, packages: 0, running: 0, queued: 0 });
  });

  it('persists to disk at _runs/os/forge-progress.json', () => {
    writer.startSession({ session: 'S396', task: 't' }, opts);
    expect(fs.existsSync(path.join(stateDir, 'forge-progress.json'))).toBe(true);
  });
});

describe('forge-progress-writer — lights up the orphaned zone', () => {
  it('forgeProgressVisible() is false on empty session, true after a wave', () => {
    writer.startSession({ session: 'S396', task: 't' }, opts);
    let doc = writer.readProgress(opts);
    expect(forgeProgressVisible({ forgeProgress: doc })).toBe(false);

    writer.upsertWave(
      { id: '1', label: 'Foundation', status: 'running', packages: ['lib'] },
      opts
    );
    doc = writer.readProgress(opts);
    expect(forgeProgressVisible({ forgeProgress: doc })).toBe(true);
  });

  it('renderForgeProgressZone produces a FORGE header + one row per wave', () => {
    writer.startSession({ session: 'S396', task: 'Build the writer' }, opts);
    writer.upsertWave(
      { id: '1', label: 'Foundation', status: 'shipped', commits: 2, packages: ['a', 'b'] },
      opts
    );
    writer.upsertWave(
      { id: '2', label: 'Wiring', status: 'running', packages: ['c'] },
      opts
    );
    const doc = writer.readProgress(opts);
    const lines = renderForgeProgressZone({ forgeProgress: doc }, palette).map(stripAnsi);

    // header
    expect(lines[0]).toContain('FORGE');
    expect(lines[0]).toContain('S396');
    // a row mentioning each wave label
    const joined = lines.join('\n');
    expect(joined).toContain('Foundation');
    expect(joined).toContain('Wiring');
    // footer shows shipped/total packages
    expect(joined).toMatch(/shipped/);
  });
});

describe('forge-progress-writer — totals derivation', () => {
  it('recomputes shipped/packages/running/queued from waves', () => {
    writer.startSession({ session: 'S', task: 't' }, opts);
    writer.upsertWave({ id: '1', status: 'shipped', packages: ['a', 'b'] }, opts);
    writer.upsertWave({ id: '2', status: 'running', packages: ['c'] }, opts);
    writer.upsertWave({ id: '3', status: 'queued', packages: [] }, opts);
    const doc = writer.readProgress(opts);
    expect(doc.totals).toEqual({ shipped: 1, packages: 3, running: 1, queued: 1 });
  });
});

describe('forge-progress-writer — markAgent upsert', () => {
  it('adds an agent, then updates it by name without duplicating', () => {
    writer.startSession({ session: 'S', task: 't' }, opts);
    writer.upsertWave({ id: '1', status: 'running', packages: ['x'] }, opts);
    writer.markAgent('1', { name: 'impl-x', type: 'sonnet-execute', status: 'running' }, opts);
    writer.markAgent('1', { name: 'impl-x', status: 'done' }, opts);

    const doc = writer.readProgress(opts);
    const wave = doc.waves.find((w) => w.id === '1');
    expect(wave.agents).toHaveLength(1);
    expect(wave.agents[0].name).toBe('impl-x');
    expect(wave.agents[0].status).toBe('done');
    expect(wave.agents[0].type).toBe('sonnet-execute'); // preserved across patch
  });

  it('creates the wave if markAgent targets a missing wave id', () => {
    writer.startSession({ session: 'S', task: 't' }, opts);
    writer.markAgent('9', { name: 'lone', status: 'running' }, opts);
    const doc = writer.readProgress(opts);
    const wave = doc.waves.find((w) => w.id === '9');
    expect(wave).toBeTruthy();
    expect(wave.agents[0].name).toBe('lone');
  });
});

describe('forge-progress-writer — updateWave + clearProgress', () => {
  it('updateWave patches status/commits of an existing wave', () => {
    writer.startSession({ session: 'S', task: 't' }, opts);
    writer.upsertWave({ id: '1', status: 'running', packages: ['x'] }, opts);
    writer.updateWave('1', { status: 'shipped', commits: 4 }, opts);
    const doc = writer.readProgress(opts);
    const wave = doc.waves.find((w) => w.id === '1');
    expect(wave.status).toBe('shipped');
    expect(wave.commits).toBe(4);
    expect(doc.totals.shipped).toBe(1);
  });

  it('clearProgress removes the file (Phase 7 / park / cancel)', () => {
    writer.startSession({ session: 'S', task: 't' }, opts);
    expect(fs.existsSync(path.join(stateDir, 'forge-progress.json'))).toBe(true);
    writer.clearProgress(opts);
    expect(fs.existsSync(path.join(stateDir, 'forge-progress.json'))).toBe(false);
    expect(writer.readProgress(opts)).toBeNull();
  });
});
