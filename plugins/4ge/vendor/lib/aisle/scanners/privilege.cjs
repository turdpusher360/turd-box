'use strict';

/**
 * Scanner C — Privilege Escalation
 *
 * Detects privilege escalation attempts via:
 *   1. Empty/null/undefined subagent_type in Agent/Task calls
 *   2. Agent calling tools outside its declared contract
 *   3. Write/Edit to paths outside agent's declared scope.write
 *   4. Any context modifying .claude/ directory from a subagent context
 *   5. Quarantine violations (absorbed from quarantine hook trio)
 *
 * Budget: <10ms per evaluate() call
 * Cadence: per-tool
 */

const fs = require('fs');
const path = require('path');

// P2-10: Replace picomatch npm dependency with inline glob matcher.
// AISLE scanners must use zero npm dependencies (Node.js built-ins only).
// The patterns used here are simple: "packages/cloudflare/**", ".claude/**", etc.
// Supported syntax: ** (any path segments), * (any chars within a segment), ? (one char).
/**
 * Convert a glob pattern to a RegExp.
 * @param {string} pattern
 * @returns {RegExp}
 */
function globToRegExp(pattern) {
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    if (pattern[i] === '*' && pattern[i + 1] === '*') {
      // ** matches zero or more path segments (including slashes)
      re += '.*';
      i += 2;
      // consume trailing slash after ** if present
      if (pattern[i] === '/') i++;
    } else if (pattern[i] === '*') {
      // * matches anything except a slash
      re += '[^/]*';
      i++;
    } else if (pattern[i] === '?') {
      // ? matches any single char except a slash
      re += '[^/]';
      i++;
    } else {
      // Escape special regex chars
      re += pattern[i].replace(/[.+^${}()|[\]\\]/g, '\\$&');
      i++;
    }
  }
  return new RegExp('^' + re + '$');
}

/**
 * Test whether a normalized path matches any of the given glob patterns.
 * @param {string} filePath - Forward-slash normalized path
 * @param {string[]} patterns - Glob patterns (no negation — caller handles that)
 * @returns {boolean}
 */
function isMatch(filePath, patterns) {
  return patterns.some(p => globToRegExp(p).test(filePath));
}

// ---------------------------------------------------------------------------
// Quarantine manifest loader
// ---------------------------------------------------------------------------

// Cached manifest components. Loaded once at module init from the default path,
// or lazily on first evaluate() if cwd is not yet known at require time.
let _quarantineComponents = null;
let _quarantineLoadError = null;
let _quarantineManifestPath = null;

/**
 * Maps installer filename (lowercase) to the component type it installs.
 * Mirrors the INSTALLER_TYPE_MAP from quarantine-sub-installer.cjs.
 */
const INSTALLER_TYPE_MAP = {
  'hook-installer.cjs': 'hook',
  'agent-installer.cjs': 'agent',
  'skill-installer.cjs': 'skill',
  'rule-installer.cjs': 'rule',
};

/**
 * Load (or return cached) quarantine manifest components.
 * Returns array of quarantined_components or empty array on missing/error.
 *
 * @param {string} [manifestPath] - Override path (for testing)
 * @returns {Array<{type: string, name: string, reason: string}>}
 */
function loadQuarantineManifest(manifestPath) {
  // Use override path if provided, otherwise use cached path or resolve default
  const resolvedPath = manifestPath || _quarantineManifestPath || (function() {
    // Resolve relative to the repo's .claude/hooks/ directory by walking up from __dirname
    const dir = path.resolve(__dirname, '..', '..', '..', '.claude', 'hooks');
    return path.join(dir, 'quarantine-manifest.json');
  }());

  // If we have a cached result for this path, return it
  if (!manifestPath && _quarantineComponents !== null) {
    return _quarantineComponents;
  }

  _quarantineManifestPath = resolvedPath;

  try {
    const raw = fs.readFileSync(resolvedPath, 'utf8');
    const manifest = JSON.parse(raw);
    const components = Array.isArray(manifest.quarantined_components)
      ? manifest.quarantined_components
      : [];
    // Only cache when using default path (not test overrides)
    if (!manifestPath) {
      _quarantineComponents = components;
      _quarantineLoadError = null;
    }
    return components;
  } catch (err) {
    if (!manifestPath) {
      _quarantineComponents = [];
      _quarantineLoadError = err.code === 'ENOENT' ? 'missing' : err.message;
    }
    return [];
  }
}

