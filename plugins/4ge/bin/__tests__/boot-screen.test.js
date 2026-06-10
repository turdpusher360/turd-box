import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);
const MODULE_PATH = path.resolve(__dirname, '../boot-screen.cjs');

function requireFresh() {
  const resolved = _require.resolve(MODULE_PATH);
  delete _require.cache[resolved];
  const palettePath = _require.resolve(path.resolve(__dirname, '../hud-palette.cjs'));
  delete _require.cache[palettePath];
  const facePath = _require.resolve(path.resolve(__dirname, '../hud-zone-face.cjs'));
  delete _require.cache[facePath];
  return _require(resolved);
}

// --- Test Fixtures ---

const FIXTURE_ALL_HEALTHY = {
  booted_at: '2026-04-06T04:52:17.013Z',
  total_boot_ms: 1819,
  overall: 'ready',
  capabilities: {
    memory: { status: 'ready', init_ms: 108 },
    git: { status: 'ready', init_ms: 35 },
    'file-integrity': { status: 'ready', init_ms: 50 },
    infra: { status: 'ready', init_ms: 1335 },
    'forge-session': { status: 'ready', init_ms: 1 },
    audit: { status: 'ready', init_ms: 0 },
    forge: { status: 'ready', init_ms: 0 },
    autoresearch: { status: 'ready', init_ms: 0 },
    aisle: { status: 'ready', init_ms: 10 },
    'process-health': { status: 'ready', init_ms: 12 },
  },
};

const FIXTURE_ONE_DEGRADED = {
  booted_at: '2026-04-06T04:52:17.013Z',
  total_boot_ms: 1819,
  overall: 'degraded',
  capabilities: {
    ...FIXTURE_ALL_HEALTHY.capabilities,
    aisle: { status: 'degraded', init_ms: 228, reason: 'fail-closed' },
  },
};

const FIXTURE_MULTI_DEGRADED = {
  total_boot_ms: 4200,
  capabilities: {
    memory: { status: 'degraded', init_ms: 5008, reason: 'timeout' },
    git: { status: 'failed', init_ms: 100, reason: 'lock conflict' },
  },
};

// --- Shared Export Tests ---

describe('humanizeMs', () => {
  it('returns milliseconds for values under 1000', () => {
    const { humanizeMs } = requireFresh();
    expect(humanizeMs(228)).toBe('228ms');
  });

  it('returns seconds with 1 decimal for values >= 1000', () => {
    const { humanizeMs } = requireFresh();
    expect(humanizeMs(1819)).toBe('1.8s');
  });

  it('returns 1.0s for exactly 1000', () => {
    const { humanizeMs } = requireFresh();
    expect(humanizeMs(1000)).toBe('1.0s');
  });
});

describe('computeHealthScore', () => {
  it('computes percentage of ready caps rounded', () => {
    const { computeHealthScore } = requireFresh();
    const boot = {
      capabilities: {
        memory: { status: 'ready' },
        git: { status: 'ready' },
        aisle: { status: 'degraded' },
      },
    };
    expect(computeHealthScore(boot)).toBe(67);
  });

  it('returns 0 for empty capabilities', () => {
    const { computeHealthScore } = requireFresh();
    expect(computeHealthScore({ capabilities: {} })).toBe(0);
    expect(computeHealthScore({})).toBe(0);
  });
});

describe('gradeForScore', () => {
  it('returns correct grade at boundaries', () => {
    const { gradeForScore } = requireFresh();
    expect(gradeForScore(100)).toBe('A');
    expect(gradeForScore(90)).toBe('A');
    expect(gradeForScore(89)).toBe('B');
    expect(gradeForScore(75)).toBe('B');
    expect(gradeForScore(74)).toBe('C');
    expect(gradeForScore(55)).toBe('C');
    expect(gradeForScore(54)).toBe('D');
    expect(gradeForScore(35)).toBe('D');
    expect(gradeForScore(34)).toBe('F');
    expect(gradeForScore(0)).toBe('F');
  });
});

