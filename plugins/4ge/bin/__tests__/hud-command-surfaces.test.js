import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../..');
const BIN_DIR = path.join(repoRoot, 'plugins/4ge/bin');
const HUD_COMMAND = path.join(repoRoot, 'plugins/4ge/commands/hud.md');

const SCRIPTS = [
  'hud-gemini-adapter.cjs',
  'hud-tmux-launch.sh',
  'hud-engine.cjs',
  'hud-zone-substrate.cjs',
];

const MODE_HEADINGS = [
  '## Gemini adapter (`gemini`)',
  '## Tmux pane (`pane`)',
  '## Substrate mode (`substrate`)',
];

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

describe('/4ge hud alternate surface command docs', () => {
  it('keeps the source-only safety instructions for every alternate surface', () => {
    const text = fs.readFileSync(HUD_COMMAND, 'utf8');

    expect(text).toContain('Do not write Gemini settings automatically');
    expect(text).toContain('Do not launch tmux automatically');
    expect(text).toContain('Do not run it automatically');
    expect(text).toContain('Do not install, launch, watch, or write config');
  });

  it('names each alternate-surface script, and each script exists under plugins/4ge/bin', () => {
    const text = fs.readFileSync(HUD_COMMAND, 'utf8');

    for (const script of SCRIPTS) {
      expect(fs.existsSync(path.join(BIN_DIR, script)), `${script} missing from plugins/4ge/bin`).toBe(true);
      expect(text, `hud.md does not name ${script}`).toContain(script);
    }
  });

  it('has one heading per alternate mode', () => {
    const text = fs.readFileSync(HUD_COMMAND, 'utf8');

    for (const heading of MODE_HEADINGS) {
      expect(text, `hud.md missing heading ${heading}`).toMatch(new RegExp(`^${escapeRegExp(heading)}$`, 'm'));
    }
  });
});
