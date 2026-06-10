'use strict';

const fs = require('fs');
const path = require('path');
const { PROTECTED_HOOKS } = require('./security-constants.cjs');

const EJECTED_FILE = '_runs/ejected-components.json';

const TYPE_MAP = {
  hook:  { pluginDir: 'hooks',  projectDir: '.claude/hooks',  ext: '.cjs' },
  skill: { pluginDir: 'skills', projectDir: '.claude/skills', ext: '' },
};

// Allowlist: component names must be alphanumeric + hyphens + underscores only.
// Prevents path traversal (CWE-22) via names like "../../.env".
const SAFE_NAME_RE = /^[a-zA-Z0-9_-]+$/;

function loadEjected(projectRoot) {
  const fp = path.join(projectRoot, EJECTED_FILE);
  try {
    const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
    if (!Array.isArray(data.ejected)) data.ejected = [];
    return data;
  } catch {
    return { ejected: [] };
  }
}

function saveEjected(projectRoot, data) {
  const fp = path.join(projectRoot, EJECTED_FILE);
  const dir = path.dirname(fp);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(data, null, 2));
}

/**
 * Eject a component from plugin management into the project.
 * @param {string} name - Component name (e.g., "forge-heartbeat")
 * @param {string} type - "hook" or "skill"
 * @param {string} projectRoot - Project root directory
 * @returns {{ ok: boolean, message: string, path?: string }}
 */
function ejectComponent(name, type, projectRoot) {
  // Validate name — block path traversal
  if (!name || !SAFE_NAME_RE.test(name)) {
    return { ok: false, message: `Invalid component name "${name}". Only alphanumeric, hyphens, and underscores allowed.` };
  }

  const mapping = TYPE_MAP[type];
  if (!mapping) {
    return { ok: false, message: `Unknown component type "${type}". Supported: ${Object.keys(TYPE_MAP).join(', ')}` };
  }

  // Protected hooks cannot be ejected
  if (type === 'hook') {
    const normalized = name.replace(/-/g, '_').replace(/\.cjs$/, '');
    if (PROTECTED_HOOKS.includes(normalized)) {
      return { ok: false, message: `"${name}" is a protected hook and cannot be ejected.` };
    }
  }

  // Resolve source path
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..');
  let srcPath, destPath;

  if (type === 'skill') {
    srcPath = path.join(pluginRoot, mapping.pluginDir, name, 'SKILL.md');
    destPath = path.join(projectRoot, mapping.projectDir, name, 'SKILL.md');
  } else {
    const fileName = name.endsWith(mapping.ext) ? name : name + mapping.ext;
    srcPath = path.join(pluginRoot, mapping.pluginDir, fileName);
    destPath = path.join(projectRoot, mapping.projectDir, fileName);
  }

  if (!fs.existsSync(srcPath)) {
    return { ok: false, message: `Source not found: ${srcPath}` };
  }

  // Containment: verify dest resolves inside projectRoot
  const resolvedDest = path.resolve(destPath);
  if (!resolvedDest.startsWith(path.resolve(projectRoot) + path.sep)) {
    return { ok: false, message: 'Destination escapes project root.' };
  }

  // Check if already ejected
  const ejData = loadEjected(projectRoot);
  const key = `${type}:${name}`;
  if (ejData.ejected.includes(key)) {
    return { ok: false, message: `"${name}" (${type}) is already ejected.` };
  }

  // Copy file(s) to project — wrapped in try/catch to maintain { ok, message } contract
  try {
    const destDir = path.dirname(destPath);
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

    if (type === 'skill') {
      const skillSrcDir = path.join(pluginRoot, mapping.pluginDir, name);
      const skillDestDir = path.join(projectRoot, mapping.projectDir, name);
      fs.cpSync(skillSrcDir, skillDestDir, { recursive: true });
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  } catch (err) {
    return { ok: false, message: `Copy failed: ${err.message}` };
  }

  // Record ejection
  ejData.ejected.push(key);
  ejData[key] = { ejectedAt: new Date().toISOString(), source: srcPath, dest: destPath };
  saveEjected(projectRoot, ejData);

  return { ok: true, message: `Ejected ${type} "${name}" to ${destPath}`, path: destPath };
}

module.exports = { ejectComponent, loadEjected, saveEjected, EJECTED_FILE, SAFE_NAME_RE };
