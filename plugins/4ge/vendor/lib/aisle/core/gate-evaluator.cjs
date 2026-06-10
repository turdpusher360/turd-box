'use strict';

/**
 * gate-evaluator.cjs
 *
 * Fast-path gate called on every tool call. Evaluates applicable scanners
 * against scanner cache, aggregates findings through the policy engine, and
 * emits audit events to the event bus.
 *
 * Design invariants:
 *   - Fail-closed on every error path (missing cache, expired cache, scanner
 *     exception, non-ARMED scanner state, global fail-closed flag)
 *   - Fully synchronous — 50ms total budget, 10ms per-scanner warning threshold
 *   - No npm dependencies — Node.js built-ins only
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * W1.5: Compound command segment cap.
 * Prevents O(n) scan time on crafted commands with many chained subcommands.
 * Matches MAX_SUBCOMMANDS_FOR_SECURITY_CHECK in the harness exploit spec.
 */
const MAX_SUBCOMMANDS = 50;

/**
 * W2.3: Subshell recursion depth cap.
 * Inner commands are scanned as synthetic Bash calls up to this depth.
 * Depth 0 = top-level command, depth 1 = inner $(…)/`…`, depth 2 = nested inner.
 * Not configurable — hard limit matches harness exploit spec.
 */
const MAX_SUBSHELL_DEPTH = 2;

// ---------------------------------------------------------------------------
// W2.3: Subshell content extraction
// ---------------------------------------------------------------------------

/**
 * extractSubshellCommands(cmd, depth)
 *
 * Extracts inner command strings from $(...) and backtick substitutions.
 * Returns an array of extracted inner command strings.
 *
 * Intentionally simple regex — does not handle nested parens — because the
 * depth cap at 2 makes deep nesting irrelevant to our security model.
 *
 * O(n) on command length: each regex scans the string once.
 *
 * @param {string} cmd   - The bash command string to extract from
 * @param {number} depth - Current recursion depth (0 = top-level)
 * @returns {string[]}   - Array of extracted inner command strings
 */
