// A failed cache rename must not strand its tmp file (SP1 D4, 2026-10-15). The lead's own
// hud-tool-count directory carried 0 B and 221 B `.tmp` files from interrupted writes.
// Synthetic fixtures only.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const _require = createRequire(import.meta.url);
const { countSessionToolUses, cacheFilePath } = _require('../hud-tool-count.cjs');

const SID = 'cccccccc-1111-4222-8333-000000000003';

let root;
let stateDir;
let transcript;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-tool-count-tmp-'));
  stateDir = path.join(root, '_runs', 'os');
  fs.mkdirSync(stateDir, { recursive: true });
  transcript = path.join(root, `${SID}.jsonl`);
  fs.writeFileSync(transcript, `${JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'true' } }] },
  })}\n`);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

function tmpFilesBesideCache() {
  const dir = path.dirname(cacheFilePath(stateDir, SID));
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')) : [];
}

describe('countSessionToolUses cache write', () => {
  it('removes its tmp file when the rename fails, and still returns the count', () => {
    const cache = cacheFilePath(stateDir, SID);
    const realRename = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to) === cache) throw Object.assign(new Error('rename refused'), { code: 'EACCES' });
      return realRename.call(fs, from, to);
    });

    const result = countSessionToolUses({ transcriptPath: transcript, sessionId: SID, stateDir });

    expect(result.count).toBe(1);
    expect(fs.existsSync(cache)).toBe(false);
    expect(tmpFilesBesideCache()).toEqual([]);
  });

  it('removes its tmp file when the tmp write itself fails part way', () => {
    const realWrite = fs.writeFileSync;
    vi.spyOn(fs, 'writeFileSync').mockImplementation((file, ...args) => {
      if (String(file).endsWith('.tmp')) {
        realWrite.call(fs, file, '', 'utf8');
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      }
      return realWrite.call(fs, file, ...args);
    });

    const result = countSessionToolUses({ transcriptPath: transcript, sessionId: SID, stateDir });

    expect(result.count).toBe(1);
    expect(tmpFilesBesideCache()).toEqual([]);
  });

  it('control: a normal write leaves the cache file and no tmp file', () => {
    countSessionToolUses({ transcriptPath: transcript, sessionId: SID, stateDir });

    expect(fs.existsSync(cacheFilePath(stateDir, SID))).toBe(true);
    expect(tmpFilesBesideCache()).toEqual([]);
  });
});
