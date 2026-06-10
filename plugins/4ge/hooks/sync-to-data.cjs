#!/usr/bin/env node
/**
 * SessionStart hook: sync plugin code from CLAUDE_PLUGIN_ROOT to CLAUDE_PLUGIN_DATA.
 *
 * This is the ONE hook that must reference ${CLAUDE_PLUGIN_ROOT} in hooks.json.
 * It copies hooks/, lib/, and bin/ to the stable data directory so that all
 * hooks survive mid-session version bumps (PLUGIN_ROOT GC).
 *
 * Runs first in the SessionStart array. Skips gracefully if either env var is unset.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
const pluginData = process.env.CLAUDE_PLUGIN_DATA;

if (!pluginRoot || !pluginData) {
  process.stderr.write('[sync-to-data] CLAUDE_PLUGIN_ROOT or CLAUDE_PLUGIN_DATA unset — skipping\n');
  process.exit(0);
}

// Directories to sync: hooks (executed), lib (required by hooks), bin (required by hud-reactive)
const SYNC_DIRS = ['hooks', 'lib', 'bin'];

function syncDir(subdir) {
  const srcDir = path.join(pluginRoot, subdir);
  const dstDir = path.join(pluginData, subdir);

  if (!fs.existsSync(srcDir)) return 0;
  fs.mkdirSync(dstDir, { recursive: true });

  const files = fs.readdirSync(srcDir).filter(f => f.endsWith('.cjs') || f.endsWith('.json'));
  let copied = 0;

  for (const file of files) {
    const src = path.join(srcDir, file);
    const dst = path.join(dstDir, file);

    // Skip directories (only sync flat files per subdir)
    if (fs.statSync(src).isDirectory()) continue;

    let needsCopy = false;
    if (!fs.existsSync(dst)) {
      needsCopy = true;
    } else {
      needsCopy = fs.statSync(src).mtimeMs > fs.statSync(dst).mtimeMs;
    }

    if (needsCopy) {
      fs.copyFileSync(src, dst);
      copied++;
    }
  }

  return copied;
}

/**
 * Recursive sync for the vendored Agentic OS tree (plugins/4ge/vendor/).
 * [D3] The vendor tree is nested (vendor/lib/os/kernel/...), so the
 * flat-file syncDir above cannot carry it. mtime-gated like syncDir.
 */
function syncVendorTree(relDir) {
  const srcDir = path.join(pluginRoot, relDir);
  const dstDir = path.join(pluginData, relDir);
  if (!fs.existsSync(srcDir)) return 0;
  fs.mkdirSync(dstDir, { recursive: true });

  let copied = 0;
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, entry.name);
    const dst = path.join(dstDir, entry.name);
    if (entry.isDirectory()) {
      copied += syncVendorTree(path.join(relDir, entry.name));
    } else if (entry.isFile()) {
      const needsCopy = !fs.existsSync(dst)
        || fs.statSync(src).mtimeMs > fs.statSync(dst).mtimeMs;
      if (needsCopy) {
        fs.copyFileSync(src, dst);
        copied++;
      }
    }
  }
  return copied;
}

try {
  let totalCopied = 0;
  for (const dir of SYNC_DIRS) {
    totalCopied += syncDir(dir);
  }
  totalCopied += syncVendorTree('vendor');

  if (totalCopied > 0) {
    process.stderr.write(`[sync-to-data] Synced ${totalCopied} file(s) across ${SYNC_DIRS.join('/')}/vendor to plugin data dir\n`);
  }
} catch (err) {
  process.stderr.write(`[sync-to-data] Error: ${err.message}\n`);
}

process.exit(0);