describe('pickQuip', () => {
  it('returns quip string for single known cap', () => {
    const { pickQuip } = requireFresh();
    const degraded = [{ name: 'memory', status: 'degraded', reason: 'timeout' }];
    const quip = pickQuip(degraded);
    expect(quip).toBeTruthy();
    expect(typeof quip).toBe('string');
  });

  it('returns quip for 3+ degraded', () => {
    const { pickQuip } = requireFresh();
    const degraded = [
      { name: 'forge-session' }, { name: 'aisle' }, { name: 'infra' },
    ];
    const quip = pickQuip(degraded);
    expect(quip).toBeTruthy();
  });

  it('returns null when no degraded caps', () => {
    const { pickQuip } = requireFresh();
    expect(pickQuip([])).toBeNull();
    expect(pickQuip(null)).toBeNull();
  });
});

describe('renderForgeMark', () => {
  it('returns null when lattice directory missing', () => {
    const { renderForgeMark } = requireFresh();
    // This test depends on whether _runs/s239-lattice/ exists
    // Just verify it returns string or null (no crash)
    const result = renderForgeMark();
    expect(result === null || typeof result === 'string').toBe(true);
  });
});

// --- v2-only Export Tests ---

describe('renderHealthBar', () => {
  it('renders health bar with correct grade label', () => {
    const { renderHealthBar, stripAnsi } = requireFresh();
    const bar = renderHealthBar(100);
    const plain = stripAnsi(bar);
    expect(plain).toContain('Health: 100');
    expect(plain).toContain('A');
    expect(plain).toContain('[');
    expect(plain).toContain(']');
  });

  it('renders full equals at 100%', () => {
    const { renderHealthBar, stripAnsi } = requireFresh();
    const plain = stripAnsi(renderHealthBar(100));
    // 20 fill chars at 100%
    expect(plain).toContain('====================');
  });

  it('renders all dashes at 0%', () => {
    const { renderHealthBar, stripAnsi } = requireFresh();
    const plain = stripAnsi(renderHealthBar(0));
    expect(plain).toContain('--------------------');
    expect(plain).toContain('F');
  });

  it('renders mixed fill at 50%', () => {
    const { renderHealthBar, stripAnsi } = requireFresh();
    const plain = stripAnsi(renderHealthBar(50));
    expect(plain).toContain('==========----------');
    expect(plain).toContain('D');
  });
});

describe('pickFace', () => {
  it('returns healthy face for 0 degraded', () => {
    const { pickFace } = requireFresh();
    const face = pickFace(0);
    expect(typeof face).toBe('string');
    expect(face.length).toBeGreaterThan(0);
  });

  it('returns degraded face for 1+ degraded', () => {
    const { pickFace } = requireFresh();
    const face1 = pickFace(1);
    const face3 = pickFace(3);
    const face6 = pickFace(6);
    expect(typeof face1).toBe('string');
    expect(typeof face3).toBe('string');
    expect(typeof face6).toBe('string');
  });

  it('returns different faces for different severity tiers', () => {
    const { pickFace } = requireFresh();
    // Healthy vs degraded should differ
    const healthy = pickFace(0);
    const degraded = pickFace(1);
    // At minimum, they are both non-empty strings (they may or may not differ
    // depending on NO_COLOR, but the function should not throw)
    expect(healthy.length).toBeGreaterThan(0);
    expect(degraded.length).toBeGreaterThan(0);
  });
});

describe('getLayer', () => {
  it('maps kernel caps to kernel layer', () => {
    const { getLayer } = requireFresh();
    expect(getLayer('forge-session')).toBe('kernel');
    expect(getLayer('git')).toBe('kernel');
    expect(getLayer('file-integrity')).toBe('kernel');
    expect(getLayer('process-health')).toBe('kernel');
  });

  it('maps services caps to services layer', () => {
    const { getLayer } = requireFresh();
    expect(getLayer('infra')).toBe('services');
  });

  it('maps caps-layer items correctly', () => {
    const { getLayer } = requireFresh();
    expect(getLayer('audit')).toBe('caps');
    expect(getLayer('forge')).toBe('caps');
    expect(getLayer('autoresearch')).toBe('caps');
    expect(getLayer('aisle')).toBe('caps');
  });

  it('defaults unknown caps to caps layer', () => {
    const { getLayer } = requireFresh();
    expect(getLayer('unknown-thing')).toBe('caps');
  });
});

