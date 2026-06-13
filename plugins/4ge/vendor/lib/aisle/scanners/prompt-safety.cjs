'use strict';

/**
 * prompt-safety.cjs — AISLE Scanner G
 *
 * Prompt injection and jailbreak detection. Three detection vectors:
 *   1. Regex-based fast path: known injection phrases (<10ms)
 *   2. Invisible Unicode detection: zero-width chars, RTL overrides
 *   3. Multi-turn accumulation tracking: fragmented injection across messages
 *
 * Per-tool evaluate() — fast regex path intercepts all tool calls.
 * Rule of Two: untrusted=true, sensitive=false, external=false.
 * When G + E findings combine: 2-of-3 flags = BLOCK upgrade.
 * Synchronous throughout (P0-B compliance).
 */

const path = require('path');
const fs = require('fs');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCANNER_ID = 'G';
const CANARY_DIR = path.resolve(__dirname, '../canaries/G');

const RULE_OF_TWO = { untrusted: true, sensitive: false, external: false };

// Regex injection patterns (case-insensitive)
const INJECTION_PATTERNS = [
  { pattern: /ignore\s+previous\s+instructions/i,   label: 'ignore-previous-instructions' },
  { pattern: /you\s+are\s+now\b/i,                  label: 'you-are-now' },
  { pattern: /\bsystem\s*:/i,                       label: 'system-prompt-delimiter' },
  { pattern: /\[INST\]/i,                           label: 'inst-delimiter' },
  { pattern: /<\|system\|>/i,                       label: 'llama-system-delimiter' },
  { pattern: /forget\s+everything/i,                label: 'forget-everything' },
  { pattern: /bypass\s+(?:safety|security)/i,       label: 'bypass-safety' },
];

// Invisible Unicode code points (decimal)
// Zero-width characters: ZWJ, ZWNJ, ZWS, ZWSP, BOM, soft-hyphen
// RTL overrides: U+200F (RLM), U+202B (RLE), U+202E (RLO), U+2066-2069
const INVISIBLE_UNICODE_RANGES = [
  [0x00AD, 0x00AD],  // Soft hyphen
  [0x200B, 0x200F],  // ZWS, ZWNJ, ZWJ, LRM, RLM
  [0x2028, 0x202F],  // Line/para sep, LRE, RLE, PDF, LRO, RLO, NNBSP
  [0x2060, 0x2064],  // WJ, invisible math operators
  [0x2066, 0x206F],  // LRI, RLI, FSI, PDI, inhibitors
  [0xFEFF, 0xFEFF],  // BOM / ZWNBSP
];

// Model delimiters that indicate system prompt injection attempts
const DELIMITER_PATTERNS = [
  /<\|(?:system|im_start|endoftext|begin_of_text)\|>/i,
  /\[\/INST\]/i,
  /<<SYS>>/i,
  /<s>\[INST\]/i,
];

// Multi-turn fragment window
const TURN_WINDOW = 5;
const FRAGMENT_THRESHOLD = 0.4; // 40% of patterns matched across window = suspicious

// ---------------------------------------------------------------------------
// State (per-session)
// ---------------------------------------------------------------------------

