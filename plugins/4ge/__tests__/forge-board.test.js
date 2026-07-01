import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const _require = createRequire(import.meta.url);
const forgeBoard = _require('../lib/forge-board.cjs');

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-board-plugin-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('4ge forge-board compatibility helper', () => {
  it('creates default board state and writes latest/current artifacts', () => {
    const board = forgeBoard.createBoard({
      projectRoot: tmpDir,
      summary: 'Unit test default board',
      now: '2026-06-21T20:00:00.000Z',
    });

    expect(board.schema_version).toBe(forgeBoard.SCHEMA_VERSION);
    expect(board.mode).toBe('code');
    expect(board.projection.mode).toBe('advisory');
    expect(board.project.slug).toBe(path.basename(tmpDir).toLowerCase());
    expect(board.session.s_number).toBeDefined();

    const result = forgeBoard.writeBoard(tmpDir, board);

    expect(fs.existsSync(result.paths.latest)).toBe(true);
    expect(fs.existsSync(result.paths.current)).toBe(true);
    expect(fs.readdirSync(path.dirname(result.paths.latest)).some(file => file.endsWith('.tmp'))).toBe(false);

    const latest = JSON.parse(fs.readFileSync(result.paths.latest, 'utf8'));
    const current = JSON.parse(fs.readFileSync(result.paths.current, 'utf8'));
    expect(latest.session.id).toBe(board.session.id);
    expect(current.session.id).toBe(board.session.id);
    expect(current.proof.proof_planes).toContain('source/code');
  });

  it('updates both mode and projection mode and persists latest/current', () => {
    const board = forgeBoard.createBoard({
      projectRoot: tmpDir,
      sessionId: 'S496-HELP',
      now: '2026-06-21T20:00:00.000Z',
      summary: 'Update test.',
    });
    forgeBoard.writeBoard(tmpDir, board);

    const updatedMode = forgeBoard.setMode(tmpDir, 'ship', { now: '2026-06-21T20:01:00.000Z' });
    expect(updatedMode.board.mode).toBe('ship');
    expect(updatedMode.board.decision.recommended_next_mode).toBe('maintain');
    expect(updatedMode.board.session.updated_at).toBe('2026-06-21T20:01:00.000Z');

    const updatedMaintain = forgeBoard.setMode(tmpDir, 'maintain', { now: '2026-06-21T20:01:30.000Z' });
    expect(updatedMaintain.board.decision.recommended_next_mode).toBe('code');

    const updatedProjection = forgeBoard.setProjectionMode(
      tmpDir,
      'auto-at-stop-lines',
      { now: '2026-06-21T20:02:00.000Z' },
    );
    expect(updatedProjection.board.projection.mode).toBe('auto-at-stop-lines');
    expect(updatedProjection.board.session.updated_at).toBe('2026-06-21T20:02:00.000Z');

    const latest = forgeBoard.readLatestBoard(tmpDir);
    expect(latest).toBeTruthy();
    expect(latest.mode).toBe('maintain');
    expect(latest.projection.mode).toBe('auto-at-stop-lines');
  });

  it('reads history index with fallback when history missing', () => {
    const index = forgeBoard.readHistoryIndex(tmpDir);
    expect(index.schema_version).toBe(forgeBoard.SCHEMA_VERSION);
    expect(index.project.root).toBe(tmpDir);
    expect(Array.isArray(index.entries)).toBe(true);
    expect(index.entries).toHaveLength(0);
  });

  it('rejects unknown mode and projection values', () => {
    expect(() => forgeBoard.setMode(tmpDir, 'deploy')).toThrow(/Invalid Forge board mode/);
    expect(() => forgeBoard.setProjectionMode(tmpDir, 'all')).toThrow(/Invalid projection mode/);
  });
});
