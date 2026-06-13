'use strict';

const DEFAULT_CONTRACT = {
  priority: 'normal',
  scope: { write: ['*'], read: ['*'] },
  tools: ['*'],
  maxTurns: null,
  slo: { max_duration_minutes: null },
  escalatesTo: null,
  outputDir: null,
};

const VALID_PRIORITIES = ['low', 'normal', 'high', 'critical'];

/**
 * Parse agent frontmatter YAML into a contract object.
 * Supports a minimal subset of YAML: top-level scalar fields,
 * comma-separated tool lists, and indented scope blocks with
 * inline JSON array values.
 *
 * @param {string|undefined} yaml - Raw YAML string from agent frontmatter
 * @returns {object} Parsed contract, with defaults applied for missing fields
 */
function parse(yaml) {
  if (!yaml || typeof yaml !== 'string' || !yaml.trim()) {
    return {
      ...DEFAULT_CONTRACT,
      scope: { ...DEFAULT_CONTRACT.scope },
      slo: { ...DEFAULT_CONTRACT.slo },
    };
  }

  const contract = {
    ...DEFAULT_CONTRACT,
    scope: { ...DEFAULT_CONTRACT.scope },
    slo: { ...DEFAULT_CONTRACT.slo },
  };

  const lines = yaml.split('\n');
  let currentKey = null;

  for (const line of lines) {
    // Skip blank lines and comments
    if (!line.trim() || line.trim().startsWith('#')) continue;

    // Top-level key (no leading whitespace)
    const topMatch = line.match(/^(\w[\w_-]*):\s*(.*)$/);
    // Indented sub-key (2+ spaces of leading whitespace)
    const subMatch = line.match(/^(\s{2,})(\w[\w_-]*):\s*(.*)$/);

    if (topMatch && !line.startsWith(' ') && !line.startsWith('\t')) {
      currentKey = topMatch[1];
      const value = topMatch[2].trim();

      switch (currentKey) {
        case 'tools':
          if (value) {
            contract.tools = value.split(',').map(t => t.trim()).filter(Boolean);
          }
          break;

        case 'priority':
          if (value) {
            contract.priority = value;
          }
          break;

        case 'maxTurns': {
          const n = parseInt(value, 10);
          contract.maxTurns = Number.isFinite(n) ? n : null;
          break;
        }

        case 'escalates-to':
          if (value) contract.escalatesTo = value;
          break;

        case 'output-dir':
          if (value) contract.outputDir = value;
          break;

        // 'scope' and 'slo' are block keys — values come from sub-matches
        default:
          break;
      }
    } else if (subMatch) {
      const subKey = subMatch[2];
      const subValue = subMatch[3].trim();

      if (currentKey === 'scope') {
        if (subValue.startsWith('[')) {
          try {
            contract.scope[subKey] = JSON.parse(subValue);
          } catch {
            // Malformed JSON — keep default
          }
        } else if (subValue) {
          // Single scalar value — wrap in array
          contract.scope[subKey] = [subValue];
        }
      } else if (currentKey === 'slo') {
        const n = parseFloat(subValue);
        contract.slo[subKey] = Number.isFinite(n) ? n : null;
      }
    }
  }

  return contract;
}

/**
 * Validate a contract object for correctness.
 *
 * @param {object} contract
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validate(contract) {
  const errors = [];

  if (contract.priority !== undefined && !VALID_PRIORITIES.includes(contract.priority)) {
    errors.push(
      `priority must be one of: ${VALID_PRIORITIES.join(', ')} (got "${contract.priority}")`
    );
  }

  if (contract.tools !== undefined && !Array.isArray(contract.tools)) {
    errors.push('tools must be an array of strings');
  }

  if (contract.maxTurns !== null && contract.maxTurns !== undefined) {
    if (!Number.isInteger(contract.maxTurns) || contract.maxTurns <= 0) {
      errors.push('maxTurns must be a positive integer');
    }
  }

  if (
    contract.slo?.max_duration_minutes !== null &&
    contract.slo?.max_duration_minutes !== undefined
  ) {
    if (
      typeof contract.slo.max_duration_minutes !== 'number' ||
      contract.slo.max_duration_minutes <= 0
    ) {
      errors.push('slo.max_duration_minutes must be a positive number');
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Merge an agent contract over a set of defaults.
 * Scope and slo sub-objects are merged shallowly so that
 * partial overrides don't wipe out sibling keys.
 *
 * @param {object} defaults - Base contract (typically DEFAULT_CONTRACT)
 * @param {object} agent - Agent-specific overrides
 * @returns {object} Merged contract
 */
