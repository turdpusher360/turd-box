'use strict';

/**
 * whats-new.cjs — SessionStart hook
 *
 * Shows changelog for the current version on first load after a version bump.
 * Compares plugin.json version to a stored last-seen version in CLAUDE_PLUGIN_DATA.
 * Prints the relevant changelog section to stdout so Claude sees it.
 */

const _selfDestruct = setTimeout(() => process.exit(0), 30000);
_selfDestruct.unref();

const fs = require('fs');
const path = require('path');

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT;
if (!PLUGIN_ROOT) process.exit(0);

const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA || path.join(PLUGIN_ROOT, '.data');
const STATE_FILE = path.join(DATA_DIR, 'last-seen-version');
const PLUGIN_JSON = path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json');
const CHANGELOG = path.join(PLUGIN_ROOT, 'CHANGELOG.md');

// Read current version
let currentVersion;
try {
  currentVersion = JSON.parse(fs.readFileSync(PLUGIN_JSON, 'utf8')).version;
} catch {
  process.exit(0); // Can't read version, skip silently
}

if (!currentVersion) process.exit(0);

// Read last-seen version
let lastSeen = null;
try {
  lastSeen = fs.readFileSync(STATE_FILE, 'utf8').trim();
} catch {
  // First run or file missing — show changelog
}

// If versions match, nothing new
if (lastSeen === currentVersion) process.exit(0);

// Extract the changelog section for this version
let section = '';
try {
  const changelog = fs.readFileSync(CHANGELOG, 'utf8');
  // Match ## [version] through the next ## [ or end of file
  const versionEscaped = currentVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Find the section start, then grab everything until the next ## [ header
  const startPattern = new RegExp(`^## \\[${versionEscaped}\\]`, 'm');
  const startMatch = changelog.match(startPattern);
  if (startMatch) {
    const startIdx = startMatch.index;
    const rest = changelog.slice(startIdx + startMatch[0].length);
    const nextSection = rest.search(/\n## \[/);
    const sectionBody = nextSection === -1 ? rest : rest.slice(0, nextSection);
    section = (startMatch[0] + sectionBody).trim();
  }
} catch {
  // No changelog, just note the version bump
}

// Output
if (section) {
  // Truncate to ~40 lines to avoid flooding session start
  const lines = section.split('\n');
  const truncated = lines.length > 40;
  const output = truncated ? lines.slice(0, 40).join('\n') + '\n...' : section;
  process.stdout.write(`\n[4ge] Updated to v${currentVersion}\n\n${output}\n\nFull changelog: /releases\n`);
} else {
  process.stdout.write(`[4ge] Updated to v${currentVersion}\n`);
}

// Save current version
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, currentVersion);
} catch {
  // Non-fatal — will show again next session
}