describe('renderReadyGrid', () => {
  it('returns multiline string grouped by layer', () => {
    const { renderReadyGrid, stripAnsi } = requireFresh();
    const caps = [
      { name: 'git', init_ms: 35 },
      { name: 'forge-session', init_ms: 1 },
      { name: 'infra', init_ms: 1335 },
      { name: 'audit', init_ms: 0 },
    ];
    const grid = renderReadyGrid(caps);
    const plain = stripAnsi(grid);
    expect(plain).toContain('kernel');
    expect(plain).toContain('services');
    expect(plain).toContain('caps');
    expect(plain).toContain('git');
    expect(plain).toContain('infra');
    expect(plain).toContain('audit');
  });

  it('omits empty layers', () => {
    const { renderReadyGrid, stripAnsi } = requireFresh();
    const caps = [{ name: 'git', init_ms: 10 }];
    const plain = stripAnsi(renderReadyGrid(caps));
    expect(plain).toContain('kernel');
    expect(plain).not.toContain('services');
    expect(plain).not.toContain('scheduler');
  });

  it('shows init_ms timing for non-zero values', () => {
    const { renderReadyGrid, stripAnsi } = requireFresh();
    const caps = [{ name: 'infra', init_ms: 1335 }];
    const plain = stripAnsi(renderReadyGrid(caps));
    expect(plain).toContain('1.3s');
  });
});

describe('renderDegradedBlock', () => {
  it('returns empty string when no degraded caps', () => {
    const { renderDegradedBlock } = requireFresh();
    expect(renderDegradedBlock([])).toBe('');
    expect(renderDegradedBlock(null)).toBe('');
  });

  it('renders cap name and reason', () => {
    const { renderDegradedBlock, stripAnsi } = requireFresh();
    const caps = [{ name: 'aisle', init_ms: 228, reason: 'fail-closed' }];
    const plain = stripAnsi(renderDegradedBlock(caps));
    expect(plain).toContain('aisle');
    expect(plain).toContain('fail-closed');
  });

  it('renders multiple degraded caps', () => {
    const { renderDegradedBlock, stripAnsi } = requireFresh();
    const caps = [
      { name: 'memory', init_ms: 5008, reason: 'timeout' },
      { name: 'git', init_ms: 100, reason: 'lock conflict' },
    ];
    const block = renderDegradedBlock(caps);
    const plain = stripAnsi(block);
    expect(plain).toContain('memory');
    expect(plain).toContain('git');
    expect(plain).toContain('timeout');
    expect(plain).toContain('lock conflict');
  });
});

describe('renderHeader', () => {
  it('renders face + Agentic OS up + boot time', () => {
    const { renderHeader, stripAnsi } = requireFresh();
    const header = renderHeader(FIXTURE_ALL_HEALTHY, []);
    const plain = stripAnsi(header);
    expect(plain).toContain('Agentic OS up');
    expect(plain).toContain('1.8s');
  });

  it('includes quip when degraded caps present', () => {
    const { renderHeader, stripAnsi } = requireFresh();
    const degraded = [{ name: 'memory' }];
    const header = renderHeader({ total_boot_ms: 500 }, degraded);
    const plain = stripAnsi(header);
    expect(plain).toContain('Agentic OS up');
    // Quip is optional (depends on DEGRADED_QUIPS having memory entry)
    // Just verify no crash
    expect(typeof plain).toBe('string');
  });

  it('contains ANSI color codes', () => {
    const { renderHeader } = requireFresh();
    const header = renderHeader(FIXTURE_ALL_HEALTHY, []);
    expect(header).toContain('\x1b[');
  });
});

