'use strict';

/**
 * AISLE result inspector.
 *
 * Source-only PostToolUse/result-surface prototype. This module does not wire a
 * hook, block execution, or mutate AISLE runtime state. It normalizes returned
 * tool/function content into existing Scanner G/E/I input shapes so the repo can
 * prove returned-content classification before any shadow/warn/block decision.
 */

const fs = require('fs');
const path = require('path');

const promptSafetyScanner = require('../scanners/prompt-safety.cjs');
const egressScanner = require('../scanners/egress.cjs');
const memoryIntegrityScanner = require('../scanners/memory-integrity.cjs');
const policyEngine = require('./policy-engine.cjs');

const SECRET_PATTERNS_PATH = path.resolve(__dirname, '../data/secret-patterns.json');
const MAX_SCAN_CHARS = 512 * 1024;
const MAX_EXCERPT_CHARS = 240;
const STRUCTURED_TEXT_FIELDS = ['stdout', 'stderr', 'output', 'text', 'message', 'content', 'result', 'body', 'data'];
const METADATA_ONLY_FIELDS = new Set([
  'filePath',
  'file_path',
  'path',
  'success',
  'ok',
  'status',
  'statusCode',
  'exitCode',
  'duration_ms',
  'bytes',
]);

let secretPatternsCache = null;

