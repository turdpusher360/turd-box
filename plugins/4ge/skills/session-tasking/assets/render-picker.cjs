#!/usr/bin/env node
'use strict';

/**
 * render-picker.cjs — fill assets/picker-template.html without letting row data break the page.
 *
 * Usage:
 *   node render-picker.cjs --title "<title>" --subtitle "<subtitle>" --rows rows.json --out picker.html
 *
 * rows.json = [[group, id, desc, tag, warn?], ...] with tag in yes | maybe | na.
 *
 * Why a renderer instead of a hand substitution: `__DATA__` lands inside a <script> block, so a
 * row containing `</script>` (or `<!--`, or a U+2028/U+2029 line terminator, which JSON.stringify
 * leaves raw) would close the block or throw before the page runs. Title and subtitle land in
 * HTML text. Both get the right escaping here; ids are rejected when they carry the paste-back
 * delimiters (CR, LF, the U+2028/U+2029 line separators, ';').
 */

const fs = require('node:fs');
const path = require('node:path');

const TEMPLATE_PATH = path.join(__dirname, 'picker-template.html');
const TAGS = new Set(['yes', 'maybe', 'na']);
const PLACEHOLDERS = ['__TITLE__', '__SUBTITLE__', '__DATA__'];
const HTML_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

const escHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => HTML_ESC[c]);

// JSON text inside <script>: neutralise the characters that can end the block or break the parse.
const escJs = (json) => json
  .replace(/</g, '\\u003c')
  .replace(/>/g, '\\u003e')
  .replace(/&/g, '\\u0026')
  .replace(/\u2028/g, '\\u2028')
  .replace(/\u2029/g, '\\u2029');

function validateRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('rows must be a non-empty array');
  rows.forEach((row, i) => {
    if (!Array.isArray(row) || row.length < 4 || row.length > 5) {
      throw new Error(`row ${i}: expected [group, id, desc, tag, warn?]`);
    }
    const [group, id, desc, tag, warn] = row;
    for (const [name, value] of [['group', group], ['id', id], ['desc', desc]]) {
      if (typeof value !== 'string' || !value.trim()) throw new Error(`row ${i}: ${name} must be a non-empty string`);
    }
    if (!TAGS.has(tag)) throw new Error(`row ${i}: tag must be yes | maybe | na`);
    if (warn !== undefined && typeof warn !== 'string') throw new Error(`row ${i}: warn must be a string`);
    if (/[\r\n\u2028\u2029;]/.test(id)) {
      throw new Error(`row ${i}: id must not contain CR, LF, U+2028/U+2029 or ';' (paste-back delimiters)`);
    }
  });
}

function render({ title, subtitle, rows, template }) {
  validateRows(rows);
  const tpl = template ?? fs.readFileSync(TEMPLATE_PATH, 'utf8');
  for (const ph of PLACEHOLDERS) {
    if (!tpl.includes(ph)) throw new Error(`template missing ${ph}`);
  }
  // One pass with a callback: the callback's return value is inserted verbatim (no "$&" expansion),
  // and text already substituted is never rescanned, so a title containing a literal "__DATA__"
  // stays a title.
  const values = {
    __TITLE__: escHtml(title),
    __SUBTITLE__: escHtml(subtitle),
    __DATA__: escJs(JSON.stringify(rows)),
  };
  return tpl.replace(/__(?:TITLE|SUBTITLE|DATA)__/g, (ph) => values[ph]);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { out[a.slice(2)] = argv[i + 1]; i++; }
  }
  return out;
}

function main(argv) {
  const opts = parseArgs(argv);
  if (!opts.rows || !opts.out) {
    process.stderr.write('usage: render-picker.cjs --title T --subtitle S --rows rows.json --out picker.html\n');
    return 2;
  }
  const rows = JSON.parse(fs.readFileSync(opts.rows, 'utf8'));
  const html = render({ title: opts.title || 'Run list', subtitle: opts.subtitle || '', rows });
  fs.writeFileSync(opts.out, html);
  process.stderr.write(`wrote ${opts.out} (${rows.length} rows)\n`);
  return 0;
}

module.exports = { render, validateRows, escHtml, escJs, TEMPLATE_PATH };

if (require.main === module) process.exit(main(process.argv.slice(2)));