/**
 * Check a tool input against quarantined components.
 * Absorbs logic from the three quarantine hook files.
 *
 * @param {object} toolInput - Full tool input (with tool_name and tool_input)
 * @param {string} [manifestPath] - Override for testing
 * @returns {{ blocked: boolean, reason: string|null }}
 */
function checkQuarantine(toolInput, manifestPath) {
  const tool = toolInput.tool_name || toolInput.tool || '';
  const input = toolInput.tool_input || toolInput;
  const components = loadQuarantineManifest(manifestPath);

  if (!components || components.length === 0) {
    return { blocked: false, reason: null };
  }

  // ------------------------------------------------------------------
  // 1. Task/Agent tool — block quarantined agents
  //    Mirrors: quarantine-agent-guard.cjs
  // ------------------------------------------------------------------
  if (tool === 'Task' || tool === 'Agent') {
    const subagentType = input.subagent_type || '';
    if (subagentType) {
      const quarantinedAgents = components.filter(c => c.type === 'agent');
      const match = quarantinedAgents.find(a => a.name === subagentType);
      if (match) {
        return {
          blocked: true,
          reason: `Agent "${subagentType}" is quarantined: ${match.reason}`,
        };
      }
    }
  }

  // ------------------------------------------------------------------
  // 2. Bash tool — block quarantined skill/installer invocations
  //    Mirrors: quarantine-sub-installer.cjs
  // ------------------------------------------------------------------
  if (tool === 'Bash') {
    const cmd = (input.command || '').toLowerCase();
    const detectedInstallers = Object.keys(INSTALLER_TYPE_MAP).filter(filename =>
      cmd.includes(filename)
    );
    for (const filename of detectedInstallers) {
      const installerType = INSTALLER_TYPE_MAP[filename];
      const isTypeQuarantined = components.some(c => c.type === installerType);
      if (isTypeQuarantined) {
        const matching = components.filter(c => c.type === installerType);
        const names = matching.map(c => `"${c.name}"`).join(', ');
        return {
          blocked: true,
          reason: `Bash command invoking ${filename} blocked — ${installerType} components quarantined: ${names}`,
        };
      }
    }
    // Also block by quarantined skill name appearing in a blueprint command context
    const quarantinedSkills = components.filter(c => c.type === 'skill');
    for (const skill of quarantinedSkills) {
      const skillNameLower = skill.name.toLowerCase();
      if (cmd.includes(skillNameLower)) {
        return {
          blocked: true,
          reason: `Bash command references quarantined skill "${skill.name}": ${skill.reason}`,
        };
      }
    }
  }

  // ------------------------------------------------------------------
  // 3. Write/Edit tool — block settings.json writes re-enabling quarantined items
  //    Mirrors: quarantine-settings-guard.cjs
  // ------------------------------------------------------------------
  if (tool === 'Write' || tool === 'Edit') {
    const filePath = (input.file_path || input.path || '').replace(/\\/g, '/').toLowerCase();
    if (filePath.endsWith('.claude/settings.json')) {
      const content = (input.content || input.new_string || '').toLowerCase();
      const relevantComponents = components.filter(c => c.type === 'hook' || c.type === 'setting' || c.type === 'skill');
      for (const component of relevantComponents) {
        const nameLower = component.name.toLowerCase();
        if (component.type === 'hook') {
          const cjsFilename = nameLower.endsWith('.cjs') ? nameLower : `${nameLower}.cjs`;
          if (content.includes(nameLower) || content.includes(cjsFilename)) {
            return {
              blocked: true,
              reason: `Write to settings.json references quarantined hook "${component.name}": ${component.reason}`,
            };
          }
        } else if (content.includes(nameLower)) {
          return {
            blocked: true,
            reason: `Write to settings.json references quarantined ${component.type} "${component.name}": ${component.reason}`,
          };
        }
      }
    }
  }

  return { blocked: false, reason: null };
}

// Expose for testing
const _internals = {
  loadQuarantineManifest,
  checkQuarantine,
  get quarantineComponents() { return _quarantineComponents; },
  get quarantineLoadError() { return _quarantineLoadError; },
  resetQuarantineCache() {
    _quarantineComponents = null;
    _quarantineLoadError = null;
    _quarantineManifestPath = null;
  },
};

