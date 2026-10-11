import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// session-tasking skill contract + behavior. The picker template keeps its DOM-free helpers in a
// delimited block so they run here under vm without a browser; the renderer is plain Node; the
// page wiring (counts, select all/none, chips, search, generate, clipboard fallback) runs the real
// template script inside jsdom. Relationship assertions only — no pinned counts.

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(HERE, '..', 'skills', 'session-tasking');
const read = (rel) => fs.readFileSync(path.join(SKILL_DIR, rel), 'utf8');
const { render, validateRows, escJs } = require(path.join(SKILL_DIR, 'assets', 'render-picker.cjs'));
// jsdom is a claude-commander devDependency (CI installs it with `npm ci --prefix claude-commander`);
// the root package carries no DOM implementation, so resolve it from that package.
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
function loadJsdom() {
  try {
    return require(require.resolve('jsdom', { paths: [path.join(REPO_ROOT, 'claude-commander')] }));
  } catch (e) {
    throw new Error(`session-tasking page tests need jsdom from claude-commander — run \`npm ci --prefix claude-commander --legacy-peer-deps --ignore-scripts\` (${e.message})`);
  }
}
const { JSDOM } = loadJsdom();

const skill = read('SKILL.md');
const template = read('assets/picker-template.html');
const contract = read('references/teammate-contract.md');

function coreHelpers() {
  const m = template.match(/\/\/ @core-begin[^\n]*\n([\s\S]*?)\/\/ @core-end/);
  expect(m, 'template must carry the @core-begin/@core-end helper block').not.toBeNull();
  const ctx = {};
  vm.runInNewContext(`${m[1]}\nthis.h = { esc, cleanId, buildRunList, buildOneLine, rowVisible };`, ctx);
  return ctx.h;
}

const count = (hay, needle) => hay.split(needle).length - 1;

