#!/usr/bin/env node
/**
 * manifest-integrity.cjs — CI count gate for the public turd-box repo.
 *
 * Re-counts agents/commands/skills from DISK TRUTH in the extraction tree and
 * asserts they match the expected counts AND the manifest's own description
 * claims. Kills two failure classes: the v1.27.0 empty-agents packaging gap
 * (no manifest declares agents — CC auto-discovers them, so only a count gate
 * can catch an empty dir) and the description count-drift class.
 *
 * Run from repo root: node .github/scripts/manifest-integrity.cjs
 */
'use strict';
const fs = require('fs');
const path = require('path');

const PLUGIN = path.join('plugins', '4ge');
const EXPECT = { agents: 17, commands: 37, skills: 41 };

function countFiles(dir, predicate) {
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir, { withFileTypes: true }).filter(predicate).length;
}

const errors = [];

// Disk truth
const agents = countFiles(path.join(PLUGIN, 'agents'),
  e => e.isFile() && e.name.endsWith('.md'));
const commands = countFiles(path.join(PLUGIN, 'commands'),
  e => e.isFile() && e.name.endsWith('.md'));
const skills = countFiles(path.join(PLUGIN, 'skills'),
  e => e.isDirectory() && fs.existsSync(path.join(PLUGIN, 'skills', e.name, 'SKILL.md')));

const disk = { agents, commands, skills };
console.log('Disk truth:', JSON.stringify(disk));
console.log('Expected:  ', JSON.stringify(EXPECT));

for (const k of Object.keys(EXPECT)) {
  if (disk[k] !== EXPECT[k]) {
    errors.push(`${k}: disk=${disk[k]} expected=${EXPECT[k]}`);
  }
}

// Manifest description claims must match disk truth.
const manifests = [
  '.claude-plugin/marketplace.json',
  '.claude-plugin/plugin.json',
  path.join(PLUGIN, '.claude-plugin', 'plugin.json'),
];
for (const m of manifests) {
  const text = fs.readFileSync(m, 'utf8');
  // Find any "<n> commands" / "<n> skills" claims and verify against disk.
  const cmdClaim = text.match(/(\d+)\s+commands/);
  const skillClaim = text.match(/(\d+)\s+skills/);
  if (cmdClaim && Number(cmdClaim[1]) !== disk.commands) {
    errors.push(`${m}: claims ${cmdClaim[1]} commands, disk has ${disk.commands}`);
  }
  if (skillClaim && Number(skillClaim[1]) !== disk.skills) {
    errors.push(`${m}: claims ${skillClaim[1]} skills, disk has ${disk.skills}`);
  }
}

// Plugin.json commands{} block (if present) must match the commands dir count.
const canonical = JSON.parse(
  fs.readFileSync(path.join(PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8'));
if (canonical.commands && typeof canonical.commands === 'object') {
  const declared = Object.keys(canonical.commands).length;
  if (declared !== disk.commands) {
    errors.push(`canonical plugin.json declares ${declared} commands, dir has ${disk.commands}`);
  }
}

if (errors.length) {
  console.error('\nMANIFEST INTEGRITY FAILED:');
  for (const e of errors) console.error('  - ' + e);
  process.exit(1);
}
console.log('\nManifest integrity OK: counts match disk truth and manifest claims.');