// ---------------------------------------------------------------------------
// Frontmatter parser
// ---------------------------------------------------------------------------

/**
 * Extract YAML frontmatter from a Markdown file content string.
 * Returns parsed key-value pairs for simple scalar fields and
 * YAML list fields (tools, allowed-tools, scope.write, scope.read).
 *
 * Handles both inline format (`tools: Edit, Write, Bash`) and
 * indented list format:
 *   tools:
 *     - Edit
 *     - Write
 *
 * @param {string} content - Raw file content
 * @returns {object|null} Parsed frontmatter object or null if no frontmatter
 */
function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;

  const block = match[1];
  const result = {};
  const lines = block.split(/\r?\n/);

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1 || /^\s/.test(line)) { i++; continue; }

    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (!key) { i++; continue; }

    // Check if next lines are YAML list items (indented "- value")
    if (!value && i + 1 < lines.length && /^\s+-\s/.test(lines[i + 1])) {
      const items = [];
      i++;
      while (i < lines.length && /^\s+-\s/.test(lines[i])) {
        items.push(lines[i].replace(/^\s+-\s*/, '').trim());
        i++;
      }
      // Store as comma-separated string (matches parseToolsList input format)
      result[key] = items.join(', ');
      continue;
    }

    if (value) {
      result[key] = value;
    }
    i++;
  }

  return result;
}

/**
 * Parse a comma-separated tools string into a normalized array.
 * Handles both "tools:" and "allowed-tools:" frontmatter keys.
 *
 * @param {string} toolsStr - e.g. "Edit, Write, Bash, Read"
 * @returns {string[]} Normalized tool names
 */
function parseToolsList(toolsStr) {
  if (!toolsStr) return [];
  return toolsStr
    .split(',')
    .map(t => t.trim())
    .filter(Boolean);
}

/**
 * Parse scope block from frontmatter. Expects YAML list format or inline array.
 * Falls back to empty array if absent.
 *
 * @param {string|undefined} scopeStr
 * @returns {string[]}
 */
function parseScopeList(scopeStr) {
  if (!scopeStr) return [];
  // Handle inline arrays: ["lib/**", "!lib/os/**"]
  const inlineMatch = scopeStr.match(/^\[(.+)\]$/);
  if (inlineMatch) {
    return inlineMatch[1]
      .split(',')
      .map(s => s.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);
  }
  // Plain value
  return [scopeStr.trim()].filter(Boolean);
}

// ---------------------------------------------------------------------------
// Scope matching
// ---------------------------------------------------------------------------

/**
 * Test whether a file path is within a set of scope patterns.
 * Positive patterns must match; negative patterns (prefixed with !) exclude.
 * An empty patterns array means no scope restriction (allow all).
 *
 * @param {string} filePath
 * @param {string[]} patterns
 * @returns {boolean}
 */
function matchesScope(filePath, patterns) {
  if (!patterns || patterns.length === 0) return true;

  const positives = patterns.filter(p => !p.startsWith('!'));
  const negatives = patterns.filter(p => p.startsWith('!')).map(p => p.slice(1));

  // Normalize path separators to forward slash for glob matching
  const normalized = filePath.replace(/\\/g, '/');

  const matchesPositive = positives.length === 0 || isMatch(normalized, positives);
  const matchesNegative = negatives.length > 0 && isMatch(normalized, negatives);

  return matchesPositive && !matchesNegative;
}

// ---------------------------------------------------------------------------
// Contract loader — called from scan()
// ---------------------------------------------------------------------------

/**
 * Parse all agent .md files in the given agents directory.
 * Returns a contract map keyed by agent name.
 *
 * Contract shape:
 *   {
 *     [agentName]: {
 *       tools: string[],          // declared allowed tools
 *       scope: {
 *         write: string[],        // write scope patterns
 *         read: string[],         // read scope patterns
 *       },
 *       hasWildcard: boolean,     // true if tools includes '*' or is empty
 *       isEmpty: boolean,         // true if no tools declared
 *     }
 *   }
 *
 * @param {string} agentsDir - Absolute path to .claude/agents/
 * @returns {{ contracts: object, errors: string[] }}
 */