const _state = {
  // Ring buffer: last N tool inputs for multi-turn tracking
  turnHistory: [],
  // Count injection signals seen per session_id
  sessionSignals: {},
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build a Finding object.
 */
function makeFinding(opts) {
  return {
    scannerId: SCANNER_ID,
    severity: opts.severity || 'HIGH',
    title: opts.title,
    description: opts.description,
    filePath: opts.filePath || null,
    ruleOfTwo: { ...RULE_OF_TWO },
    actions: opts.actions || [],
    tier: opts.tier || 'WARN',
    flags: { ...RULE_OF_TWO },
    scanner: SCANNER_ID,
    pattern: opts.pattern || opts.title,
  };
}

/**
 * Extract text content from a tool input for analysis.
 * Handles Bash commands, MCP string args, and generic object serialization.
 * @param {object} toolInput
 * @returns {string}
 */
function extractText(toolInput) {
  const input = toolInput.tool_input || {};
  // P1-6: Concatenate ALL relevant fields instead of returning first match.
  // Injection in secondary fields (content, query) was invisible if command matched first.
  const parts = [];
  if (typeof input.command === 'string') parts.push(input.command);
  if (typeof input.prompt === 'string') parts.push(input.prompt);
  if (typeof input.content === 'string') parts.push(input.content);
  if (typeof input.query === 'string') parts.push(input.query);
  if (typeof input.message === 'string') parts.push(input.message);
  // Payload wrapper (MCP tools)
  if (input.payload && typeof input.payload === 'object') {
    const p = input.payload;
    if (typeof p.content === 'string') parts.push(p.content);
    if (typeof p.query === 'string') parts.push(p.query);
    if (parts.length === 0) parts.push(JSON.stringify(p));
  }
  return parts.length > 0 ? parts.join(' ') : JSON.stringify(input);
}

/**
 * Fast regex scan for known injection patterns.
 * Must complete in <10ms on typical inputs.
 * @param {string} text
 * @returns {{ matched: boolean, label: string|null }}
 */
function checkInjectionPatterns(text) {
  for (const { pattern, label } of INJECTION_PATTERNS) {
    if (pattern.test(text)) {
      return { matched: true, label };
    }
  }
  for (const delim of DELIMITER_PATTERNS) {
    if (delim.test(text)) {
      return { matched: true, label: 'model-delimiter' };
    }
  }
  return { matched: false, label: null };
}

/**
 * Check text for invisible Unicode characters.
 * @param {string} text
 * @returns {{ found: boolean, count: number, codePoints: number[] }}
 */
function detectInvisibleUnicode(text) {
  const found = [];
  for (let i = 0; i < text.length; i++) {
    const cp = text.codePointAt(i);
    for (const [lo, hi] of INVISIBLE_UNICODE_RANGES) {
      if (cp >= lo && cp <= hi) {
        found.push(cp);
        break;
      }
    }
    // Handle surrogate pairs — skip the low surrogate
    if (cp > 0xFFFF) i++;
  }
  return { found: found.length > 0, count: found.length, codePoints: found };
}

/**
 * Multi-turn accumulation: track signals across recent turns.
 * Returns true if accumulated evidence exceeds threshold.
 * @param {string} sessionId
 * @param {string} text
 * @returns {boolean}
 */
function checkMultiTurn(sessionId, text) {
  if (!sessionId) return false;

  // Add current turn to history
  _state.turnHistory.push({ sessionId, text, ts: Date.now() });
  // P1-7: Global cap to prevent unbounded growth across sessions
  if (_state.turnHistory.length > 100) {
    _state.turnHistory = _state.turnHistory.slice(-100);
  }
  // Keep only last TURN_WINDOW entries per session
  const sessionTurns = _state.turnHistory.filter(t => t.sessionId === sessionId);
  if (sessionTurns.length > TURN_WINDOW) {
    // Remove oldest for this session
    const oldest = sessionTurns[0];
    const idx = _state.turnHistory.indexOf(oldest);
    if (idx !== -1) _state.turnHistory.splice(idx, 1);
  }

  // Check combined text of recent turns for this session
  const combinedText = sessionTurns.map(t => t.text).join(' ');
  let matchCount = 0;
  for (const { pattern } of INJECTION_PATTERNS) {
    if (pattern.test(combinedText)) matchCount++;
  }
  const ratio = matchCount / INJECTION_PATTERNS.length;
  return ratio >= FRAGMENT_THRESHOLD;
}

// ---------------------------------------------------------------------------
// Scanner contract
// ---------------------------------------------------------------------------

module.exports = {
  id: SCANNER_ID,
  name: 'prompt-safety',
  version: '1.0.0',
  defaultTier: 'WARN',
  cadence: ['per-tool'],
  capabilities: { network: false, fs: false, env: [] },

  /**
   * Per-tool evaluation for prompt injection detection.
   * Regex fast path must complete in <10ms.
   *
   * @param {object} toolInput - { tool_name, tool_input, session_id? }
   * @param {object} cachedState - Unused
   * @returns {{ allow: boolean, findings: object[] }}
   */
  evaluate(toolInput, _cachedState) {
    const findings = [];
    const text = extractText(toolInput);
    const sessionId = toolInput.session_id || null;

    // 1. Fast regex path — known injection patterns
    const injectionResult = checkInjectionPatterns(text);
    if (injectionResult.matched) {
      findings.push(makeFinding({
        severity: 'HIGH',
        title: 'Prompt injection pattern detected',
        description: `Input matches injection pattern: ${injectionResult.label}`,
        tier: 'WARN',
        pattern: `injection:${injectionResult.label}`,
      }));
    }

    // 2. Invisible Unicode detection
    const unicodeResult = detectInvisibleUnicode(text);
    if (unicodeResult.found) {
      findings.push(makeFinding({
        severity: 'HIGH',
        title: 'Invisible Unicode characters detected',
        description: `Found ${unicodeResult.count} invisible Unicode code point(s) — possible steganographic injection`,
        tier: 'WARN',
        pattern: 'invisible-unicode',
      }));
    }

    // 3. Multi-turn accumulation
    const isAccumulated = checkMultiTurn(sessionId, text);
    if (isAccumulated && !injectionResult.matched) {
      // Only fire if we didn't already flag the individual pattern
      findings.push(makeFinding({
        severity: 'MEDIUM',
        title: 'Multi-turn injection accumulation detected',
        description: `Accumulated injection signals across recent turns exceed threshold (${Math.round(FRAGMENT_THRESHOLD * 100)}%)`,
        tier: 'WARN',
        pattern: 'multi-turn-accumulation',
      }));
    }

    // Rule of Two: untrusted=true is already set; block stays WARN tier
    // (upgrade to BLOCK happens at gate-evaluator when G + E both fire)
    const hasBlock = findings.some(f => f.tier === 'BLOCK');
    return { allow: !hasBlock, findings };
  },

  /**
   * Boot-time scan — no-op for prompt scanner (no static files to inspect).
   */
  scan(_context) {
    return { findings: [], duration: 0, cachedState: {} };
  },

  /**
   * Self-test against canary fixtures.
   */
  selfTest() {
    const results = [];

    // injection-pattern.txt
    try {
      const content = fs.readFileSync(path.join(CANARY_DIR, 'injection-pattern.txt'), 'utf8');
      const result = checkInjectionPatterns(content);
      results.push({ canary: 'injection-pattern.txt', detected: result.matched, label: result.label });
    } catch (err) {
      results.push({ canary: 'injection-pattern.txt', detected: false, error: err.message });
    }

    // two-message-sequence.json
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(CANARY_DIR, 'two-message-sequence.json'), 'utf8'));
      const messages = raw.messages || [];
      const combined = messages.map(m => m.content || '').join(' ');
      const result = checkInjectionPatterns(combined);
      results.push({ canary: 'two-message-sequence.json', detected: result.matched });
    } catch (err) {
      results.push({ canary: 'two-message-sequence.json', detected: false, error: err.message });
    }

    // invisible-unicode.txt
    try {
      const content = fs.readFileSync(path.join(CANARY_DIR, 'invisible-unicode.txt'), 'utf8');
      const result = detectInvisibleUnicode(content);
      results.push({ canary: 'invisible-unicode.txt', detected: result.found, count: result.count });
    } catch (err) {
      results.push({ canary: 'invisible-unicode.txt', detected: false, error: err.message });
    }

    return { pass: results.every(r => r.detected), details: results };
  },

  /**
   * Health check.
   */
  health() {
    return {
      status: 'healthy',
      patternCount: INJECTION_PATTERNS.length + DELIMITER_PATTERNS.length,
      turnHistorySize: _state.turnHistory.length,
    };
  },

  // Exposed for testing
  _internals: {
    _state,
    makeFinding,
    extractText,
    checkInjectionPatterns,
    detectInvisibleUnicode,
    checkMultiTurn,
    INJECTION_PATTERNS,
    DELIMITER_PATTERNS,
    INVISIBLE_UNICODE_RANGES,
    TURN_WINDOW,
    FRAGMENT_THRESHOLD,
    RULE_OF_TWO,
  },
};
