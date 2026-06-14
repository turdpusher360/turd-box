import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../../..');

describe('HUD kill-list guard', () => {
  it('does not ship the retired persistent hud-frame watcher', () => {
    const watcherPath = path.join(REPO_ROOT, 'plugins/4ge/bin/hud-watcher.cjs');
    expect(fs.existsSync(watcherPath)).toBe(false);
  });
});
