'use strict';

const CATEGORIES = ['component', 'test', 'hook', 'agent', 'skill', 'rule', 'api', 'config', 'doc', 'script', 'other'];

const CATEGORY_PATTERNS = [
  { category: 'test', patterns: [/\.test\.[jt]sx?$/, /\.spec\.[jt]sx?$/, /__tests__\//] },
  { category: 'hook', patterns: [/\.claude\/hooks\/.*\.cjs$/, /hooks\/.*\.cjs$/] },
  { category: 'agent', patterns: [/\.claude\/agents\/.*\.md$/] },
  { category: 'skill', patterns: [/\.claude\/skills\//, /skills\/.*SKILL\.md$/] },
  { category: 'rule', patterns: [/\.claude\/rules\/.*\.md$/] },
  { category: 'api', patterns: [/\/api\//, /\/routes\//, /\/controllers?\//] },
  { category: 'component', patterns: [/\.tsx$/, /\.jsx$/, /\.vue$/, /\.svelte$/] },
  { category: 'config', patterns: [/\.json$/, /\.ya?ml$/, /\.toml$/, /\.env/] },
  { category: 'doc', patterns: [/\.md$/, /\/docs\//] },
  { category: 'script', patterns: [/\/scripts\//, /\.sh$/, /\.ps1$/] },
];

function categorizeFile(filePath) {
  for (const { category, patterns } of CATEGORY_PATTERNS) {
    if (patterns.some(p => p.test(filePath))) return category;
  }
  return 'other';
}

function buildIndex(files) {
  const index = {};
  for (const file of files) {
    const cat = categorizeFile(file);
    if (!index[cat]) index[cat] = [];
    index[cat].push(file);
  }
  return index;
}

function formatIndex(index) {
  const lines = ['## Repository Intelligence Index', ''];
  for (const [cat, files] of Object.entries(index)) {
    lines.push(`### ${cat} (${files.length} files)`);
    for (const f of files.slice(0, 10)) {
      lines.push(`  - ${f}`);
    }
    if (files.length > 10) lines.push(`  ... and ${files.length - 10} more`);
    lines.push('');
  }
  return lines.join('\n');
}

module.exports = { categorizeFile, buildIndex, formatIndex, CATEGORIES };
