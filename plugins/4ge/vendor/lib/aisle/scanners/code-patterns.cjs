'use strict';

/**
 * Scanner B — code-patterns
 *
 * 3-layer detection for dangerous code patterns in files being written/edited:
 *   Layer 1: Regex fast path (evaluate + scan, <10ms)
 *   Layer 2: Shannon entropy analysis on string literals (scan only, >4.5 = suspicious)
 *   Layer 3: AST analysis via acorn (scan only) — eval with non-literal args,
 *            Function constructor, dynamic require
 *
 * evaluate() is called on every Write/Edit (per-tool cadence, Layer 1 only).
 * scan() is called at boot and on-demand (all 3 layers).
 *
 * Rule of Two flags for code pattern findings: { untrusted: false, sensitive: true, external: false }
 * Dangerous code patterns operate on sensitive data (secrets, user input) but are
 * not inherently untrusted (the developer is writing them) or external (no network call).
 */

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Pattern database (loaded from code-patterns.json, compiled to RegExp)
// ---------------------------------------------------------------------------

const DATA_PATH = path.join(__dirname, '..', 'data', 'code-patterns.json');

/** @type {{ patterns: object[], entropyThreshold: number, entropyMinLength: number } | null} */
let _patternDb = null;

/** @type {Array<{ id: string, regex: RegExp, severity: string, tier: string, reference: string, description: string }>} */
let _compiledPatterns = [];

let _loadError = null;

function _loadPatterns() {
  if (_patternDb !== null) return;
  try {
    const raw = fs.readFileSync(DATA_PATH, 'utf8');
    _patternDb = JSON.parse(raw);
    _compiledPatterns = _patternDb.patterns.map(p => ({
      id: p.id,
      regex: new RegExp(p.pattern, 'u'),
      severity: p.severity,
      tier: p.tier,
      reference: p.reference,
      description: p.description,
    }));
  } catch (err) {
    _loadError = err.message;
    _patternDb = { patterns: [], entropyThreshold: 4.5, entropyMinLength: 20 };
    _compiledPatterns = [];
  }
}

// ---------------------------------------------------------------------------
// Layer 1: Regex fast path
// ---------------------------------------------------------------------------

/**
 * Run compiled regex patterns against content.
 *
 * @param {string} content
 * @param {string} filePath
 * @returns {Array<object>} findings
 */
