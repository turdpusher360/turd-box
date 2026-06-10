// plugins/4ge/__tests__/repo-index.test.js
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const cjsRequire = createRequire(import.meta.url);
const { categorizeFile, buildIndex, formatIndex, CATEGORIES } = cjsRequire('../lib/repo-index.cjs');

describe('repo-index', () => {
  it('categorizes a .tsx file as component', () => {
    expect(categorizeFile('src/components/Button.tsx')).toBe('component');
  });

  it('categorizes a .test.js file as test', () => {
    expect(categorizeFile('plugins/4ge/__tests__/config.test.js')).toBe('test');
  });

  it('categorizes a .cjs hook file as hook', () => {
    expect(categorizeFile('.claude/hooks/guard-git-scope.cjs')).toBe('hook');
  });

  it('categorizes a .md agent file as agent', () => {
    expect(categorizeFile('.claude/agents/sonnet-execute.md')).toBe('agent');
  });

  it('categorizes API routes as api', () => {
    expect(categorizeFile('src/api/users.ts')).toBe('api');
  });

  it('builds index from file list', () => {
    const files = [
      'src/components/Button.tsx',
      'plugins/4ge/__tests__/config.test.js',
      '.claude/hooks/guard.cjs',
      'README.md',
    ];
    const index = buildIndex(files);
    expect(index.component).toContain('src/components/Button.tsx');
    expect(index.test).toContain('plugins/4ge/__tests__/config.test.js');
    expect(index.hook).toContain('.claude/hooks/guard.cjs');
  });

  it('formats index as markdown with file counts', () => {
    const index = { component: ['a.tsx', 'b.tsx'], test: ['a.test.js'] };
    const text = formatIndex(index);
    expect(text).toContain('component');
    expect(text).toContain('2 files');
  });

  it('CATEGORIES contains expected entries', () => {
    expect(CATEGORIES).toContain('component');
    expect(CATEGORIES).toContain('test');
    expect(CATEGORIES).toContain('hook');
    expect(CATEGORIES).toContain('agent');
    expect(CATEGORIES).toContain('api');
  });

  it('returns "other" for uncategorized files', () => {
    expect(categorizeFile('random.dat')).toBe('other');
  });
});
