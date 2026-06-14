import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const HUD_COMMAND = path.resolve(process.cwd(), 'plugins/4ge/commands/hud.md');

describe('/4ge hud alternate surface command docs', () => {
  it('documents source-only Gemini and tmux pane surfaces without auto-mutating external config', () => {
    const text = fs.readFileSync(HUD_COMMAND, 'utf8');

    expect(text).toContain('If `gemini`:');
    expect(text).toContain('hud-gemini-adapter.cjs');
    expect(text).toContain('Do not write Gemini settings automatically');
    expect(text).toContain('If `pane`:');
    expect(text).toContain('hud-tmux-launch.sh');
    expect(text).toContain('Do not launch tmux automatically');
  });

  it('documents substrate as a source-only engine mode without auto-launching runtime state', () => {
    const text = fs.readFileSync(HUD_COMMAND, 'utf8');

    expect(text).toContain('If `substrate`:');
    expect(text).toContain('--mode=substrate');
    expect(text).toContain('hud-engine.cjs');
    expect(text).toContain('hud-zone-substrate.cjs');
    expect(text).toContain('Do not run it automatically');
    expect(text).toContain('Do not install, launch, watch, or write config');
    expect(text).toContain('HUD: substrate snippet shown');
  });
});
