import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';

// Use the same fs singleton as the CJS module so spies intercept its calls.
const cjsRequire = createRequire(import.meta.url);
const fs = cjsRequire('fs');
const { detectDialect, recommendAction, DIALECT_STATES } = cjsRequire('../lib/dialect-detector.cjs');

describe('dialect-detector', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    vi.spyOn(fs, 'readFileSync').mockReturnValue('{}');
  });

  it('detects fresh state when no 4ge config exists', () => {
    const result = detectDialect('/fake/project');
    expect(result.state).toBe('fresh');
    expect(result.drift).toBe(false);
  });

  it('detects configured state when .4ge/config.json exists', () => {
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
      const s = String(p);
      return s.includes('.4ge/config.json') || s.includes('.4ge\\config.json');
    });
    vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify({ version: '2.0.0', tier: 'standard' }));
    const result = detectDialect('/fake/project');
    expect(result.state).toBe('configured');
  });

  it('detects partial state when .blueprint-config.json exists but no .4ge/', () => {
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
      const s = String(p);
      return s.includes('.blueprint-config.json');
    });
    const result = detectDialect('/fake/project');
    expect(result.state).toBe('partial');
    expect(result.details.hasBlueprint).toBe(true);
  });

  it('detects drift when config version is outdated', () => {
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
      const s = String(p);
      return s.includes('.4ge/config.json') || s.includes('.4ge\\config.json');
    });
    vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify({ version: '1.0.0', tier: 'standard' }));
    const result = detectDialect('/fake/project');
    expect(result.drift).toBe(true);
    expect(result.version).toBe('1.0.0');
  });

  it('recommendAction suggests setup for fresh state', () => {
    const action = recommendAction({ state: 'fresh' });
    expect(action.command).toBe('/blueprint setup');
    expect(action.message).toContain('No 4ge configuration found');
  });

  it('recommendAction suggests update for drift', () => {
    const action = recommendAction({ state: 'configured', drift: true, version: '1.0.0' });
    expect(action.command).toBe('/blueprint update');
    expect(action.message).toContain('drift detected');
  });

  it('recommendAction suggests continue for configured+current', () => {
    const action = recommendAction({ state: 'configured', drift: false, version: '2.1.0', tier: 'standard' });
    expect(action.command).toBeNull();
    expect(action.message).toContain('up to date');
  });

  it('DIALECT_STATES contains all expected states', () => {
    expect(DIALECT_STATES).toContain('fresh');
    expect(DIALECT_STATES).toContain('partial');
    expect(DIALECT_STATES).toContain('configured');
    expect(DIALECT_STATES).toHaveLength(3);
  });
});