function extractSubshellCommands(cmd, depth) {
  // Hard depth cap — at depth >= MAX_SUBSHELL_DEPTH we do not extract further
  if (depth >= MAX_SUBSHELL_DEPTH) return [];
  if (!cmd || typeof cmd !== 'string') return [];

  const inner = [];

  // $(...) substitution — simple non-greedy single-level match
  const dollarParenRe = /\$\(([^)]+)\)/g;
  let match;
  while ((match = dollarParenRe.exec(cmd)) !== null) {
    const innerCmd = match[1].trim();
    if (innerCmd) inner.push(innerCmd);
  }

  // Backtick substitution
  const backtickRe = /`([^`]+)`/g;
  while ((match = backtickRe.exec(cmd)) !== null) {
    const innerCmd = match[1].trim();
    if (innerCmd) inner.push(innerCmd);
  }

  return inner;
}

// ---------------------------------------------------------------------------
// Lazy-loaded dependency paths (avoids circular-require issues at load time)
// ---------------------------------------------------------------------------

const REGISTRY_PATH  = path.resolve(__dirname, './scanner-registry.cjs');
const POLICY_PATH    = path.resolve(__dirname, './policy-engine.cjs');
const CONFIG_PATH    = path.resolve(__dirname, './config.cjs');
const EVENT_BUS_PATH = path.resolve(__dirname, '../scanners/event-bus.cjs');
const LEARNING_PATH  = path.resolve(__dirname, './learning.cjs');

// ---------------------------------------------------------------------------
// Learning confidence application thresholds
// ---------------------------------------------------------------------------

/**
 * Confidence >= ESCALATE_THRESHOLD means scanner has been confirmed accurate
 * by operator feedback. WARN findings escalate to BLOCK; LOG findings to WARN.
 */
const ESCALATE_THRESHOLD = 1.10;

/**
 * Confidence <= DEMOTE_THRESHOLD means scanner is generating false positives.
 * WARN findings demote to LOG. BLOCK findings are never demoted (ATK-5).
 */
const DEMOTE_THRESHOLD = 0.90;

// ---------------------------------------------------------------------------
// Module-level config freshness cache
// Per-subprocess-scoped: resets on each hook invocation (hook is a new process).
// ---------------------------------------------------------------------------

let _cachedConfig = null;
let _cachedConfigHash = null;

// ---------------------------------------------------------------------------
// readScannerCache(stateDir, scannerId)
//
// Reads <stateDir>/scanner-cache/<scannerId>.json from disk.
// Returns { valid: true, state: {...} } or { valid: false, reason: string }.
// ---------------------------------------------------------------------------

function readScannerCache(stateDir, scannerId) {
  const cachePath = path.join(stateDir, 'scanner-cache', `${scannerId}.json`);
  let raw;
  try {
    raw = fs.readFileSync(cachePath, 'utf8');
  } catch {
    return { valid: false, reason: 'missing' };
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { valid: false, reason: 'malformed' };
  }

  // Check expiry
  if (data.expiresAt != null && data.expiresAt < Date.now()) {
    return { valid: false, reason: 'expired' };
  }

  // Accept both cache shapes:
  //   - Production (written by boot.cjs): `{ findings, duration, cachedState }`
  //   - Tests (written via writeScannerCache helper): `{ state, expiresAt }`
  // Prior bug: reader only looked at data.state, so every production cache returned
  // undefined state. Scanner C's contracts map was empty for every evaluate() call,
  // causing every Agent/Task dispatch to hit `unapproved_agent_type` and BLOCK.
  return { valid: true, state: data.cachedState ?? data.state };
}

// ---------------------------------------------------------------------------
// checkConfigFreshness(stateDir)
//
// Compares the current config file mtime hash against our cached hash.
// If changed: reload and update cache. Synchronous.
// ---------------------------------------------------------------------------

function checkConfigFreshness(stateDir) {
  const configModule = require(CONFIG_PATH);

  // P2-9 fix: hash the canonical AISLE config file (resolved via config.cjs
  // resolveConfigPath), NOT the boot marker at path.join(stateDir, 'aisle-config.json').
  // These are two different files:
  //   - canonical config: ~/.claude/projects/<projectId>/aisle-config.json (user settings)
  //   - boot marker:      <stateDir>/aisle-config.json (runtime state written by boot())
  // Hashing the boot marker meant config changes mid-session were never detected
  // because the boot marker only changes when AISLE reboots, not when the user
  // edits their config. Now we hash the canonical config for accurate freshness.
  const projectId = configModule.deriveProjectId();
  const canonicalConfigPath = configModule.resolveConfigPath(projectId);

  if (!fs.existsSync(canonicalConfigPath)) {
    _cachedConfig = {};
    _cachedConfigHash = null;
    return;
  }

  let currentHash;
  try {
    currentHash = configModule.computeConfigHash(canonicalConfigPath);
  } catch {
    // If hash computation fails, reload anyway
    currentHash = null;
  }

  if (currentHash !== _cachedConfigHash) {
    // Reload from canonical config path
    try {
      const raw = fs.readFileSync(canonicalConfigPath, 'utf8');
      _cachedConfig = JSON.parse(raw);
    } catch {
      _cachedConfig = {};
    }
    _cachedConfigHash = currentHash;
  }
}

// ---------------------------------------------------------------------------
// applyLearningConfidence(findings) — Step 4.5
//
// Modulates finding tiers using per-scanner confidence from the learning loop.
// Called after scanner evaluation (Step 4) and before policy aggregation (Step 5).
//
// Modulation rules (ATK-5 floors respected):
//   BLOCK  → never demoted (hard security invariant)
//   WARN   → escalates to BLOCK if confidence >= ESCALATE_THRESHOLD
//             demotes to LOG if confidence <= DEMOTE_THRESHOLD
//   LOG    → escalates to WARN if confidence >= ESCALATE_THRESHOLD
//             stays LOG at low confidence (already at floor)
//   ALLOW  → unchanged (no findings to modulate)
//
// Default confidence (1.0) produces no tier change, preserving existing
// behavior until operators submit explicit FP/TP feedback via POST /learn.
//
// Non-throwing: any error returns original findings unchanged so fail-closed
// gate behaviour is never compromised by a learning module fault.
// ---------------------------------------------------------------------------

/**
 * Apply per-scanner learning confidence to modulate finding tiers.
 *
 * @param {Array<object>} findings - Raw findings from scanner evaluation
 * @returns {Array<object>} Findings with tiers adjusted by learning confidence
 */
function applyLearningConfidence(findings) {
  if (!Array.isArray(findings) || findings.length === 0) return findings;

  let learning;
  try {
    learning = require(LEARNING_PATH);
  } catch {
    // Learning module unavailable — return original findings (non-fatal)
    return findings;
  }

  return findings.map((finding) => {
    const scannerId = finding.scanner;
    if (!scannerId) return finding;

    let tuning;
    try {
      tuning = learning.getTuning(scannerId);
    } catch {
      return finding;
    }

    const confidence = (tuning && typeof tuning.confidence === 'number')
      ? tuning.confidence
      : 1.0;

    const tier = finding.tier;

    // BLOCK findings are never demoted by learning
    if (tier === 'BLOCK') return finding;

    if (tier === 'WARN') {
      if (confidence >= ESCALATE_THRESHOLD) {
        return { ...finding, tier: 'BLOCK', _learningEscalated: true };
      }
      if (confidence <= DEMOTE_THRESHOLD) {
        return { ...finding, tier: 'LOG', _learningDemoted: true };
      }
      return finding;
    }

    if (tier === 'LOG') {
      if (confidence >= ESCALATE_THRESHOLD) {
        return { ...finding, tier: 'WARN', _learningEscalated: true };
      }
      return finding;
    }

    return finding;
  });
}

// ---------------------------------------------------------------------------
// evaluate(input, stateDir) — main gate evaluation pipeline
//
// @param {object} input    - Tool call input (has .tool, plus tool-specific fields)
// @param {string} stateDir - AISLE state directory path
// @returns {{ block: boolean, reason: string, warnings: string[], decision: object }}
// ---------------------------------------------------------------------------

function evaluate(input, stateDir) {
  const registry  = require(REGISTRY_PATH);
  const policy    = require(POLICY_PATH);
  const eventBus  = require(EVENT_BUS_PATH);

  const warnings = [];

  // --- Step 1: Check global fail-closed flag (Scanner D degraded) ----------
  if (registry.isFailClosed()) {
    return {
      block: true,
      reason: 'fail-closed: Scanner D (integrity) is degraded',
      warnings,
      decision: { tier: 'BLOCK', actions: [], findings: [], ruleOfTwoTriggered: false },
    };
  }

  // --- Step 2: Check config freshness via mtime ----------------------------
  try {
    checkConfigFreshness(stateDir);
  } catch {
    // Config freshness failure is non-fatal; proceed with cached or empty config
  }

  const config = _cachedConfig || {};

  // --- Step 3: Query scanner-registry for applicable scanners ---------------
  const toolType = input && input.tool ? input.tool : '';
  const applicableScanners = registry.getForTool(toolType);

  // --- Step 3b: Bash segment cap (W1.5) ------------------------------------
  // Split on shell separators and cap at MAX_SUBCOMMANDS before scanners run.
  // This prevents O(n) scan time on crafted commands with > 50 segments.
  // The cap is WARN-only: long commands are suspicious but not always malicious.
  let bashCommandForScanners = (input && input.input && typeof input.input.command === 'string')
    ? input.input.command
    : null;

  if (toolType === 'Bash' && bashCommandForScanners !== null) {
    const segments = bashCommandForScanners.split(/[;&|]+/);
    if (segments.length > MAX_SUBCOMMANDS) {
      warnings.push(
        `[AISLE] compound-command-cap: ${segments.length} segments exceed limit (${MAX_SUBCOMMANDS}); scanning truncated`
      );
      // Truncate the command so scanners only see the first MAX_SUBCOMMANDS segments.
      // Re-join with ' && ' to preserve logical grouping semantics for scanners.
      bashCommandForScanners = segments.slice(0, MAX_SUBCOMMANDS).join(' && ');
    }
  }

  // --- Step 4: Evaluate each applicable scanner ----------------------------
  const findings = [];
  let totalElapsed = 0;

  // --- Step 3c: W2.3 Subshell content extraction ---------------------------
  // Extract $(...) and backtick inner commands from Bash calls and run them
  // through the same scanner pipeline as synthetic Bash tool calls.
  // Runs AFTER segment cap (W1.5) so crafted commands are already truncated.
  // Depth cap: MAX_SUBSHELL_DEPTH (2). Not configurable.

  /**
   * Scan a single inner command string through all applicable Bash scanners.
   * Merges findings into the parent findings array.
   * Returns { failClosed: true, reason } on error, or { failClosed: false } on success.
   */
  function scanInnerCommand(innerCmd, depth) {
    const innerScanners = registry.getForTool('Bash');

    for (const innerScanner of innerScanners) {
      const cached = readScannerCache(stateDir, innerScanner.id);
      if (!cached.valid) {
        return { failClosed: true, reason: `scanner ${innerScanner.id} cache ${cached.reason} (fail-closed, inner subshell)` };
      }

      const scannerState = registry.getState(innerScanner.id);
      if (scannerState !== 'ARMED') {
        return { failClosed: true, reason: `scanner ${innerScanner.id} is not ARMED (state: ${scannerState}) — fail-closed (inner subshell)` };
      }

      const innerScannerInput = {
        tool: 'Bash',
        tool_name: 'Bash',
        tool_input: { command: innerCmd },
        command: innerCmd,
        agentId: input.agentId,
        agent_id: input.agentId,
        agentType: input.agentType,
        agent_type: input.agentType,
        sessionId: input.sessionId,
        session_id: input.sessionId,
      };

      let scannerFindings;
      try {
        scannerFindings = innerScanner.evaluate(innerScannerInput, cached.state);
      } catch (err) {
        return { failClosed: true, reason: `scanner ${innerScanner.id} threw exception on inner subshell: ${err && err.message ? err.message : String(err)}` };
      }

      const actualFindings = Array.isArray(scannerFindings)
        ? scannerFindings
        : (scannerFindings && Array.isArray(scannerFindings.findings)
          ? scannerFindings.findings
          : []);

      for (const f of actualFindings) {
        findings.push(f);
      }
    }

    // Recurse into nested subshells (depth + 1), capped by MAX_SUBSHELL_DEPTH
    const nestedCmds = extractSubshellCommands(innerCmd, depth + 1);
    for (const nested of nestedCmds) {
      const nestedResult = scanInnerCommand(nested, depth + 1);
      if (nestedResult.failClosed) return nestedResult;
    }

    return { failClosed: false };
  }

  if (toolType === 'Bash' && bashCommandForScanners !== null) {
    const subshellCmds = extractSubshellCommands(bashCommandForScanners, 0);
    for (const innerCmd of subshellCmds) {
      const innerResult = scanInnerCommand(innerCmd, 0);
      if (innerResult.failClosed) {
        return {
          block: true,
          reason: innerResult.reason,
          warnings,
          decision: { tier: 'BLOCK', actions: [], findings: [], ruleOfTwoTriggered: false },
        };
      }
    }
  }

  // Shared correlationId for all findings in this tool call
  const correlationId = crypto.randomBytes(8).toString('hex');

  for (const scanner of applicableScanners) {
    // Step 4a: Read scanner cache from disk
    const cached = readScannerCache(stateDir, scanner.id);

    if (!cached.valid) {
      // Step 4b: Cache missing or expired → fail-closed
      return {
        block: true,
        reason: `scanner ${scanner.id} cache ${cached.reason} (fail-closed)`,
        warnings,
        decision: { tier: 'BLOCK', actions: [], findings: [], ruleOfTwoTriggered: false },
      };
    }

    // Check scanner is in ARMED state
    const scannerState = registry.getState(scanner.id);
    if (scannerState !== 'ARMED') {
      // Not ARMED → fail-closed
      return {
        block: true,
        reason: `scanner ${scanner.id} is not ARMED (state: ${scannerState}) — fail-closed`,
        warnings,
        decision: { tier: 'BLOCK', actions: [], findings: [], ruleOfTwoTriggered: false },
      };
    }

    // Step 4c: Run scanner.evaluate() synchronously
    // P0-1 fix: Flatten input for scanner consumption. aisle-gate wraps tool_input
    // as { tool, input: {...} }, but scanners expect flat fields (command, file_path)
    // or tool_input. Spread input.input at top level so both access patterns work.
    //
    // W1.5: If bash segment cap truncated the command, override command in the
    // flattened input so all scanners see only the first MAX_SUBCOMMANDS segments.
    const rawToolInput = input.input || {};
    const effectiveToolInput = (toolType === 'Bash' && bashCommandForScanners !== null)
      ? { ...rawToolInput, command: bashCommandForScanners }
      : rawToolInput;

    const scannerInput = {
      tool: input.tool,
      tool_name: input.tool,           // Alias: some scanners read tool_name
      tool_input: effectiveToolInput,
      ...effectiveToolInput,
      agentId: input.agentId,
      agent_id: input.agentId,         // Alias: snake_case from stdin
      agentType: input.agentType,
      agent_type: input.agentType,
      sessionId: input.sessionId,
      session_id: input.sessionId,
    };

    const scanStart = Date.now();
    let scannerFindings;
    try {
      scannerFindings = scanner.evaluate(scannerInput, cached.state);
    } catch (err) {
      // Step 4e: Exception → treat as BLOCK finding (fail-closed)
      return {
        block: true,
        reason: `scanner ${scanner.id} threw exception: ${err && err.message ? err.message : String(err)}`,
        warnings,
        decision: { tier: 'BLOCK', actions: [], findings: [], ruleOfTwoTriggered: false },
      };
    }

    // Step 4d: Timing check — per-scanner 10ms warning threshold
    const elapsed = Date.now() - scanStart;
    totalElapsed += elapsed;

    if (elapsed > 10) {
      warnings.push(
        `scanner ${scanner.id} slow: ${elapsed}ms (budget 10ms per scanner)`
      );
    }

    // Step 4f: Collect findings — scanners return { allow, findings } objects
    const actualFindings = Array.isArray(scannerFindings)
      ? scannerFindings
      : (scannerFindings && Array.isArray(scannerFindings.findings)
        ? scannerFindings.findings
        : []);
    if (actualFindings.length > 0) {
      for (const f of actualFindings) {
        findings.push(f);
      }
    }
  }

  // --- Step 4.5: Apply learning confidence to modulate finding tiers --------
  // getTuning() is synchronous, O(1) hash lookup — negligible within 50ms budget.
  // Failure is non-fatal: applyLearningConfidence returns original findings on error.
  let modulatedFindings;
  try {
    modulatedFindings = applyLearningConfidence(findings);
  } catch {
    modulatedFindings = findings;
  }

  // --- Step 5: Pass findings to policy-engine.aggregate() ------------------
  const decision = policy.aggregate(modulatedFindings, config);

  // --- Step 6: Emit findings to event bus ----------------------------------
  // Emit modulatedFindings so the audit trail reflects the tiers actually used
  // in the policy decision (post-learning modulation), not the raw scanner tiers.
  for (const finding of modulatedFindings) {
    try {
      eventBus.emit({
        type: finding.tier || 'LOG',
        scanner: finding.scanner || null,
        tool: toolType,
        finding: finding.pattern || finding.message || JSON.stringify(finding),
        decision: decision.tier,
        correlationId,
      });
    } catch {
      // Event bus emission failure is non-fatal; audit trail gap is acceptable
      // over blocking production tool calls
    }
  }

  // --- Step 7: Return decision ---------------------------------------------
  const block = decision.tier === 'BLOCK';

  let reason = '';
  if (block) {
    const blockers = modulatedFindings
      .filter(f => f.tier === 'BLOCK')
      .map(f => {
        const scanner = f.scanner || '?';
        const pattern = f.pattern || f.title || 'unknown';
        const detail = f.detail || f.description || '';
        return detail ? `[${scanner}:${pattern}] ${detail}` : `[${scanner}:${pattern}]`;
      });
    const parts = blockers.length > 0
      ? blockers.join('; ')
      : `${modulatedFindings.length} finding(s)`;
    reason = `policy decision: BLOCK — ${parts}`;
  }

  return { block, reason, warnings, decision };
}

// ---------------------------------------------------------------------------
// getState(stateDir) — delegates to boot.cjs getState
//
// NOTE: boot.cjs is implemented in T6. For now, we fall back to an inline
// implementation that reads the state from disk. Tests mock this dependency.
// ---------------------------------------------------------------------------

function getState(stateDir) {
  try {
    const bootPath = path.resolve(__dirname, './boot.cjs');
    const boot = require(bootPath);
    return boot.getState(stateDir);
  } catch {
    // P1-5 fix: fallback must return a string, not an object.
    // aisle-gate.cjs checks `state === "setup-required"` (strict string equality).
    // The old fallback returned `{ initialized, stateDir, cacheDir }` which is
    // truthy but !== any string, causing the wizard branch to be silently skipped
    // and all tools to pass (SILENT FAIL-OPEN).
    const configPath = path.join(stateDir, 'aisle-config.json');
    const cacheDir   = path.join(stateDir, 'scanner-cache');

    if (!fs.existsSync(configPath)) return 'setup-required';

    // P2-8 fix: read the boot marker `state` and honour non-operational states.
    // Mirrors the fix in boot.cjs getState(): trust 'degraded'/'fail-closed' from
    // the marker immediately; for 'operational' still verify cache dir exists.
    let markerState = null;
    try {
      const marker = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (marker && typeof marker.state === 'string') {
        markerState = marker.state;
      }
    } catch {
      // Unreadable — fall through to filesystem inference
    }

    if (markerState === 'degraded' || markerState === 'fail-closed') return markerState;

    if (!fs.existsSync(cacheDir)) return 'degraded';
    return 'operational';
  }
}

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------

module.exports = {
  evaluate,
  getState,
  // Exposed for testing
  _readScannerCache: readScannerCache,
  _extractSubshellCommands: extractSubshellCommands,
  _applyLearningConfidence: applyLearningConfidence,
  _ESCALATE_THRESHOLD: ESCALATE_THRESHOLD,
  _DEMOTE_THRESHOLD: DEMOTE_THRESHOLD,
};