function _runRegexPatterns(content, filePath) {
  _loadPatterns();
  const findings = [];
  const lines = content.split('\n');

  for (const compiledPattern of _compiledPatterns) {
    // Test full content first (fast path)
    if (!compiledPattern.regex.test(content)) continue;

    // Find line numbers for all matches
    for (let i = 0; i < lines.length; i++) {
      if (compiledPattern.regex.test(lines[i])) {
        findings.push({
          scanner: 'B',
          pattern: compiledPattern.id,
          severity: compiledPattern.severity,
          tier: compiledPattern.tier,
          reference: compiledPattern.reference,
          description: compiledPattern.description,
          file: filePath || '<unknown>',
          line: i + 1,
          layer: 1,
          flags: { untrusted: false, sensitive: true, external: false },
        });
      }
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Layer 2: Shannon entropy analysis
// ---------------------------------------------------------------------------

/**
 * Calculate Shannon entropy of a string.
 * H = -sum(p * log2(p)) where p = frequency of each character.
 *
 * @param {string} str
 * @returns {number} entropy value (0-8 for ASCII)
 */
function _shannonEntropy(str) {
  if (!str || str.length === 0) return 0;
  const freq = {};
  for (const ch of str) {
    freq[ch] = (freq[ch] || 0) + 1;
  }
  let entropy = 0;
  const len = str.length;
  for (const count of Object.values(freq)) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * Extract all string literals from content using a lightweight regex approach.
 * Matches single-quoted, double-quoted, and template literals.
 *
 * @param {string} content
 * @returns {Array<{ value: string, line: number }>}
 */
function _extractStringLiterals(content) {
  const results = [];
  const lines = content.split('\n');
  // Match string literals: single, double quotes (no backtick to avoid false positives on templates)
  const STRING_RE = /(['"])([^'"\\]|\\[\s\S])*\1/g;

  for (let i = 0; i < lines.length; i++) {
    let match;
    STRING_RE.lastIndex = 0;
    while ((match = STRING_RE.exec(lines[i])) !== null) {
      const inner = match[0].slice(1, -1); // strip quotes
      results.push({ value: inner, line: i + 1 });
    }
  }
  return results;
}

/**
 * Layer 2: Find string literals with Shannon entropy above threshold.
 *
 * @param {string} content
 * @param {string} filePath
 * @returns {Array<object>} findings
 */
function _runEntropyAnalysis(content, filePath) {
  _loadPatterns();
  const threshold = _patternDb.entropyThreshold || 4.5;
  const minLen = _patternDb.entropyMinLength || 20;
  const findings = [];

  const literals = _extractStringLiterals(content);
  for (const { value, line } of literals) {
    if (value.length < minLen) continue;
    const entropy = _shannonEntropy(value);
    if (entropy > threshold) {
      findings.push({
        scanner: 'B',
        pattern: 'high-entropy-string',
        severity: 'MEDIUM',
        tier: 'WARN',
        reference: 'CWE-506',
        description: `High-entropy string literal (entropy=${entropy.toFixed(2)}, len=${value.length}) — possible obfuscated payload`,
        file: filePath || '<unknown>',
        line,
        layer: 2,
        entropyValue: parseFloat(entropy.toFixed(2)),
        flags: { untrusted: false, sensitive: true, external: false },
      });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Layer 3: AST analysis via acorn
// ---------------------------------------------------------------------------

/**
 * Load acorn lazily (transitive dep via ESLint, not vendored).
 * Returns null if unavailable.
 */
function _loadAcorn() {
  try {
    return require('acorn');
  } catch {
    return null;
  }
}

/**
 * Walk an AST node recursively, calling visitor for each node.
 *
 * @param {object} node
 * @param {function} visitor
 */
function _walkAst(node, visitor) {
  if (!node || typeof node !== 'object') return;
  visitor(node);
  for (const key of Object.keys(node)) {
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        if (item && typeof item === 'object' && item.type) {
          _walkAst(item, visitor);
        }
      }
    } else if (child && typeof child === 'object' && child.type) {
      _walkAst(child, visitor);
    }
  }
}

/**
 * Layer 3: AST-based detection of dangerous patterns.
 *
 * Detects:
 *   - eval() with non-literal argument (variable, call expression, etc.)
 *   - new Function() constructor
 *   - dynamic require() with non-literal argument
 *
 * A JS parse failure is itself suspicious (obfuscated/malformed code).
 *
 * @param {string} content
 * @param {string} filePath
 * @returns {Array<object>} findings
 */
function _runAstAnalysis(content, filePath) {
  const acorn = _loadAcorn();
  if (!acorn) return [];

  const findings = [];
  let ast;

  try {
    ast = acorn.parse(content, {
      ecmaVersion: 'latest',
      sourceType: 'script',
      locations: true,
      allowReserved: true,
    });
  } catch {
    // Parse failure on .js file is suspicious — could be intentional obfuscation
    if (!filePath || /\.(js|mjs|cjs)$/.test(filePath)) {
      findings.push({
        scanner: 'B',
        pattern: 'js-parse-failure',
        severity: 'HIGH',
        tier: 'BLOCK',
        reference: 'CWE-116',
        description: 'JavaScript file failed to parse — potential obfuscation or malformed code',
        file: filePath || '<unknown>',
        line: 1,
        layer: 3,
        flags: { untrusted: false, sensitive: true, external: false },
      });
    }
    return findings;
  }

  _walkAst(ast, node => {
    // eval() with non-literal argument
    if (
      node.type === 'CallExpression' &&
      node.callee &&
      node.callee.type === 'Identifier' &&
      node.callee.name === 'eval' &&
      node.arguments.length > 0 &&
      node.arguments[0].type !== 'Literal'
    ) {
      findings.push({
        scanner: 'B',
        pattern: 'eval-non-literal',
        severity: 'HIGH',
        tier: 'BLOCK',
        reference: 'CWE-95',
        description: 'eval() called with non-literal argument — dynamic code execution',
        file: filePath || '<unknown>',
        line: node.loc ? node.loc.start.line : 0,
        layer: 3,
        flags: { untrusted: false, sensitive: true, external: false },
      });
    }

    // new Function() constructor
    if (
      node.type === 'NewExpression' &&
      node.callee &&
      node.callee.type === 'Identifier' &&
      node.callee.name === 'Function'
    ) {
      findings.push({
        scanner: 'B',
        pattern: 'function-constructor-ast',
        severity: 'HIGH',
        tier: 'BLOCK',
        reference: 'CWE-95',
        description: 'new Function() constructor — equivalent to eval()',
        file: filePath || '<unknown>',
        line: node.loc ? node.loc.start.line : 0,
        layer: 3,
        flags: { untrusted: false, sensitive: true, external: false },
      });
    }

    // dynamic require() — require(variable) not require('literal')
    if (
      node.type === 'CallExpression' &&
      node.callee &&
      node.callee.type === 'Identifier' &&
      node.callee.name === 'require' &&
      node.arguments.length > 0 &&
      node.arguments[0].type !== 'Literal'
    ) {
      findings.push({
        scanner: 'B',
        pattern: 'dynamic-require-ast',
        severity: 'MEDIUM',
        tier: 'WARN',
        reference: 'CWE-94',
        description: 'require() called with non-literal argument — dynamic module loading',
        file: filePath || '<unknown>',
        line: node.loc ? node.loc.start.line : 0,
        layer: 3,
        flags: { untrusted: false, sensitive: true, external: false },
      });
    }
  });

  return findings;
}

// ---------------------------------------------------------------------------
// Canary path resolution
// ---------------------------------------------------------------------------

const CANARY_DIR = path.join(__dirname, '..', 'canaries', 'B');

/**
 * Read a canary file and return its content.
 * Returns null if the file cannot be read.
 *
 * @param {string} filename
 * @returns {string|null}
 */
function _readCanary(filename) {
  try {
    return fs.readFileSync(path.join(CANARY_DIR, filename), 'utf8');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Scanner interface
// ---------------------------------------------------------------------------

const scanner = {
  id: 'B',
  name: 'code-patterns',
  version: '1.0.0',
  defaultTier: 'BLOCK',
  cadence: ['boot', 'per-tool'],
  toolFilter: ['Write', 'Edit'],
  capabilities: { network: false, fs: true, env: [] },

  /**
   * evaluate() — Layer 1 only (regex fast path, <10ms).
   * Called on every Write/Edit tool use.
   *
   * @param {object} toolInput - { path?: string, content?: string, new_string?: string }
   * @param {object} _cachedState - unused (no cache in Layer 1)
   * @returns {{ allow: boolean, findings: Array<object> }}
   */
  evaluate(toolInput, _cachedState) {
    _loadPatterns();
    if (!toolInput) return { allow: true, findings: [] };

    const filePath = toolInput.path || toolInput.file_path || '<unknown>';
    const content = toolInput.content || toolInput.new_string || '';

    if (!content || typeof content !== 'string') {
      return { allow: true, findings: [] };
    }

    const findings = _runRegexPatterns(content, filePath);

    // allow: false if any finding has tier BLOCK or WARN
    const blocked = findings.some(f => f.tier === 'BLOCK' || f.tier === 'WARN');

    return { allow: !blocked, findings };
  },

  /**
   * scan() — All 3 layers (synchronous).
   * Called at boot and on-demand against files on disk.
   *
   * @param {{ filePath?: string, content?: string }} context
   * @returns {{ findings: Array<object>, duration: number, cachedState: object }}
   */
  scan(context) {
    _loadPatterns();
    const startMs = Date.now();

    const filePath = (context && context.filePath) || '<unknown>';
    let content = (context && context.content) || null;

    // Read file from disk if content not provided
    if (content === null && filePath !== '<unknown>') {
      try {
        content = fs.readFileSync(filePath, 'utf8');
      } catch {
        return {
          findings: [],
          duration: Date.now() - startMs,
          cachedState: { scanned: false, error: 'file read failed' },
        };
      }
    }

    if (!content || typeof content !== 'string') {
      return {
        findings: [],
        duration: Date.now() - startMs,
        cachedState: { scanned: false, error: 'no content' },
      };
    }

    const layer1 = _runRegexPatterns(content, filePath);
    const layer2 = _runEntropyAnalysis(content, filePath);
    const layer3 = _runAstAnalysis(content, filePath);

    const findings = [...layer1, ...layer2, ...layer3];

    return {
      findings,
      duration: Date.now() - startMs,
      cachedState: {
        scanned: true,
        filePath,
        findingCount: findings.length,
        layers: { l1: layer1.length, l2: layer2.length, l3: layer3.length },
      },
    };
  },

  /**
   * selfTest() — Validates all 3 canary fixtures.
   * Returns { pass: boolean, details: string }.
   */
  selfTest() {
    const results = [];
    let allPass = true;

    // --- Canary 1: eval-injection.js ---
    const evalContent = _readCanary('eval-injection.js');
    if (!evalContent) {
      results.push('FAIL: eval-injection.js not found');
      allPass = false;
    } else {
      const { findings } = this.scan({ filePath: 'eval-injection.js', content: evalContent });
      const evalFound = findings.some(f => f.pattern === 'eval-direct' || f.pattern === 'eval-non-literal');
      if (evalFound) {
        results.push('PASS: eval-injection.js — eval pattern detected');
      } else {
        results.push('FAIL: eval-injection.js — eval pattern NOT detected');
        allPass = false;
      }
    }

    // --- Canary 2: obfuscated-payload.js ---
    const payloadContent = _readCanary('obfuscated-payload.js');
    if (!payloadContent) {
      results.push('FAIL: obfuscated-payload.js not found');
      allPass = false;
    } else {
      const { findings } = this.scan({ filePath: 'obfuscated-payload.js', content: payloadContent });
      const base64Found = findings.some(f => f.pattern === 'base64-blob' || f.pattern === 'high-entropy-string');
      if (base64Found) {
        results.push('PASS: obfuscated-payload.js — Base64/entropy pattern detected');
      } else {
        results.push('FAIL: obfuscated-payload.js — Base64/entropy pattern NOT detected');
        allPass = false;
      }
    }

    // --- Canary 3: adversarial-eval.js ---
    const adversarialContent = _readCanary('adversarial-eval.js');
    if (!adversarialContent) {
      results.push('FAIL: adversarial-eval.js not found');
      allPass = false;
    } else {
      const { findings } = this.scan({ filePath: 'adversarial-eval.js', content: adversarialContent });
      const adversarialFound = findings.some(f =>
        f.pattern === 'eval-indirect' ||
        f.pattern === 'eval-globalthis' ||
        f.pattern === 'eval-reflect'
      );
      if (adversarialFound) {
        results.push('PASS: adversarial-eval.js — adversarial eval variant detected');
      } else {
        results.push('FAIL: adversarial-eval.js — adversarial eval variant NOT detected');
        allPass = false;
      }
    }

    return {
      pass: allPass,
      details: results.join(' | '),
    };
  },

  /**
   * health() — Check patterns are loaded and pattern DB is valid.
   *
   * @returns {{ status: 'healthy'|'degraded'|'failed', details: object }}
   */
  health() {
    _loadPatterns();
    const patternsOk = _loadError === null && _compiledPatterns.length > 0;
    let acornAvailable = false;
    try { require('acorn'); acornAvailable = true; } catch {}
    return {
      status: patternsOk ? (acornAvailable ? 'healthy' : 'degraded') : 'failed',
      details: {
        patternsLoaded: _compiledPatterns.length,
        loadError: _loadError || null,
        dataPath: DATA_PATH,
        acornAvailable,
      },
    };
  },
};

module.exports = scanner;
