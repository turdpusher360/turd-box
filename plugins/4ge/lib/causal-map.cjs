'use strict';

/**
 * Maps changed files to the teammates responsible for them (via scope assignment).
 *
 * @param {object} session - Forge session with teammates array (each has name, scope)
 * @param {string[]} changedFiles - Array of changed file paths
 * @returns {Object<string, string[]>} Map of teammate name -> files they own
 */
function buildAttributionMap(session, changedFiles) {
  if (!changedFiles || changedFiles.length === 0) return {};

  const teammates = (session && session.teammates) || [];
  const map = {};

  for (const file of changedFiles) {
    let attributed = false;
    for (const teammate of teammates) {
      if (!teammate.scope || teammate.scope.length === 0) continue;
      if (teammate.scope.some(prefix => file.startsWith(prefix))) {
        if (!map[teammate.name]) map[teammate.name] = [];
        map[teammate.name].push(file);
        attributed = true;
        break;
      }
    }
    if (!attributed) {
      if (!map['unattributed']) map['unattributed'] = [];
      map['unattributed'].push(file);
    }
  }

  return map;
}

/**
 * Formats the attribution map as human-readable text.
 *
 * @param {Object<string, string[]>} map - Attribution map from buildAttributionMap
 * @returns {string} Human-readable attribution report
 */
function formatAttribution(map) {
  const lines = [];
  for (const [owner, files] of Object.entries(map)) {
    lines.push(`## ${owner === 'unattributed' ? 'Unattributed' : owner}`);
    for (const f of files) {
      lines.push(`  - ${f}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

module.exports = { buildAttributionMap, formatAttribution };