function loadSecretPatterns() {
  if (secretPatternsCache) return secretPatternsCache;
  try {
    const raw = JSON.parse(fs.readFileSync(SECRET_PATTERNS_PATH, 'utf8'));
    secretPatternsCache = (raw.patterns || [])
      .filter(pattern => pattern && typeof pattern.regex === 'string' && pattern.regex.length <= 240)
      .map(pattern => {
        try {
          return {
            id: pattern.id || 'unknown',
            label: pattern.label || pattern.id || 'Secret-like value',
            re: new RegExp(pattern.regex, 'g'),
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    secretPatternsCache = [];
  }
  return secretPatternsCache;
}

function stringifySafe(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function isMetadataOnlyObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Buffer.isBuffer(value)) {
    return false;
  }
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every(key => METADATA_ONLY_FIELDS.has(key));
}

function collectText(value, parts) {
  if (value == null) return;
  if (typeof value === 'string') {
    if (value) parts.push(value);
    return;
  }
  if (Buffer.isBuffer(value)) {
    const text = value.toString('utf8');
    if (text) parts.push(text);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectText(item, parts);
    return;
  }
  if (typeof value === 'object') {
    if (isMetadataOnlyObject(value)) return;
    let foundStructuredText = false;
    for (const field of STRUCTURED_TEXT_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(value, field)) {
        const before = parts.length;
        collectText(value[field], parts);
        foundStructuredText = foundStructuredText || parts.length > before;
      }
    }
    if (!foundStructuredText) {
      const fallback = stringifySafe(value);
      if (fallback) parts.push(fallback);
    }
    return;
  }
  parts.push(String(value));
}

function extractResultText(toolResponse) {
  const parts = [];
  collectText(toolResponse, parts);
  return parts.join('\n');
}

function inferSurface(input) {
  const toolName = input && typeof input.tool_name === 'string' ? input.tool_name : '';
  const lowerTool = toolName.toLowerCase();
  if (lowerTool.includes('memory_recall') || lowerTool.includes('memory_search')) {
    return 'memory_recall_result';
  }
  if (lowerTool === 'webfetch' || lowerTool.includes('webfetch') || lowerTool.includes('web_fetch')) {
    return 'web_fetch_result';
  }
  if (toolName === 'Bash') {
    return 'shell_output';
  }
  if (lowerTool.startsWith('mcp__')) {
    return 'mcp_result';
  }
  return 'tool_result';
}

function shouldRunMemoryIntegrity(surface, toolName, options) {
  if (options && options.includeMemoryIntegrity === true) return true;
  if (surface === 'memory_recall_result') return true;
  const lowerTool = (toolName || '').toLowerCase();
  return lowerTool.includes('memory_recall') || lowerTool.includes('memory_search');
}

function redactSecrets(text) {
  if (!text) return text;
  let redacted = text;
  for (const pattern of loadSecretPatterns()) {
    redacted = redacted.replace(pattern.re, match => `[redacted:${pattern.id}:${match.length} chars]`);
  }
  return redacted;
}

function buildExcerpt(text) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  const sliced = normalized.length > MAX_EXCERPT_CHARS
    ? `${normalized.slice(0, MAX_EXCERPT_CHARS)}...`
    : normalized;
  return redactSecrets(sliced);
}

function groupFindingsByScanner(findings) {
  return findings.reduce((acc, finding) => {
    const scanner = finding.scanner || finding.scannerId || 'unknown';
    if (!acc[scanner]) acc[scanner] = [];
    acc[scanner].push(finding);
    return acc;
  }, {});
}

function inspectToolResult(input, options = {}) {
  const toolName = (input && input.tool_name) || 'unknown';
  const sessionId = (input && (input.session_id || input.sessionId)) || null;
  const surface = options.surface || inferSurface(input || {});
  const text = extractResultText(input && input.tool_response);
  const scanText = text.length > MAX_SCAN_CHARS ? text.slice(0, MAX_SCAN_CHARS) : text;

  if (!scanText) {
    return {
      mode: 'source_only_result_inspection',
      runtime_wiring: false,
      surface,
      tool_name: toolName,
      text_length: 0,
      scan_truncated: false,
      excerpt: '',
      findings: [],
      findings_by_scanner: {},
      decision: policyEngine.aggregate([], {}),
      recommended_protocol: ['proceed'],
      recommendation: 'proceed_as_data',
    };
  }

  const findings = [];
  const promptSafety = promptSafetyScanner.evaluate({
    tool_name: 'PostToolUseResult',
    tool_input: { content: scanText },
    session_id: sessionId,
  }, {});
  findings.push(...(promptSafety.findings || []));

  const egress = egressScanner.evaluate({
    tool_name: 'Bash',
    tool_input: { command: scanText },
    session_id: sessionId,
  }, {});
  findings.push(...(egress.findings || []));

  if (shouldRunMemoryIntegrity(surface, toolName, options)) {
    const memoryIntegrity = memoryIntegrityScanner.evaluate({
      tool_name: 'mcp__dev-memory__memory_recall',
      tool_input: { result: scanText },
      session_id: sessionId,
    }, {});
    findings.push(...(memoryIntegrity.findings || []));
  }

  const decision = policyEngine.aggregate(findings, options.policyConfig || {});
  const needsReview = findings.length > 0 || options.highRiskExternalContent === true;

  return {
    mode: 'source_only_result_inspection',
    runtime_wiring: false,
    surface,
    tool_name: toolName,
    text_length: text.length,
    scan_truncated: text.length > MAX_SCAN_CHARS,
    excerpt: buildExcerpt(scanText),
    findings,
    findings_by_scanner: groupFindingsByScanner(findings),
    decision,
    recommended_protocol: needsReview ? ['stop', 'show', 'ask', 'wait', 'proceed'] : ['proceed'],
    recommendation: needsReview ? 'stop_show_ask_wait_proceed' : 'proceed_as_data',
  };
}

module.exports = {
  inspectToolResult,
  extractResultText,
  inferSurface,
  redactSecrets,
  _internals: {
    collectText,
    isMetadataOnlyObject,
    buildExcerpt,
    groupFindingsByScanner,
    shouldRunMemoryIntegrity,
    loadSecretPatterns,
    MAX_SCAN_CHARS,
    MAX_EXCERPT_CHARS,
    STRUCTURED_TEXT_FIELDS,
    METADATA_ONLY_FIELDS,
  },
};