function merge(defaults, agent) {
  return {
    ...defaults,
    ...agent,
    scope: { ...defaults.scope, ...agent.scope },
    slo: { ...defaults.slo, ...agent.slo },
  };
}

/**
 * Check whether a tool name is permitted by the contract.
 * Supports exact matches, `*` global wildcard, and prefix wildcards
 * such as `mcp__dev-memory__*` or `mcp__*`.
 *
 * @param {object} contract
 * @param {string} toolName
 * @returns {boolean}
 */
function isAllowed(contract, toolName) {
  if (!contract.tools || contract.tools.includes('*')) return true;

  return contract.tools.some(pattern => {
    if (pattern === toolName) return true;
    if (pattern.endsWith('*')) {
      const prefix = pattern.slice(0, -1);
      return toolName.startsWith(prefix);
    }
    return false;
  });
}

/**
 * Check whether a file path falls within the contract's scope for
 * the given access mode ('write' or 'read').
 *
 * Rules evaluated in order for each pattern in the scope list:
 *  - `*`              → allow everything
 *  - `!<pattern>`     → negation (currently logged; positive match wins)
 *  - `<dir>/`         → prefix match (path must start with the prefix)
 *  - `<glob>`         → picomatch glob match
 *
 * Returns true when at least one positive pattern matches and no
 * negation pattern overrides it (simplified: first positive match wins
 * for directory prefixes; negations are supported structurally but the
 * test suite only asserts the positive case).
 *
 * @param {object} contract
 * @param {string} filePath
 * @param {'write'|'read'} mode
 * @returns {boolean}
 */
function isInScope(contract, filePath, mode) {
  const globs = contract.scope?.[mode];
  if (!globs) return true;
  if (globs.includes('*')) return true;

  // Normalize path separators for Windows compatibility and resolve traversal
  const posixPath = filePath.replace(/\\/g, '/');
  const normalized = require('node:path').posix.normalize(posixPath);

  // Reject any remaining .. segments (path traversal defense)
  if (normalized.includes('..')) return false;

  // picomatch is a dependency already installed (package.json)
  const picomatch = require('picomatch');

  // Separate positive and negation patterns
  const positivePatterns = globs.filter(g => !g.startsWith('!'));
  const negationPatterns = globs
    .filter(g => g.startsWith('!'))
    .map(g => g.slice(1));

  // Check if any positive pattern matches
  const matched = positivePatterns.some(glob => {
    if (glob === '*') return true;
    const normalizedGlob = glob.replace(/\\/g, '/');
    // Directory prefix shorthand: "lib/" matches "lib/anything"
    if (normalizedGlob.endsWith('/')) {
      return normalized.startsWith(normalizedGlob);
    }
    return picomatch.isMatch(normalized, normalizedGlob, { dot: true });
  });

  if (!matched) return false;

  // If a negation pattern also matches, deny
  const negated = negationPatterns.some(glob => {
    const normalizedGlob = glob.replace(/\\/g, '/');
    if (normalizedGlob.endsWith('/')) {
      return normalized.startsWith(normalizedGlob);
    }
    return picomatch.isMatch(normalized, normalizedGlob, { dot: true });
  });

  return !negated;
}

module.exports = {
  parse,
  validate,
  merge,
  isAllowed,
  isInScope,
  DEFAULT_CONTRACT,
  VALID_PRIORITIES,
};
