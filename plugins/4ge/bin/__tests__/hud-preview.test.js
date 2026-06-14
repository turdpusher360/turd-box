import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';

const _require = createRequire(import.meta.url);
const PREVIEW_PATH = path.resolve(__dirname, '../hud-preview.cjs');
const MOCK_HEALTHY = path.resolve(__dirname, '../mocks/healthy.json');
const { stripAnsi } = _require(path.resolve(__dirname, '../hud-palette.cjs'));

function requireFresh() {
  for (const key of Object.keys(_require.cache)) {
    if (key.includes('hud-preview') || key.includes('hud-surface-host') || key.includes('hud-engine')) {
      delete _require.cache[key];
    }
  }
  return _require(PREVIEW_PATH);
}

describe('hud-preview', () => {
  it('exports import-safe preview helpers backed by the surface host', () => {
    const preview = requireFresh();
    expect(preview.usesSurfaceHost).toBe(true);
    expect(typeof preview.renderFrame).toBe('function');
    expect(typeof preview.loadState).toBe('function');
  });

  it('renders a preview frame in-process through the shared surface host', () => {
    const preview = requireFresh();
    const output = preview.renderFrame({
      mode: 'strip',
      stateFile: MOCK_HEALTHY,
      cols: 100,
      rows: 24,
    });

    expect(stripAnsi(output)).toContain('ctx');
  });
});
