'use strict';

const fs = require('fs');
const path = require('path');
const { loadEjected, saveEjected, EJECTED_FILE } = require('./eject.cjs');

/**
 * Re-adopt an ejected component back to plugin management.
 * Removes the local copy and clears the ejection record.
 * @param {string} name - Component name
 * @param {string} type - "hook" or "skill"
 * @param {string} projectRoot - Project root directory
 * @returns {{ ok: boolean, message: string }}
 */
function adoptComponent(name, type, projectRoot) {
  const ejData = loadEjected(projectRoot);
  const key = `${type}:${name}`;

  if (!ejData.ejected.includes(key)) {
    return { ok: false, message: `"${name}" (${type}) is not ejected. Nothing to adopt.` };
  }

  const record = ejData[key];
  let deleteWarning = '';

  if (record && record.dest) {
    // Containment: verify dest resolves inside projectRoot before any fs operation
    const resolvedDest = path.resolve(record.dest);
    if (!resolvedDest.startsWith(path.resolve(projectRoot) + path.sep)) {
      return { ok: false, message: `Manifest dest escapes project root: ${record.dest}` };
    }

    try {
      if (type === 'skill') {
        const skillDir = path.dirname(record.dest);
        const stat = fs.lstatSync(skillDir);
        if (stat.isSymbolicLink()) {
          fs.unlinkSync(skillDir);
        } else if (stat.isDirectory()) {
          fs.rmSync(skillDir, { recursive: true });
        }
      } else {
        if (fs.existsSync(record.dest)) fs.unlinkSync(record.dest);
      }
    } catch (err) {
      deleteWarning = ` Warning: local file cleanup failed (${err.message}). Remove manually.`;
    }
  }

  // Clear from manifest
  ejData.ejected = ejData.ejected.filter(k => k !== key);
  delete ejData[key];
  saveEjected(projectRoot, ejData);

  return { ok: true, message: `Re-adopted ${type} "${name}". Plugin version will be used.${deleteWarning}` };
}

module.exports = { adoptComponent };
