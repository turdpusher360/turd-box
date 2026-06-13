'use strict';

/**
 * memory-integrity.cjs — AISLE Scanner I
 *
 * Memory/context poisoning detection. Three detection vectors:
 *   1. Instruction-override patterns in memory_store content
 *   2. Poisoned content in memory_recall results (ATK-12)
 *   3. Rapid-write anomaly detection (sliding window)
 *
 * Per-tool only (cadence: ['per-tool']). No boot-time scan.
 * Synchronous throughout (P0-B compliance).
 */

const path = require('path');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCANNER_ID = 'I';
const CANARY_DIR = path.resolve(__dirname, '../canaries/I');

const RULE_OF_TWO = { untrusted: false, sensitive: true, external: false };

// MCP tool names for memory operations
const MEMORY_STORE_TOOLS = [
  'mcp__dev-memory__memory_store',
  'mcp__memory__memory_store',
];
const MEMORY_RECALL_TOOLS = [
  'mcp__dev-memory__memory_recall',
  'mcp__memory__memory_recall',
];
const MEMORY_MUTATE_TOOLS = [
  'mcp__dev-memory__memory_update',
  'mcp__memory__memory_update',
  'mcp__dev-memory__memory_forget',
  'mcp__memory__memory_forget',
  'mcp__dev-memory__memory_consolidate',
  'mcp__memory__memory_consolidate',
];

// Instruction-override patterns (case-insensitive)
const OVERRIDE_PATTERNS = [
  /ignore\s+security/i,
  /disable\s+aisle/i,
  /skip\s+verification/i,
  /bypass\s+security/i,
  /turn\s+off\s+scanning/i,
  /override\s+security/i,
  /ignore\s+all\s+previous/i,
  /you\s+are\s+now/i,
  /new\s+instructions?\s*:/i,
  /system\s*:\s*you/i,
  /\bact\s+as\b/i,
  /forget\s+(your|all|previous)/i,
];

// Tag patterns that suggest injection
const SUSPICIOUS_TAG_PATTERNS = [
  /^admin$/i,
  /^system$/i,
  /^override$/i,
  /^root$/i,
  /^sudo$/i,
];

// Rapid-write detection config
const RAPID_WRITE_WINDOW_MS = 60 * 1000; // 60 seconds
const RAPID_WRITE_THRESHOLD = 10;

// ---------------------------------------------------------------------------
// State (per-session, per-scanner instance)
// ---------------------------------------------------------------------------

