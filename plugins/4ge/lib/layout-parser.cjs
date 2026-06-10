'use strict';

const fs = require('fs');
const path = require('path');

const VALID_TOPOLOGIES = ['hierarchical', 'star', 'pipeline', 'paired'];

/**
 * Minimal inline YAML parser for layout files.
 * Handles only the subset of YAML used in layout definitions:
 * - Top-level key: value pairs
 * - Arrays of objects (teammates)
 * - Nested arrays (scope)
 */
function parseLayout(yamlStr) {
  const lines = yamlStr.split('\n');
  const result = { name: '', topology: '', teammates: [] };
  let currentTeammate = null;
  let inTeammates = false;
  let inScope = false;

  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const indent = line.length - line.trimStart().length;

    // Top-level key: value
    if (indent === 0 && trimmed.includes(':') && !trimmed.startsWith('-')) {
      const [key, ...rest] = trimmed.split(':');
      const val = rest.join(':').trim();
      if (key.trim() === 'name') result.name = val;
      if (key.trim() === 'topology') result.topology = val;
      if (key.trim() === 'teammates') { inTeammates = true; inScope = false; }
      continue;
    }

    // Teammate list item
    if (inTeammates && trimmed.trimStart().startsWith('- name:')) {
      if (currentTeammate) result.teammates.push(currentTeammate);
      const name = trimmed.split('name:')[1].trim();
      currentTeammate = { name, agent: '', scope: [], isolation: '' };
      inScope = false;
      continue;
    }

    if (currentTeammate) {
      const stripped = trimmed.trim();
      if (stripped.startsWith('agent:')) currentTeammate.agent = stripped.split(':')[1].trim();
      else if (stripped.startsWith('isolation:')) currentTeammate.isolation = stripped.split(':')[1].trim();
      else if (stripped === 'scope:') { inScope = true; }
      else if (inScope && stripped.startsWith('- ')) {
        currentTeammate.scope.push(stripped.slice(2).trim());
      } else {
        inScope = false;
      }
    }
  }

  if (currentTeammate) result.teammates.push(currentTeammate);
  return result;
}

/**
 * Validates a parsed layout object.
 */
function validateLayout(layout) {
  const errors = [];
  if (!layout.name) errors.push('Missing name');
  if (!VALID_TOPOLOGIES.includes(layout.topology)) {
    errors.push(`Invalid topology "${layout.topology}". Valid: ${VALID_TOPOLOGIES.join(', ')}`);
  }
  if (!layout.teammates || layout.teammates.length === 0) {
    errors.push('At least one teammate required');
  }
  for (const t of (layout.teammates || [])) {
    if (!t.name) errors.push('Teammate missing name');
    if (!t.agent) errors.push(`Teammate "${t.name}" missing agent`);
  }
  return errors;
}

/**
 * Lists available layout names from the layouts directory.
 */
function listLayouts(layoutsDir) {
  if (!fs.existsSync(layoutsDir)) return [];
  return fs.readdirSync(layoutsDir)
    .filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))
    .map(f => f.replace(/\.ya?ml$/, ''));
}

module.exports = { parseLayout, validateLayout, listLayouts, VALID_TOPOLOGIES };