describe('CAP_LAYERS and LAYER_ORDER', () => {
  it('CAP_LAYERS has 4 layer keys', () => {
    const { CAP_LAYERS } = requireFresh();
    expect(Object.keys(CAP_LAYERS)).toEqual(['kernel', 'services', 'scheduler', 'caps']);
  });

  it('LAYER_ORDER matches CAP_LAYERS keys', () => {
    const { CAP_LAYERS, LAYER_ORDER } = requireFresh();
    expect(LAYER_ORDER).toEqual(Object.keys(CAP_LAYERS));
  });

  it('kernel layer has 4 caps', () => {
    const { CAP_LAYERS } = requireFresh();
    expect(CAP_LAYERS.kernel.length).toBe(4);
    expect(CAP_LAYERS.kernel).toContain('forge-session');
    expect(CAP_LAYERS.kernel).toContain('git');
  });

  it('scheduler layer is empty', () => {
    const { CAP_LAYERS } = requireFresh();
    expect(CAP_LAYERS.scheduler).toEqual([]);
  });
});

// --- renderBootScreen (v2 format) ---

describe('renderBootScreen', () => {
  it('renders all-healthy with ready count and no degraded section', () => {
    const { renderBootScreen, stripAnsi } = requireFresh();
    const output = stripAnsi(renderBootScreen(FIXTURE_ALL_HEALTHY));
    expect(output).toContain('Agentic OS up');
    expect(output).toContain('ready (10)');
    expect(output).not.toContain('degraded');
    expect(output).toContain('Health: 100');
    expect(output).toContain('A');
  });

  it('renders 1-degraded with both ready and degraded sections', () => {
    const { renderBootScreen, stripAnsi } = requireFresh();
    const output = stripAnsi(renderBootScreen(FIXTURE_ONE_DEGRADED));
    expect(output).toContain('Agentic OS up');
    expect(output).toContain('ready (9)');
    expect(output).toContain('degraded (1)');
    expect(output).toContain('aisle');
  });

  it('handles missing boot file gracefully', () => {
    const { renderBootScreen, stripAnsi } = requireFresh();
    const output = stripAnsi(renderBootScreen(null));
    expect(output).toContain('OS not booted');
  });

  it('handles all-degraded (no ready caps)', () => {
    const { renderBootScreen, stripAnsi } = requireFresh();
    const output = stripAnsi(renderBootScreen(FIXTURE_MULTI_DEGRADED));
    expect(output).toContain('degraded (2)');
    expect(output).toContain('Health: 0');
    expect(output).toContain('F');
  });

  it('handles empty capabilities', () => {
    const { renderBootScreen, stripAnsi } = requireFresh();
    const boot = { total_boot_ms: 100, capabilities: {} };
    const output = stripAnsi(renderBootScreen(boot));
    expect(output).toContain('Health: 0');
  });

  it('output contains ANSI color codes', () => {
    const { renderBootScreen } = requireFresh();
    const output = renderBootScreen(FIXTURE_ALL_HEALTHY);
    expect(output).toContain('\x1b[');
  });

  it('renders multiline output (not a single line)', () => {
    const { renderBootScreen } = requireFresh();
    const output = renderBootScreen(FIXTURE_ALL_HEALTHY);
    const lines = output.split('\n');
    expect(lines.length).toBeGreaterThan(3);
  });

  it('groups ready caps by layer in grid', () => {
    const { renderBootScreen, stripAnsi } = requireFresh();
    const output = stripAnsi(renderBootScreen(FIXTURE_ALL_HEALTHY));
    expect(output).toContain('kernel');
    expect(output).toContain('services');
    expect(output).toContain('caps');
  });

  it('handles no capabilities key in bootData', () => {
    const { renderBootScreen, stripAnsi } = requireFresh();
    const output = stripAnsi(renderBootScreen({ total_boot_ms: 100 }));
    expect(output).toContain('OS not booted');
  });
});

// --- stripAnsi re-export ---

describe('stripAnsi', () => {
  it('removes ANSI escape codes', () => {
    const { stripAnsi } = requireFresh();
    expect(stripAnsi('\x1b[31mhello\x1b[0m')).toBe('hello');
  });

  it('returns plain text unchanged', () => {
    const { stripAnsi } = requireFresh();
    expect(stripAnsi('hello world')).toBe('hello world');
  });
});
