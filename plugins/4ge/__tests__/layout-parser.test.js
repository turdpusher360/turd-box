import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const fs = require('fs');

const { parseLayout, validateLayout, listLayouts, VALID_TOPOLOGIES } = require('../lib/layout-parser.cjs');

describe('layout-parser', () => {
  beforeEach(() => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readdirSync').mockReturnValue([]);
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('parses a simple YAML layout', () => {
    const yaml = `
name: writer-reviewer
topology: paired
teammates:
  - name: writer
    agent: sonnet-execute
    scope:
      - src/
  - name: reviewer
    agent: opus-review
    scope:
      - src/
`;
    const layout = parseLayout(yaml);
    expect(layout.name).toBe('writer-reviewer');
    expect(layout.topology).toBe('paired');
    expect(layout.teammates).toHaveLength(2);
    expect(layout.teammates[0].name).toBe('writer');
  });

  it('validates topology values', () => {
    const layout = { name: 'test', topology: 'star', teammates: [{ name: 'a', agent: 'impl' }] };
    const errors = validateLayout(layout);
    expect(errors).toEqual([]);
  });

  it('rejects invalid topology', () => {
    const layout = { name: 'test', topology: 'mesh', teammates: [{ name: 'a', agent: 'impl' }] };
    const errors = validateLayout(layout);
    expect(errors.some(e => e.includes('topology'))).toBe(true);
  });

  it('rejects layout without teammates', () => {
    const layout = { name: 'test', topology: 'star', teammates: [] };
    const errors = validateLayout(layout);
    expect(errors.some(e => e.includes('teammate'))).toBe(true);
  });

  it('lists available layouts from directory', () => {
    fs.readdirSync.mockReturnValue(['writer-reviewer.yaml', 'star-audit.yaml', 'pipeline-build.yaml']);
    const layouts = listLayouts('/fake/layouts');
    expect(layouts).toHaveLength(3);
    expect(layouts).toContain('writer-reviewer');
  });

  it('contains all valid topologies', () => {
    expect(VALID_TOPOLOGIES).toContain('hierarchical');
    expect(VALID_TOPOLOGIES).toContain('star');
    expect(VALID_TOPOLOGIES).toContain('pipeline');
    expect(VALID_TOPOLOGIES).toContain('paired');
  });
});
