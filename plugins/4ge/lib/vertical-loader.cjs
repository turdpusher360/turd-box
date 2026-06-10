'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const VERTICAL_DIR = 'verticals';

/** Required top-level fields in a vertical defaults.json */
const REQUIRED_FIELDS = ['version', 'name'];

/** Fields that must be specific types when present */
const FIELD_TYPES = {
  version: 'string',
  name: 'string',
  description: 'string',
  categories: 'object',
  scan_exclude: 'object', // arrays are typeof 'object'
  thresholds: 'object',
};

/**
 * Resolve discovery paths for verticals in priority order:
 * 1. Plugin-shipped: plugins/4ge/verticals/<name>/
 * 2. Project-level:  .4ge-verticals/<name>/
 * 3. User-global:    ~/.4ge/verticals/<name>/
 *
 * @param {string} name - vertical name
 * @param {string} pluginRoot - absolute path to plugins/4ge/
 * @returns {string[]} ordered candidate directories
 */
function getDiscoveryPaths(name, pluginRoot) {
  const projectRoot = path.resolve(pluginRoot, '..', '..');
  return [
    path.join(pluginRoot, VERTICAL_DIR, name),
    path.join(projectRoot, '.4ge-verticals', name),
    path.join(os.homedir(), '.4ge', VERTICAL_DIR, name),
  ];
}

/**
 * Load a named vertical's defaults.json.
 * Searches discovery paths in priority order; first match wins.
 *
 * @param {string} name - vertical identifier (e.g. 'devops')
 * @param {string} pluginRoot - absolute path to plugins/4ge/
 * @returns {{ found: boolean, config: object|null, source: string|null, error: string|null }}
 */
function loadVertical(name, pluginRoot) {
  if (!name || typeof name !== 'string') {
    return { found: false, config: null, source: null, error: 'Vertical name is required' };
  }

  // Sanitize: only allow alphanumeric, hyphens, underscores
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    return { found: false, config: null, source: null, error: `Invalid vertical name: ${name}` };
  }

  const candidates = getDiscoveryPaths(name, pluginRoot);

  for (const dir of candidates) {
    const defaultsPath = path.join(dir, 'defaults.json');
    if (!fs.existsSync(defaultsPath)) continue;

    try {
      const raw = fs.readFileSync(defaultsPath, 'utf8');
      const config = JSON.parse(raw);
      const validation = validateVertical(config);
      if (!validation.valid) {
        return { found: true, config: null, source: defaultsPath, error: validation.error };
      }
      return { found: true, config, source: defaultsPath, error: null };
    } catch (err) {
      return { found: true, config: null, source: defaultsPath, error: `Parse error: ${err.message}` };
    }
  }

  return { found: false, config: null, source: null, error: `Vertical '${name}' not found in any discovery path` };
}

/**
 * List all available verticals across all discovery paths.
 * Plugin-shipped verticals appear first; duplicates are deduplicated (first wins).
 *
 * @param {string} pluginRoot - absolute path to plugins/4ge/
 * @returns {{ name: string, source: string, description: string|null }[]}
 */
function listVerticals(pluginRoot) {
  const projectRoot = path.resolve(pluginRoot, '..', '..');
  const searchDirs = [
    { dir: path.join(pluginRoot, VERTICAL_DIR), label: 'plugin' },
    { dir: path.join(projectRoot, '.4ge-verticals'), label: 'project' },
    { dir: path.join(os.homedir(), '.4ge', VERTICAL_DIR), label: 'user' },
  ];

  const seen = new Set();
  const results = [];

  for (const { dir, label } of searchDirs) {
    if (!fs.existsSync(dir)) continue;

    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (seen.has(entry.name)) continue;

      const defaultsPath = path.join(dir, entry.name, 'defaults.json');
      if (!fs.existsSync(defaultsPath)) continue;

      seen.add(entry.name);

      let description = null;
      try {
        const config = JSON.parse(fs.readFileSync(defaultsPath, 'utf8'));
        description = config.description || null;
      } catch {
        // Non-parseable vertical still listed, just without description
      }

      results.push({
        name: entry.name,
        source: label,
        description,
      });
    }
  }

  return results;
}

/**
 * Validate a vertical config object.
 *
 * @param {object} config - parsed defaults.json content
 * @returns {{ valid: boolean, error: string|null }}
 */
function validateVertical(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return { valid: false, error: 'Vertical config must be a non-null object' };
  }

  // Check required fields
  for (const field of REQUIRED_FIELDS) {
    if (config[field] === undefined || config[field] === null) {
      return { valid: false, error: `Missing required field: ${field}` };
    }
  }

  // Type checks
  for (const [field, expectedType] of Object.entries(FIELD_TYPES)) {
    if (config[field] !== undefined && typeof config[field] !== expectedType) {
      return { valid: false, error: `Field '${field}' must be type ${expectedType}, got ${typeof config[field]}` };
    }
  }

  // Categories validation: each category must be an object if present
  if (config.categories) {
    for (const [catName, catConfig] of Object.entries(config.categories)) {
      if (typeof catConfig !== 'object' || catConfig === null || Array.isArray(catConfig)) {
        return { valid: false, error: `Category '${catName}' must be an object` };
      }
    }
  }

  // Security floor: verticals cannot disable security or lower pass_threshold below 30
  if (config.categories && config.categories.security) {
    const sec = config.categories.security;
    if (sec.enabled === false) {
      return { valid: false, error: 'Vertical cannot disable the security category' };
    }
    if (sec.pass_threshold !== undefined && sec.pass_threshold < 30) {
      return { valid: false, error: 'Vertical cannot set security pass_threshold below 30' };
    }
  }

  return { valid: true, error: null };
}

module.exports = {
  loadVertical,
  listVerticals,
  validateVertical,
  getDiscoveryPaths,
  VERTICAL_DIR,
};