function loadContracts(agentsDir) {
  const contracts = {};
  const errors = [];

  let entries;
  try {
    entries = fs.readdirSync(agentsDir);
  } catch {
    // Directory does not exist or is unreadable — return empty (degraded mode)
    return { contracts, errors: [`agents dir unreadable: ${agentsDir}`] };
  }

  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;

    const filePath = path.join(agentsDir, entry);
    let content;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch {
      errors.push(`unreadable: ${entry}`);
      continue;
    }

    const fm = parseFrontmatter(content);
    if (!fm) continue;

    const name = fm['name'];
    if (!name) continue;

    // tools or allowed-tools
    const toolsRaw = fm['allowed-tools'] || fm['tools'] || '';
    const tools = parseToolsList(toolsRaw);

    // scope.write and scope.read (rare — most agents don't declare these)
    const scopeWrite = parseScopeList(fm['scope.write']);
    const scopeRead = parseScopeList(fm['scope.read']);

    contracts[name] = {
      tools,
      scope: { write: scopeWrite, read: scopeRead },
      hasWildcard: tools.includes('*'),
      isEmpty: tools.length === 0,
    };
  }

  return { contracts, errors };
}

// ---------------------------------------------------------------------------
// Finding builder
// ---------------------------------------------------------------------------

/**
 * Build a privilege finding.
 *
 * @param {string} pattern - Finding pattern ID
 * @param {string} detail  - Human-readable detail
 * @param {string} tier    - BLOCK | WARN | LOG
 * @returns {object}
 */
// P1-10: Standard finding shape — old shape ({detail, pattern, tier}) caused
// missing fields in event bus and reporting. Now matches all other scanners.
function makeFinding(pattern, detail, tier = 'BLOCK') {
  return {
    scannerId: 'C',
    scanner: 'C',
    severity: tier === 'BLOCK' ? 'HIGH' : tier === 'WARN' ? 'MEDIUM' : 'LOW',
    title: `privilege: ${pattern}`,
    description: detail,
    filePath: null,
    ruleOfTwo: { untrusted: false, sensitive: false, external: false },
    pattern,
    detail,  // Preserved for backward compat
    tier,
    actions: ['log'],
    flags: { untrusted: false, sensitive: false, external: false },
  };
}

// ---------------------------------------------------------------------------
// Scanner module
// ---------------------------------------------------------------------------

/** Cached path for canary fixtures — resolved relative to this file */
const CANARY_DIR = path.join(__dirname, '..', 'canaries', 'C');

