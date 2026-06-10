import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const cjsRequire = createRequire(import.meta.url);
const { analyzeUsage, generateSuggestions } = cjsRequire('../lib/config-compiler.cjs');

describe('config-compiler', () => {
  it('identifies unused items from zero-count entries', () => {
    const hookTriggers = { guard_git_scope: 50, hono_patterns: 0, react_patterns: 0 };
    const analysis = analyzeUsage(hookTriggers, 'hooks');
    expect(analysis.unused).toContain('hono_patterns');
    expect(analysis.unused).toContain('react_patterns');
    expect(analysis.unused).not.toContain('guard_git_scope');
  });

  it('identifies heavy hitters from high frequency', () => {
    const toolUsage = { Bash: 500, Read: 200, Edit: 50, WebSearch: 1 };
    const analysis = analyzeUsage(toolUsage, 'tools');
    expect(analysis.heavy_hitters[0]).toBe('Bash');
  });

  it('generates removal suggestion for unused non-protected hooks', () => {
    const hookTriggers = { hono_patterns: 0, react_patterns: 0 };
    const protectedHooks = ['guard_git_scope'];
    const suggestions = generateSuggestions(hookTriggers, protectedHooks);
    expect(suggestions.some(s => s.action === 'remove' && s.target === 'hono_patterns')).toBe(true);
  });

  it('never suggests removing protected hooks even when count is zero', () => {
    const hookTriggers = { guard_git_scope: 0, guard_dns_exfil: 0 };
    const protectedHooks = ['guard_git_scope', 'guard_dns_exfil'];
    const suggestions = generateSuggestions(hookTriggers, protectedHooks);
    expect(suggestions.every(s => s.target !== 'guard_git_scope')).toBe(true);
    expect(suggestions.every(s => s.target !== 'guard_dns_exfil')).toBe(true);
  });

  it('does not suggest removal for well-used hooks', () => {
    const hookTriggers = { post_edit_typecheck: 200 };
    const suggestions = generateSuggestions(hookTriggers, []);
    expect(suggestions.filter(s => s.target === 'post_edit_typecheck')).toEqual([]);
  });

  it('handles empty usage data gracefully', () => {
    const analysis = analyzeUsage({}, 'hooks');
    expect(analysis.unused).toEqual([]);
    expect(analysis.heavy_hitters).toEqual([]);
  });

  it('suggestions include human-readable reason string', () => {
    const hookTriggers = { hono_patterns: 0 };
    const suggestions = generateSuggestions(hookTriggers, []);
    expect(suggestions[0].reason).toBeDefined();
    expect(typeof suggestions[0].reason).toBe('string');
    expect(suggestions[0].reason.length).toBeGreaterThan(0);
  });

  it('suggestions are sorted by confidence (descending)', () => {
    const hookTriggers = { hono_patterns: 0, react_patterns: 0, a11y_patterns: 1 };
    const suggestions = generateSuggestions(hookTriggers, []);
    const unusedSuggestions = suggestions.filter(s => s.action === 'remove');
    expect(unusedSuggestions).toHaveLength(2);
    for (const s of unusedSuggestions) {
      expect(s.confidence).toBeDefined();
    }
  });

  it('each suggestion has action, target, reason, confidence fields', () => {
    const hookTriggers = { hono_patterns: 0 };
    const suggestions = generateSuggestions(hookTriggers, []);
    expect(suggestions[0]).toHaveProperty('action');
    expect(suggestions[0]).toHaveProperty('target');
    expect(suggestions[0]).toHaveProperty('reason');
    expect(suggestions[0]).toHaveProperty('confidence');
  });
});
