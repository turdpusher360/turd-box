import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// S539 HARD (native-picker-for-menus): any plugin surface that instructs an
// Action Menu or shows a `> _` interactive prompt must also carry the picker
// delivery rule, so a session following the skill never renders a text menu
// as the interactive surface. Relationship test — no pinned file counts; a
// new menu-instructing file without the rule fails here by construction.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '..');
const SCAN_ROOTS = ['commands', 'skills'].map((d) => path.join(PLUGIN_ROOT, d));

const MENU_SIGNS = [/\(Action Menu\)/, /^> _/m];
const RULE_MARKS = [/AskUserQuestion picker/, /Delivery rule \(HARD\)/];

function mdFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...mdFiles(p));
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(p);
  }
  return out;
}

describe('S539 picker delivery rule coverage', () => {
  const all = SCAN_ROOTS.flatMap((r) => (fs.existsSync(r) ? mdFiles(r) : []));
  const menuInstructing = all.filter((f) => {
    const body = fs.readFileSync(f, 'utf8');
    return MENU_SIGNS.some((re) => re.test(body));
  });

  it('finds at least one menu-instructing surface (walk sanity)', () => {
    expect(menuInstructing.length).toBeGreaterThan(0);
  });

  it.each(menuInstructing.map((f) => [path.relative(PLUGIN_ROOT, f), f]))(
    '%s carries the S539 picker delivery rule',
    (_rel, file) => {
      const body = fs.readFileSync(file, 'utf8');
      for (const re of RULE_MARKS) {
        expect(body).toMatch(re);
      }
    }
  );
});