const scanner = {
  id: 'C',
  name: 'privilege',
  version: '1.0.0',
  defaultTier: 'BLOCK',
  cadence: ['per-tool'],
  capabilities: { network: false, fs: true, env: [] },

  // -------------------------------------------------------------------------
  // evaluate(toolInput, cachedState) -> { allow: boolean, findings: Finding[] }
  //
  // Per-tool call evaluation. cachedState.contracts is populated by scan().
  // Fast-path: if contracts not loaded, only check empty subagent_type.
  // -------------------------------------------------------------------------
  evaluate(toolInput, cachedState) {
    const start = Date.now();
    const findings = [];

    if (!toolInput || typeof toolInput !== 'object') {
      return { allow: true, findings: [], duration: Date.now() - start };
    }

    const tool = toolInput.tool_name || toolInput.tool || '';
    const input = toolInput.tool_input || toolInput;
    const contracts = (cachedState && cachedState.contracts) || {};

    // ------------------------------------------------------------------
    // 0. Quarantine check — runs first for all tool types
    // ------------------------------------------------------------------
    const qResult = checkQuarantine(toolInput, cachedState && cachedState._manifestPath);
    if (qResult.blocked) {
      findings.push(makeFinding('quarantine_violation', qResult.reason));
      return { allow: false, findings, duration: Date.now() - start };
    }

    // ------------------------------------------------------------------
    // 1. Agent / Task calls — check subagent_type and contract
    // ------------------------------------------------------------------
    if (tool === 'Agent' || tool === 'Task') {
      const subagentType = input.subagent_type;

      // 1a. Empty/null/undefined/whitespace subagent_type
      if (subagentType == null || (typeof subagentType === 'string' && !subagentType.trim())) {
        findings.push(makeFinding(
          'empty_subagent_type',
          `${tool} call has empty or missing subagent_type`
        ));
        return { allow: false, findings, duration: Date.now() - start };
      }

      // 1b. Contract verification — block unapproved agents
      const contract = contracts[subagentType];
      if (!contract) {
        findings.push(makeFinding(
          'unapproved_agent_type',
          `${tool} call uses unapproved agent type "${subagentType}" (not in .claude/agents/)`
        ));
        return { allow: false, findings, duration: Date.now() - start };
      }
      if (contract) {
        // If agent has no declared tools and is not wildcard, flag it
        if (contract.isEmpty && !contract.hasWildcard) {
          findings.push(makeFinding(
            'empty_contract_tools',
            `Agent "${subagentType}" has no tools declared in its contract`
          ));
        }
        // Tool filter: if the spawning context declares a toolFilter, check it
        // (tool_input.requested_tools would come from the call context)
        const requestedTools = Array.isArray(input.requested_tools) ? input.requested_tools : [];
        if (requestedTools.length > 0 && !contract.hasWildcard) {
          for (const t of requestedTools) {
            if (!contract.tools.includes(t)) {
              findings.push(makeFinding(
                'tool_not_in_contract',
                `Agent "${subagentType}" requested tool "${t}" not in its declared contract [${contract.tools.join(', ')}]`
              ));
            }
          }
        }
      }
    }

    // ------------------------------------------------------------------
    // 2. Bash calls — detect sed -i (in-place file write bypass)
    // ------------------------------------------------------------------
    if (tool === 'Bash') {
      const cmd = (typeof input.command === 'string' ? input.command : '') ||
                  (typeof input === 'string' ? input : '');

      // Detect sed with -i flag (any position in flag cluster, e.g. -i, -ni, -in, --in-place)
      const SED_INPLACE = /sed\s+(-[^ ]*i[^ ]*|-i)\s/;
      if (SED_INPLACE.test(cmd)) {
        // Check whether the command targets a protected path
        const PROTECTED_PATHS = ['.claude/', 'settings.json', 'settings.local.json', '.mcp.json'];
        const targetsProtected = PROTECTED_PATHS.some(p => cmd.includes(p));

        if (targetsProtected) {
          findings.push(makeFinding(
            'sed_inplace_protected',
            `sed -i targeting protected path detected in command: ${cmd}`,
            'BLOCK'
          ));
          return { allow: false, findings, duration: Date.now() - start };
        } else {
          findings.push(makeFinding(
            'sed_inplace_warn',
            `sed -i (in-place file write) detected in command: ${cmd}`,
            'WARN'
          ));
        }
      }
    }

    // ------------------------------------------------------------------
    // 3. Write / Edit calls — check scope and .claude/ protection
    // ------------------------------------------------------------------
    if (tool === 'Write' || tool === 'Edit') {
      const filePath = input.file_path || input.path || '';

      if (filePath) {
        const normalized = filePath.replace(/\\/g, '/');

        // 2a. Block .claude/ modifications from subagent context
        // agent_id present means we're in a subagent context
        const isSubagent = !!(toolInput.agent_id || input.agent_id);
        const normalizedLower = normalized.toLowerCase();
        if (isSubagent && (normalizedLower.includes('/.claude/') || normalizedLower.startsWith('.claude/'))) {
          findings.push(makeFinding(
            'claude_dir_modification',
            `Subagent context attempting to modify .claude/ directory: ${filePath}`
          ));
        }

        // 2b. Scope check — only if the spawning agent has a write scope declared
        const agentName = toolInput.agent_type || input.agent_type || '';
        if (agentName) {
          const contract = contracts[agentName];
          if (contract && contract.scope.write.length > 0) {
            if (!matchesScope(normalized, contract.scope.write)) {
              findings.push(makeFinding(
                'write_outside_scope',
                `Agent "${agentName}" writing to path "${filePath}" outside declared scope [${contract.scope.write.join(', ')}]`
              ));
            }
          }
        }
      }
    }

    const allow = findings.length === 0;
    return { allow, findings, duration: Date.now() - start };
  },

  // -------------------------------------------------------------------------
  // scan(context) -> { findings, duration, cachedState }
  //
  // Boot-time scan. Loads all agent contracts from .claude/agents/*.md.
  // Checks for agents with empty tools declarations or wildcard permissions.
  // -------------------------------------------------------------------------
  scan(context) {
    const start = Date.now();
    const findings = [];

    // Resolve agents directory from context.cwd or process.cwd()
    const cwd = (context && context.cwd) || process.cwd();
    const agentsDir = path.join(cwd, '.claude', 'agents');

    const { contracts, errors } = loadContracts(agentsDir);

    // Report load errors as LOG-tier findings
    for (const err of errors) {
      findings.push(makeFinding('contract_load_error', err, 'LOG'));
    }

    // Check each loaded contract for concerning patterns
    for (const [name, contract] of Object.entries(contracts)) {
      if (contract.isEmpty) {
        findings.push(makeFinding(
          'empty_contract_tools',
          `Agent "${name}" declares no tools — contract cannot be enforced`,
          'WARN'
        ));
      }
      if (contract.hasWildcard) {
        findings.push(makeFinding(
          'wildcard_contract_tools',
          `Agent "${name}" uses wildcard tool grant ("*") — unrestricted access`,
          'WARN'
        ));
      }
    }

    const duration = Date.now() - start;
    return {
      findings,
      duration,
      cachedState: { contracts, agentsDir },
    };
  },

  // -------------------------------------------------------------------------
  // selfTest() -> { pass: boolean, details: string }
  //
  // Validates canary fixtures are detectable by evaluate().
  // -------------------------------------------------------------------------
  selfTest() {
    try {
      // Load canaries
      const contractViolationPath = path.join(CANARY_DIR, 'contract-violation.json');
      const emptySubagentPath = path.join(CANARY_DIR, 'empty-subagent.json');

      let cv, es;
      try {
        cv = JSON.parse(fs.readFileSync(contractViolationPath, 'utf8'));
        es = JSON.parse(fs.readFileSync(emptySubagentPath, 'utf8'));
      } catch (err) {
        return { pass: false, details: `canary load failed: ${err.message}` };
      }

      // --- Test contract-violation canary ---
      // Build a synthetic contract with only the declared tools
      const declaredTools = cv.agent_tools_declared || [];
      const mockContracts = {
        [cv.tool_input.subagent_type]: {
          tools: declaredTools,
          scope: { write: [], read: [] },
          hasWildcard: declaredTools.includes('*'),
          isEmpty: declaredTools.length === 0,
        },
      };

      // The prompt implies requesting tools not in the contract.
      // We simulate by adding requested_tools that exceed the contract.
      const cvInput = {
        tool_name: cv.tool,
        tool_input: {
          ...cv.tool_input,
          requested_tools: ['Write', 'Edit', 'Bash'],
        },
      };

      const cvResult = this.evaluate(cvInput, { contracts: mockContracts });
      const cvExpected = cv.expected_finding;
      const cvFound = cvResult.findings.some(f => f.pattern === cvExpected);

      if (!cvFound) {
        return {
          pass: false,
          details: `contract-violation canary: expected finding "${cvExpected}" not detected. findings: ${JSON.stringify(cvResult.findings.map(f => f.pattern))}`,
        };
      }

      // --- Test empty-subagent canary ---
      const esInput = {
        tool_name: es.tool,
        tool_input: es.tool_input,
      };

      const esResult = this.evaluate(esInput, { contracts: {} });
      const esExpected = es.expected_finding;
      const esFound = esResult.findings.some(f => f.pattern === esExpected);

      if (!esFound) {
        return {
          pass: false,
          details: `empty-subagent canary: expected finding "${esExpected}" not detected. findings: ${JSON.stringify(esResult.findings.map(f => f.pattern))}`,
        };
      }

      return { pass: true, details: 'all canaries detected' };
    } catch (err) {
      return { pass: false, details: `selfTest error: ${err.message}` };
    }
  },

  // -------------------------------------------------------------------------
  // health() -> { status: string, contractsLoaded: number }
  // -------------------------------------------------------------------------
  health() {
    try {
      // Quick readdir to check agents dir is accessible
      const cwd = process.cwd();
      const agentsDir = path.join(cwd, '.claude', 'agents');
      const entries = fs.readdirSync(agentsDir);
      const count = entries.filter(e => e.endsWith('.md')).length;
      return { status: 'healthy', contractsLoaded: count };
    } catch {
      return { status: 'degraded', contractsLoaded: 0 };
    }
  },
};

module.exports = scanner;
module.exports._internals = _internals;