const _state = {
  writeTimestamps: [],
  // P1-8: Use object instead of Set — Set is not JSON-serializable
  flaggedSessions: {},
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build a Finding object.
 * @param {object} opts
 * @returns {object} Finding
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
 * Check text content for instruction-override patterns.
 * @param {string} text
 * @returns {string|null} Matched pattern description, or null
 */
function detectOverride(text) {
  if (!text || typeof text !== 'string') return null;
  for (const pattern of OVERRIDE_PATTERNS) {
    if (pattern.test(text)) {
      return pattern.source;
    }
  }
  return null;
}

/**
 * Check tags array for suspicious patterns.
 * @param {string[]} tags
 * @returns {string|null} Matched tag, or null
 */
function detectSuspiciousTags(tags) {
  if (!Array.isArray(tags)) return null;
  for (const tag of tags) {
    for (const pattern of SUSPICIOUS_TAG_PATTERNS) {
      if (pattern.test(tag)) return tag;
    }
  }
  return null;
}

/**
 * Track a memory_store call and check for rapid-write anomaly.
 * Uses a sliding window (shift oldest entries), not a fixed bucket.
 * @returns {boolean} true if anomaly detected
 */
function checkRapidWrite() {
  const now = Date.now();
  _state.writeTimestamps.push(now);

  // Slide window: remove entries older than the window
  const cutoff = now - RAPID_WRITE_WINDOW_MS;
  while (_state.writeTimestamps.length > 0 && _state.writeTimestamps[0] < cutoff) {
    _state.writeTimestamps.shift();
  }

  return _state.writeTimestamps.length > RAPID_WRITE_THRESHOLD;
}

// ---------------------------------------------------------------------------
// Scanner contract
// ---------------------------------------------------------------------------

module.exports = {
  id: SCANNER_ID,
  name: 'memory-integrity',
  version: '1.0.0',
  defaultTier: 'WARN',
  cadence: ['per-tool'],
  capabilities: { network: false, fs: false, env: [] },

  /**
   * Per-tool evaluation for memory operations.
   *
   * @param {object} toolInput - { tool_name, tool_input }
   * @param {object} cachedState - Unused for this scanner
   * @returns {{ allow: boolean, findings: object[] }}
   */
  evaluate(toolInput, _cachedState) {
    const findings = [];
    const toolName = toolInput.tool_name || '';
    const input = toolInput.tool_input || {};

    const isMemoryStore = MEMORY_STORE_TOOLS.some(t => toolName.includes(t));
    const isMemoryRecall = MEMORY_RECALL_TOOLS.some(t => toolName.includes(t));
    const isMemoryMutate = MEMORY_MUTATE_TOOLS.some(t => toolName.includes(t));

    if (!isMemoryStore && !isMemoryRecall && !isMemoryMutate) {
      return { allow: true, findings: [] };
    }

    // --- memory_store checks ---
    if (isMemoryStore) {
      const content = (input.payload && input.payload.content) || input.content || '';
      const tags = (input.payload && input.payload.tags) || input.tags || [];

      // 1a. Check for AISLE-overriding instructions
      const overrideMatch = detectOverride(content);
      if (overrideMatch) {
        findings.push(makeFinding({
          severity: 'CRITICAL',
          title: 'Memory poisoning: instruction override detected',
          description: `memory_store content matches override pattern: ${overrideMatch}`,
          tier: 'BLOCK',
          pattern: overrideMatch,
        }));
      }

      // 1c. Check for suspicious tags
      const suspiciousTag = detectSuspiciousTags(tags);
      if (suspiciousTag) {
        findings.push(makeFinding({
          severity: 'HIGH',
          title: 'Memory poisoning: suspicious tag',
          description: `memory_store uses suspicious tag: "${suspiciousTag}"`,
          tier: 'WARN',
          pattern: `suspicious-tag:${suspiciousTag}`,
        }));
      }

      // 3. Rapid-write anomaly detection
      if (checkRapidWrite()) {
        findings.push(makeFinding({
          severity: 'MEDIUM',
          title: 'Rapid-write anomaly',
          description: `>${RAPID_WRITE_THRESHOLD} memory_store calls in ${RAPID_WRITE_WINDOW_MS / 1000}s window`,
          tier: 'WARN',
          pattern: 'rapid-write',
        }));
      }
    }

    // --- memory_update / memory_forget / memory_consolidate checks ---
    if (isMemoryMutate) {
      const content = (input.payload && input.payload.content) || input.content || '';
      const tags = (input.payload && input.payload.tags) || input.tags || [];

      // Check for AISLE-overriding instructions in mutated content
      const overrideMatch = detectOverride(content);
      if (overrideMatch) {
        findings.push(makeFinding({
          severity: 'CRITICAL',
          title: 'Memory poisoning: instruction override in mutation op',
          description: `${toolName} content matches override pattern: ${overrideMatch}`,
          tier: 'BLOCK',
          pattern: overrideMatch,
        }));
      }

      // Check for suspicious tags on mutation ops
      const suspiciousTag = detectSuspiciousTags(tags);
      if (suspiciousTag) {
        findings.push(makeFinding({
          severity: 'HIGH',
          title: 'Memory poisoning: suspicious tag in mutation op',
          description: `${toolName} uses suspicious tag: "${suspiciousTag}"`,
          tier: 'WARN',
          pattern: `suspicious-tag:${suspiciousTag}`,
        }));
      }

      // Rapid-write anomaly (mutations count toward the same window as stores)
      if (checkRapidWrite()) {
        findings.push(makeFinding({
          severity: 'MEDIUM',
          title: 'Rapid-write anomaly (mutation op)',
          description: `>${RAPID_WRITE_THRESHOLD} memory write/mutate calls in ${RAPID_WRITE_WINDOW_MS / 1000}s window`,
          tier: 'WARN',
          pattern: 'rapid-write',
        }));
      }
    }

    // --- memory_recall checks (ATK-12) ---
    if (isMemoryRecall) {
      // PostToolUse: inspect recalled content
      const recalledContent = input.result || input.content || '';
      const recallText = typeof recalledContent === 'string'
        ? recalledContent
        : JSON.stringify(recalledContent);

      const overrideMatch = detectOverride(recallText);
      if (overrideMatch) {
        findings.push(makeFinding({
          severity: 'HIGH',
          title: 'Poisoned memory recalled (ATK-12)',
          description: `memory_recall result contains override pattern: ${overrideMatch}`,
          tier: 'WARN',
          pattern: overrideMatch,
          actions: ['provenance-tag'],
        }));
        // Tag the session as flagged for provenance tracking
        _state.flaggedSessions[toolInput.session_id || 'unknown'] = true;
      }
    }

    // MCP arg visibility check
    // P1-3: Append degraded finding instead of returning early (was discarding
    // rapid-write and other findings already accumulated above)
    if ((isMemoryStore || isMemoryRecall || isMemoryMutate) && !input.payload && !input.content && !input.result) {
      findings.push(makeFinding({
        severity: 'LOW',
        title: 'MCP args not visible — degraded mode',
        description: 'Scanner I cannot inspect MCP tool arguments. Operating in WARN-only mode.',
        tier: 'WARN',
        pattern: 'degraded-mcp-args',
      }));
      return { allow: true, findings };
    }

    const hasBlock = findings.some(f => f.tier === 'BLOCK');
    return { allow: !hasBlock, findings };
  },

  /**
   * Boot-time scan — no-op for memory scanner.
   */
  scan(_context) {
    return { findings: [], duration: 0, cachedState: { writeTimestamps: [] } };
  },

  /**
   * Self-test against canary fixtures.
   */
  selfTest() {
    const fs = require('fs');
    const results = [];

    // Canary: poisoning-attempt.json
    try {
      const poisonPath = path.join(CANARY_DIR, 'poisoning-attempt.json');
      const canary = JSON.parse(fs.readFileSync(poisonPath, 'utf8'));
      const result = module.exports.evaluate(
        { tool_name: 'mcp__dev-memory__memory_store', tool_input: canary },
        {}
      );
      results.push({
        canary: 'poisoning-attempt.json',
        detected: result.findings.length > 0,
        findings: result.findings.length,
      });
    } catch (err) {
      results.push({ canary: 'poisoning-attempt.json', detected: false, error: err.message });
    }

    // Canary: rapid-write-burst.json
    try {
      const burstPath = path.join(CANARY_DIR, 'rapid-write-burst.json');
      const canary = JSON.parse(fs.readFileSync(burstPath, 'utf8'));

      // Reset state for clean test
      _state.writeTimestamps = [];

      // Simulate rapid writes
      const calls = canary.calls || 15;
      let detected = false;
      for (let i = 0; i < calls; i++) {
        const result = module.exports.evaluate(
          { tool_name: 'mcp__dev-memory__memory_store', tool_input: canary },
          {}
        );
        if (result.findings.some(f => f.pattern === 'rapid-write')) {
          detected = true;
        }
      }
      results.push({ canary: 'rapid-write-burst.json', detected, calls });

      // Reset state after test
      _state.writeTimestamps = [];
    } catch (err) {
      results.push({ canary: 'rapid-write-burst.json', detected: false, error: err.message });
    }

    return { pass: results.every(r => r.detected), details: results };
  },

  /**
   * Health check for memory integrity scanner.
   */
  health() {
    return {
      status: 'healthy',
      flaggedSessions: Object.keys(_state.flaggedSessions).length,
      writeTracking: _state.writeTimestamps.length,
    };
  },

  // Exposed for testing
  _internals: {
    _state,
    detectOverride,
    detectSuspiciousTags,
    checkRapidWrite,
    makeFinding,
    OVERRIDE_PATTERNS,
    SUSPICIOUS_TAG_PATTERNS,
    RAPID_WRITE_WINDOW_MS,
    RAPID_WRITE_THRESHOLD,
    MEMORY_STORE_TOOLS,
    MEMORY_RECALL_TOOLS,
    MEMORY_MUTATE_TOOLS,
  },
};