describe('session-tasking skill contract', () => {
  it('SKILL.md carries name + description frontmatter and no model pin', () => {
    const fm = skill.match(/^---\n([\s\S]*?)\n---/);
    expect(fm).not.toBeNull();
    expect(fm[1]).toMatch(/^name: session-tasking$/m);
    expect(fm[1]).toMatch(/^description: >-$/m);
    expect(fm[1]).not.toMatch(/^model:/m);
  });

  it('SKILL.md binds the rig defaults and names only hook-approved teammate types', () => {
    expect(skill).toMatch(/Delivery rule \(HARD\)/);
    expect(skill).toMatch(/AskUserQuestion picker/);
    expect(skill).toMatch(/_runs\/<YYYY-MM-DD>\/session-tasking-<NN>\//);
    expect(skill).toMatch(/\/4ge:usage/);
    expect(skill).toMatch(/render-picker\.cjs/);
    // Each named type must be a real, hook-approved agent: a .claude/agents/<name>.md file that
    // enforce-approved-agents.cjs lists (its getApprovedAgents export sits behind a require.main guard).
    const { getApprovedAgents } = require(path.join(REPO_ROOT, '.claude', 'hooks', 'enforce-approved-agents.cjs'));
    const approved = new Set(getApprovedAgents().map((a) => a.name));
    for (const agent of ['sonnet-execute', 'sonnet-research', 'opus-review']) {
      expect(skill).toContain(agent);
      expect(contract).toContain(agent);
      expect(fs.existsSync(path.join(REPO_ROOT, '.claude', 'agents', `${agent}.md`)), `${agent}.md exists`).toBe(true);
      expect(approved.has(agent), `${agent} hook-approved`).toBe(true);
    }
    expect(approved.has('Explore')).toBe(false);
    // Harness pseudo-types are denied by enforce-approved-agents.cjs (no .claude/agents file).
    for (const doc of [skill, contract]) {
      expect(doc).not.toMatch(/`Explore`/);
    }
  });

  it('SKILL.md documents both paste-back forms', () => {
    expect(skill).toMatch(/^RUN LIST — approved \(N run \/ M skipped\)$/m);
    expect(skill).toMatch(/^RUN LIST: \/item-id; /m);
  });

  it('teammate contract keeps the no-spawn, stage-only, no-secrets and basename bans', () => {
    expect(contract).toMatch(/Do NOT call the Agent, Task, or Workflow tools/);
    expect(contract).toMatch(/STAGE-ONLY/);
    expect(contract).toMatch(/Never read or print secret values/);
    expect(contract).toMatch(/REPORT, SUMMARY, FINDINGS or ANALYSIS/);
    expect(contract).toMatch(/not model selectors/);
  });
});

describe('picker template', () => {
  it('keeps the three placeholders, both copy buttons, and never touches browser storage', () => {
    for (const ph of ['__TITLE__', '__SUBTITLE__', '__DATA__']) expect(template).toContain(ph);
    expect(template).toMatch(/id="copy1"/);
    expect(template).toMatch(/id="copy-status"/);
    expect(template).not.toMatch(/localStorage\s*\.|sessionStorage\s*\./);
  });

  it('awaits the clipboard promise and falls back to execCommand on rejection', () => {
    expect(template).toMatch(/async function copyText/);
    expect(template).toMatch(/await navigator\.clipboard\.writeText/);
    expect(template).toMatch(/document\.execCommand\("copy"\)/);
  });

  it('escapes HTML in row fields', () => {
    const { esc } = coreHelpers();
    expect(esc('<b>&"x\'')).toBe('&lt;b&gt;&amp;&quot;x&#39;');
    expect(esc(null)).toBe('');
  });

  it('strips only the paste-back delimiters from ids; ordinary internal whitespace round-trips', () => {
    const { cleanId } = coreHelpers();
    expect(cleanId('/a;b\r\nc  d')).toBe('/a b c  d');
    expect(cleanId('/a\u2028b\u2029c')).toBe('/a b c');
    expect(cleanId('  /4ge:dfe  ')).toBe('/4ge:dfe');
    // An id is the exact runnable identifier: a quoted argument keeps its double space, a tab survives.
    expect(cleanId('/cmd --label "a  b"')).toBe('/cmd --label "a  b"');
    expect(cleanId('src/a\tb.ts')).toBe('src/a\tb.ts');
  });

  it('emits the multi-line and one-line run-list grammars the skill parses', () => {
    const { buildRunList, buildOneLine } = coreHelpers();
    expect(buildRunList(['/a', '/b [x]'], 5)).toBe('RUN LIST — approved (2 run / 3 skipped)\nRUN (2):\n/a\n/b [x]');
    expect(buildOneLine(['/a', '/b [x]'])).toBe('RUN LIST: /a; /b [x]');
    // Cleaned ids can never re-split either grammar.
    const { cleanId } = coreHelpers();
    const hostileIds = ['/a;b', '/c\r\nd', '/e\u2028f\u2029g'].map(cleanId);
    expect(buildOneLine(hostileIds).split(';')).toHaveLength(hostileIds.length);
    expect(buildRunList(hostileIds, 9).split(/[\r\n\u2028\u2029]/)).toHaveLength(2 + hostileIds.length);
    expect(buildRunList([], 3)).toBe('RUN LIST — approved (0 run / 3 skipped)\nRUN (0):\n');
  });

  it('filters by chip, selection, and query', () => {
    const { rowVisible } = coreHelpers();
    expect(rowVisible('na', false, 'all', '', 'x')).toBe(true);
    expect(rowVisible('yes', false, 'sel', '', 'x')).toBe(false);
    expect(rowVisible('yes', true, 'sel', '', 'x')).toBe(true);
    expect(rowVisible('maybe', true, 'yes', '', 'x')).toBe(false);
    expect(rowVisible('yes', true, 'yes', 'zzz', '/4ge:dfe review')).toBe(false);
    expect(rowVisible('yes', true, 'all', 'dfe', '/4ge:dfe review')).toBe(true);
  });
});

describe('render-picker.cjs', () => {
  const rows = [
    ['Review', '/4ge:dfe', 'six-pass review of the diff', 'yes'],
    ['Review', '/4ge:audit', 'quality audit', 'maybe', 'needs a target'],
    ['Fixes', 'P0-1', 'patch the auth bug', 'na', 'dupe'],
  ];

  it('substitutes every placeholder and keeps "$&" sequences literal', () => {
    const html = render({ title: 'Sweep $& run', subtitle: 'pick', rows });
    for (const ph of ['__TITLE__', '__SUBTITLE__', '__DATA__']) expect(html).not.toContain(ph);
    expect(html).toContain('<title>Sweep $&amp; run</title>');
    expect(html).toContain('<h1>Sweep $&amp; run</h1>');
    expect(html).toContain('"/4ge:dfe"');
  });

  it('keeps literal placeholder text inside a title or a row (one pass, no rescans)', () => {
    const tricky = [['G', '/x', 'desc with __TITLE__ and __DATA__ inside', 'yes']];
    const html = render({ title: '__DATA__ & __TITLE__', subtitle: '__SUBTITLE__', rows: tricky });
    expect(html).toContain('<title>__DATA__ &amp; __TITLE__</title>');
    expect(html).toContain('<p>__SUBTITLE__</p>');
    expect(count(html, 'const DATA = ')).toBe(1);
    const literal = html.match(/const DATA = (\[.*?\]);\n/s)[1];
    expect(JSON.parse(literal)).toEqual(tricky);
  });

  it('HTML-escapes the title and subtitle', () => {
    const html = render({ title: '<b>x</b>', subtitle: 'a "q" & b', rows });
    expect(html).not.toContain('<b>x</b>');
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(html).toContain('a &quot;q&quot; &amp; b');
  });

  it('never lets a row close the script block or break the JS parse', () => {
    const hostile = [
      ['G', '/x', 'desc with </script><script>alert(1)</script> inside', 'yes'],
      ['G', '/y', 'line\u2028terminators\u2029here <!-- and comments', 'maybe'],
    ];
    const html = render({ title: 't', subtitle: 's', rows: hostile });
    expect(count(html, '</script>')).toBe(count(template, '</script>'));
    expect(html).not.toContain('\u2028');
    expect(html).not.toContain('\u2029');
    expect(html).toContain('\\u003c/script\\u003e');
    // The escaped literal still parses back to the original rows.
    const literal = html.match(/const DATA = (\[.*?\]);\n/s)[1];
    expect(JSON.parse(literal)).toEqual(hostile);
  });

  it('rejects malformed rows and delimiter-bearing ids', () => {
    expect(() => validateRows([])).toThrow(/non-empty/);
    expect(() => validateRows([['G', '/x', 'd', 'sometimes']])).toThrow(/tag must be/);
    expect(() => validateRows([['G', '/a;b', 'd', 'yes']])).toThrow(/paste-back delimiters/);
    expect(() => validateRows([['G', '/a\nb', 'd', 'yes']])).toThrow(/paste-back delimiters/);
    expect(() => validateRows([['G', '/a\u2028b', 'd', 'yes']])).toThrow(/U\+2028/);
    expect(() => validateRows([['G', '/a\u2029b', 'd', 'yes']])).toThrow(/U\+2029/);
    expect(() => validateRows([['G', '', 'd', 'yes']])).toThrow(/id must be/);
    expect(() => validateRows([['G', '/x', 'd', 'yes', 42]])).toThrow(/warn must be/);
  });

  it('escJs covers the four characters that matter inside <script>', () => {
    expect(escJs('a<b>c&d')).toBe('a\\u003cb\\u003ec\\u0026d');
  });
});

describe('picker page behavior (template script under jsdom)', () => {
  const PAGE_ROWS = [
    ['Review', '/4ge:dfe', 'six-pass review', 'yes'],
    ['Review', '/4ge:audit', 'quality audit', 'maybe', 'needs a target'],
    ['Review', '/4ge:tour', 'walk the plugin', 'na'],
    ['Fixes', 'P0-1', 'patch the auth bug', 'yes'],
    ['Fixes', 'P1-4', 'tidy the hud', 'na', 'dupe'],
  ];
  const YES = PAGE_ROWS.filter((r) => r[3] === 'yes').map((r) => r[1]);
  const tick = () => new Promise((r) => setTimeout(r, 0));

  function page({ clipboard, execCommand, rows: pageRows = PAGE_ROWS } = {}) {
    const html = render({ title: 'Sweep', subtitle: 'pick', rows: pageRows });
    const dom = new JSDOM(html, {
      runScripts: 'dangerously',
      beforeParse(window) {
        Object.defineProperty(window.navigator, 'clipboard', { value: clipboard, configurable: true });
        window.document.execCommand = execCommand ?? (() => { throw new Error('execCommand unavailable'); });
      },
    });
    const d = dom.window.document;
    const $ = (sel) => d.querySelector(sel);
    const rows = (sel = '.row') => [...d.querySelectorAll(sel)];
    const visibleIds = () => rows('.row:not(.hid)').map((r) => r.dataset.id);
    const checkedIds = () => rows().filter((r) => r.querySelector('input').checked).map((r) => r.dataset.id);
    const fire = (el, type) => el.dispatchEvent(new dom.window.Event(type, { bubbles: true }));
    return { d, $, rows, visibleIds, checkedIds, fire };
  }

  it('renders every row in its group, pre-checks the yes rows, and counts them', () => {
    const { d, $, rows, checkedIds } = page();
    expect(rows()).toHaveLength(PAGE_ROWS.length);
    expect(d.querySelectorAll('section')).toHaveLength(new Set(PAGE_ROWS.map((r) => r[0])).size);
    expect(checkedIds()).toEqual(YES);
    expect($('#sel-count').textContent).toBe(`${YES.length} selected`);
    expect($('#hdr-count').textContent).toContain(`${PAGE_ROWS.length} items total`);
    expect($('#hdr-count').textContent).toContain(`${YES.length} selected`);
    expect($('.row[data-id="/4ge:audit"] .warn').textContent).toContain('needs a target');
  });

  it('a checkbox change re-counts', () => {
    const { $, fire, checkedIds } = page();
    const box = $('.row[data-id="/4ge:audit"] input');
    box.checked = true; fire(box, 'change');
    expect(checkedIds()).toEqual([...YES.slice(0, 1), '/4ge:audit', ...YES.slice(1)]);
    expect($('#sel-count').textContent).toBe(`${YES.length + 1} selected`);
    box.checked = false; fire(box, 'change');
    expect($('#sel-count').textContent).toBe(`${YES.length} selected`);
  });

  it('section select all / none touch only that section and only its visible rows', () => {
    const { d, $, checkedIds } = page();
    const review = d.querySelector('section');
    review.querySelector('[data-act="none"]').click();
    expect(checkedIds()).toEqual(['P0-1']);
    expect($('#sel-count').textContent).toBe('1 selected');
    review.querySelector('[data-act="all"]').click();
    expect(checkedIds()).toEqual(['/4ge:dfe', '/4ge:audit', '/4ge:tour', 'P0-1']);
    expect($('#sel-count').textContent).toBe('4 selected');
    // With the "Unlikely" chip active only the na rows are visible, so "select none" spares the rest.
    $('.chip[data-f="na"]').click();
    review.querySelector('[data-act="none"]').click();
    expect(checkedIds()).toEqual(['/4ge:dfe', '/4ge:audit', 'P0-1']);
  });

  it('chips and the search box hide rows and empty sections', () => {
    const { d, $, fire, visibleIds } = page();
    $('.chip[data-f="sel"]').click();
    expect(visibleIds()).toEqual(YES);
    $('.chip[data-f="maybe"]').click();
    expect(visibleIds()).toEqual(['/4ge:audit']);
    expect([...d.querySelectorAll('section')].map((s) => s.classList.contains('hid'))).toEqual([false, true]);
    $('.chip[data-f="all"]').click();
    const q = $('#q'); q.value = 'AUTH'; fire(q, 'input');
    expect(visibleIds()).toEqual(['P0-1']);
    q.value = ''; fire(q, 'input');
    expect(visibleIds()).toHaveLength(PAGE_ROWS.length);
  });

  it('Generate emits the multi-line grammar from the checked rows and shows the output box', () => {
    const { $ } = page();
    $('#gen').click();
    expect($('#out').value).toBe(`RUN LIST — approved (${YES.length} run / ${PAGE_ROWS.length - YES.length} skipped)\nRUN (${YES.length}):\n${YES.join('\n')}`);
    expect($('#out-wrap').style.display).toBe('block');
    $('#close').click();
    expect($('#out-wrap').style.display).toBe('none');
  });

  it('escapes hostile row data at the live DOM sinks: no injected elements, one script, intact ids', () => {
    // Payloads aimed at the four innerHTML sinks (group h2, id code, desc, warn). A regression that
    // drops esc() on any of them would materialise an <img>/<script>/<b> element or split the run list.
    const HOSTILE = [
      ['</script><img src=x onerror="hit()">&"\'', 'P0-<b>x</b>&"\'', '</script><img src=x onerror="hit()"> & "quotes" <i>tag</i>', 'yes', '<script>hit()</script> & "warn"'],
      ['</script><img src=x onerror="hit()">&"\'', 'P1-plain', 'plain', 'na'],
    ];
    const { d, $, rows } = page({ rows: HOSTILE });
    expect(d.querySelectorAll('script')).toHaveLength(1); // only the template's own script block
    expect(d.querySelectorAll('img, [onerror]')).toHaveLength(0);
    expect(d.querySelectorAll('section b, section i')).toHaveLength(0); // the hint <b> outside the sections is the template's own
    expect(rows()).toHaveLength(HOSTILE.length);
    expect(d.querySelector('section h2').textContent).toBe(HOSTILE[0][0]);
    const first = rows()[0];
    expect(first.querySelector('code').textContent).toBe(HOSTILE[0][1]);
    expect(first.querySelector('.desc').textContent).toBe(HOSTILE[0][2]);
    expect(first.querySelector('.warn').textContent).toContain(HOSTILE[0][4]);
    expect(first.dataset.id).toBe(HOSTILE[0][1]);
    $('#gen').click();
    expect($('#out').value).toBe(`RUN LIST — approved (1 run / 1 skipped)\nRUN (1):\n${HOSTILE[0][1]}`);
  });

  it('Copy one-line uses the async clipboard when it resolves', async () => {
    const writeText = vi.fn(async () => {});
    const { $ } = page({ clipboard: { writeText } });
    $('#gen').click(); $('#copy1').click();
    await tick(); await tick();
    expect(writeText).toHaveBeenCalledWith(`RUN LIST: ${YES.join('; ')}`);
    expect($('#out').value).toBe(`RUN LIST: ${YES.join('; ')}`);
    expect($('#copy-status').textContent).toBe('Copied.');
  });

  it('falls back to execCommand when the clipboard promise rejects', async () => {
    const execCommand = vi.fn(() => true);
    const { $ } = page({ clipboard: { writeText: async () => { throw new Error('denied'); } }, execCommand });
    $('#gen').click(); $('#copy').click();
    await tick(); await tick();
    expect(execCommand).toHaveBeenCalledWith('copy');
    expect($('#copy-status').textContent).toBe('Copied.');
  });

  it('reports the block and leaves the text in the box when both paths fail', async () => {
    const { $ } = page({ clipboard: { writeText: async () => { throw new Error('denied'); } }, execCommand: () => false });
    $('#gen').click(); $('#copy1').click();
    await tick(); await tick();
    expect($('#copy-status').textContent).toMatch(/^Clipboard blocked/);
    expect($('#out').value).toBe(`RUN LIST: ${YES.join('; ')}`);
    expect($('#out-wrap').style.display).toBe('block');
    // The requirement is that the text stays SELECTED for a manual copy, not merely present.
    expect($('#out').selectionStart).toBe(0);
    expect($('#out').selectionEnd).toBe($('#out').value.length);
  });

  it('survives a page with no clipboard API at all', async () => {
    const { $ } = page();
    $('#gen').click(); $('#copy').click();
    await tick(); await tick();
    expect($('#copy-status').textContent).toMatch(/^Clipboard blocked/);
    expect($('#out').value).toMatch(/^RUN LIST — approved/);
  });
});
