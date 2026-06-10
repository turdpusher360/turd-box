#!/usr/bin/env node
'use strict';

/**
 * server.cjs — AISLE Hook Server
 *
 * Persistent HTTP server that runs the AISLE security gate logic in a single
 * long-lived process. Replaces per-invocation subprocess hooks with in-memory
 * evaluation.
 *
 * Startup: node lib/aisle/server.cjs (from project root)
 * Port: OS-assigned (port 0). Written to <cwd>/_runs/os/aisle-server.port.
 * PID: Written to <cwd>/_runs/os/aisle-server.pid.
 * Auto-shutdown: DISABLED by default (upstream fix). Previously 30min idle produced
 *   silent security gap — shims fail-open when port unreachable, so once the
 *   server died mid-session there was zero scanner coverage until next SessionStart.
 *   Set env AISLE_IDLE_TIMEOUT_MS=<ms> to re-enable idle-shutdown if needed.
 *   Graceful shutdown still available via POST /shutdown and SIGTERM/SIGINT.
 *
 * Endpoints:
 *   POST /gate         — PreToolUse gate evaluation
 *   POST /prompt-guard — UserPromptSubmit credential scan (warn-only)
 *   POST /learn        — Learning loop feedback intake (FP/TP)
 *   GET  /health       — Operational health check
 *   GET  /posture      — Full scanner posture report
 *   POST /shutdown     — Graceful shutdown
 *
 * Design invariants:
 *   - Fail-closed on any gate error path
 *   - No external npm dependencies — Node.js built-ins only
 *   - All synchronous (matches existing AISLE module contracts)
 *   - ReDoS guard on secret patterns (same as aisle-prompt-guard.cjs)
 *
 * @see docs/superpowers/specs/2026-04-12-aisle-hook-server-design.md
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// upstream: idle-shutdown disabled by default. Env override keeps the feature
// available for testing / manual opt-in. Any non-numeric or non-positive value
// keeps idle-shutdown off.
const _rawIdleMs = parseInt(process.env.AISLE_IDLE_TIMEOUT_MS || '', 10);
const IDLE_TIMEOUT_MS = Number.isFinite(_rawIdleMs) && _rawIdleMs > 0
  ? _rawIdleMs
  : 0; // 0 = disabled
const IDLE_CHECK_INTERVAL_MS = 60 * 1000; // check every 60 seconds (only runs if enabled)
const LISTEN_HOST = '127.0.0.1'; // IPv4 loopback only — no DNS, no IPv6 ambiguity
const MAX_BODY_SIZE = 5 * 1024 * 1024; // 5MB — prevents memory exhaustion via crafted POST

const PORT_DIR = path.join(process.cwd(), '_runs', 'os');
const PORT_FILE = path.join(PORT_DIR, 'aisle-server.port');
const PID_FILE = path.join(PORT_DIR, 'aisle-server.pid');

// ---------------------------------------------------------------------------
// Module-level server state
// ---------------------------------------------------------------------------

/** @type {string} Resolved AISLE state directory */
let _stateDir = '';

/** @type {object|null} Result from boot() */
let _bootResult = null;

/** @type {Array<{ regex: RegExp, label: string }>} Compiled secret patterns */
let _compiledPatterns = null;
let _patternLoadError = null; // set when secret-patterns.json fails to load (fail-loud signal)

/** @type {number} Timestamp of the last request received */
let _lastRequestMs = Date.now();

/** @type {number} Total requests served since startup */
let _requestCount = 0;

/** @type {number} Server start timestamp */
let _startTime = Date.now();

/** @type {NodeJS.Timer|null} Idle check interval handle */
let _idleTimer = null;

/** @type {http.Server|null} The HTTP server instance */
let _server = null;

/** @type {string|null} HMAC secret loaded from stateDir/hmac-secret at startup */
let _hmacSecret = null;

// ---------------------------------------------------------------------------
// File cleanup helpers
// ---------------------------------------------------------------------------

/**
 * Remove port and PID files. Non-fatal on error.
 */
function cleanupFiles() {
  [PORT_FILE, PID_FILE].forEach((filePath) => {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (_err) {
      // Non-fatal — we are already shutting down
    }
  });
}

// ---------------------------------------------------------------------------
// HMAC authentication for mutating endpoints (/shutdown, /learn)
// ---------------------------------------------------------------------------

/**
 * Verify the X-AISLE-HMAC header on a request.
 * The header value must be HMAC-SHA256(request_body, hmac_secret) in hex.
 * Uses timing-safe comparison to prevent timing attacks.
 *
 * @param {http.IncomingMessage} req - The incoming request
 * @param {string} body - The raw request body string
 * @returns {boolean} true if HMAC is valid, false otherwise
 */
function verifyRequestHmac(req, body) {
  if (!_hmacSecret) return false;

  const provided = req.headers['x-aisle-hmac'];
  if (!provided || typeof provided !== 'string') return false;

  const expected = crypto.createHmac('sha256', _hmacSecret)
    .update(body)
    .digest('hex');

  // Length guard: timingSafeEqual throws on length mismatch
  const expectedBuf = Buffer.from(expected, 'hex');
  const providedBuf = Buffer.from(provided, 'hex');
  if (expectedBuf.length !== providedBuf.length) return false;

  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

/**
 * Perform graceful shutdown: stop idle timer, close HTTP server, clean up
 * port/PID files, then exit.
 *
 * @param {string} reason - Human-readable reason for shutdown (for stderr)
 */
function shutdown(reason) {
  process.stderr.write(`[AISLE-SERVER] Shutting down: ${reason}\n`);

  if (_idleTimer) {
    clearInterval(_idleTimer);
    _idleTimer = null;
  }

  // Flush learning state before exit (belt-and-suspenders — per-feedback save is primary)
  if (_stateDir) {
    try {
      const learning = require('./core/learning.cjs');
      learning.saveState(_stateDir);
    } catch (_err) {
      // Non-fatal — shutting down anyway
    }
  }

  cleanupFiles();

  if (_server) {
    _server.close();
  }
  // Event loop drains naturally after server.close() + timer cleared.
  // Signal handlers below call process.exit() explicitly for hard shutdown.
}

// Signal handlers — hard exit after cleanup
process.on('SIGTERM', () => { shutdown('SIGTERM'); process.exit(0); });
process.on('SIGINT', () => { shutdown('SIGINT'); process.exit(0); });

// ---------------------------------------------------------------------------
// Idle auto-shutdown
// ---------------------------------------------------------------------------

/**
 * Start the idle check interval. Calls shutdown() if no requests have been
 * received for IDLE_TIMEOUT_MS. No-op when IDLE_TIMEOUT_MS <= 0 (upstream default).
 */
function startIdleTimer() {
  // upstream: skip wiring the timer entirely when disabled so the event loop
  // doesn't carry a dormant interval (belt-and-suspenders with unref()).
  if (!IDLE_TIMEOUT_MS || IDLE_TIMEOUT_MS <= 0) {
    process.stderr.write('[AISLE-SERVER] Idle auto-shutdown disabled (AISLE_IDLE_TIMEOUT_MS unset or 0)\n');
    return;
  }

  _idleTimer = setInterval(() => {
    const idleMs = Date.now() - _lastRequestMs;
    if (idleMs > IDLE_TIMEOUT_MS) {
      shutdown(`idle timeout (${Math.round(idleMs / 1000)}s idle)`);
    }
  }, IDLE_CHECK_INTERVAL_MS);

  // Don't prevent exit if only the timer is keeping the event loop alive
  if (_idleTimer.unref) _idleTimer.unref();
}

// ---------------------------------------------------------------------------
// Secret pattern loading (for /prompt-guard)
// ---------------------------------------------------------------------------

/**
 * Load and compile secret patterns from data/secret-patterns.json.
 * P1-8: ReDoS guard — skip patterns >200 chars or with nested quantifiers.
 * Cached after first call.
 *
 * @returns {Array<{ regex: RegExp, label: string }>}
 */
function loadPatterns() {
  if (_compiledPatterns !== null) return _compiledPatterns;

  const patternsPath = path.join(__dirname, 'data', 'secret-patterns.json');
  _compiledPatterns = [];

  try {
    const raw = fs.readFileSync(patternsPath, 'utf8');
    const data = JSON.parse(raw);
    for (const p of data.patterns) {
      // ReDoS guards — same logic as aisle-prompt-guard.cjs
      if (typeof p.regex !== 'string' || p.regex.length > 200) continue;
      if (/[+*]\)[+*]/.test(p.regex)) continue;
      try {
        _compiledPatterns.push({ regex: new RegExp(p.regex), label: p.label });
      } catch {
        // Skip patterns that fail to compile
      }
    }
    _patternLoadError = null;
  } catch (err) {
    // FAIL-LOUD: record the failure so an empty pattern set is never mistaken for a
    // clean scan. prompt-guard is warn-only (cannot block), so callers surface a
    // DEGRADED warning instead of silently passing every prompt.
    _patternLoadError = (err && (err.code || err.message)) || 'unknown error';
    process.stderr.write(`[AISLE-SERVER] ERROR: could not load secret-patterns.json (${_patternLoadError}) — prompt-guard scan DEGRADED, no patterns active\n`);
  }

  return _compiledPatterns;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

/**
 * Read the full request body as a UTF-8 string.
 *
 * @param {http.IncomingMessage} req
 * @returns {Promise<string>}
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      size += Buffer.byteLength(chunk, 'utf8');
      if (size > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

/**
 * Send a JSON response.
 *
 * @param {http.ServerResponse} res
 * @param {number} statusCode - HTTP status code
 * @param {object} payload    - Response body (will be JSON.stringify'd)
 */
function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

// ---------------------------------------------------------------------------
// Gate endpoint logic (mirrors aisle-gate.cjs)
// ---------------------------------------------------------------------------

/**
 * Evaluate a tool call against the AISLE gate.
 * Replicates the logic from .claude/hooks/aisle-gate.cjs in-process.
 *
 * @param {object} input - Parsed hook stdin JSON
 * @returns {{ exitCode: number, stdout: string, stderr: string }}
 */
function evaluateGate(input) {
  // ATK-3: fail-closed on missing tool_name
  if (!input || !input.tool_name) {
    return {
      exitCode: 2,
      stdout: '',
      stderr: '[AISLE] FAIL-CLOSED: missing tool_name\n',
    };
  }

  try {
    const { evaluate, getState } = require('./core/gate-evaluator.cjs');
    // config loaded at startup — not needed per-request (stateDir already resolved)
    const { checkTransform } = require('./transforms.cjs');
    const { buildCapabilityOutput } = require('../../lib/hook-utils.cjs');

    // Resolve stateDir (uses module-level _stateDir set at startup)
    const stateDir = _stateDir;

    // Setup-mode bypass: if AISLE not configured, pass through silently
    if (!stateDir) {
      return {
        exitCode: 0,
        stdout: '',
        stderr: '[AISLE] Not configured for this project — passing through.\n',
      };
    }

    // Check AISLE operational state
    const state = getState(stateDir);
    if (state === 'setup-required') {
      return {
        exitCode: 0,
        stdout: '',
        stderr: '[AISLE] Setup incomplete (state dir missing) — passing through. Run /aisle to finish setup.\n',
      };
    }

    // --- TRANSFORM MODE (upstream) ---
    const rawInput = input.tool_input || {};
    try {
      const xform = checkTransform(input.tool_name, rawInput);
      if (xform.matched) {
        const stdout = buildCapabilityOutput('aisle-gate', 'PreToolUse', {
          updatedInput: xform.transformed,
        }, { transform: xform.reason });
        return {
          exitCode: 0,
          stdout,
          stderr: `[AISLE] TRANSFORM: ${xform.reason}\n`,
        };
      }
    } catch (err) {
      // Fail-closed for privilege-reduction transforms; fail-open otherwise
      const rawMode = (rawInput.mode || '').toLowerCase();
      if (input.tool_name === 'Agent' && rawMode === 'bypasspermissions') {
        return {
          exitCode: 2,
          stdout: '',
          stderr: `[AISLE] FAIL-CLOSED: transform error on privilege path: ${err.message}\n`,
        };
      }
      process.stderr.write(`[AISLE] Transform check failed: ${err.message} — proceeding with evaluation\n`);
    }

    // Map stdin fields to ToolInput contract (P1 interface mismatch fix)
    const toolInput = {
      tool: input.tool_name,
      input: input.tool_input || {},
      agentId: input.agent_id || null,
      agentType: input.agent_type || null,
      sessionId: input.session_id,
    };

    const result = evaluate(toolInput, stateDir);

    if (result.block) {
      return {
        exitCode: 2,
        stdout: '',
        stderr: `[AISLE] ${result.reason}\n`,
      };
    }

    // WARN output: plain text (not hookSpecificOutput)
    let stdout = '';
    if (result.warnings && result.warnings.length > 0) {
      stdout = result.warnings.join('\n') + '\n';
    }

    return {
      exitCode: 0,
      stdout,
      stderr: '',
    };
  } catch (err) {
    // Uncaught exception — fail-closed (same invariant as the hook)
    return {
      exitCode: 2,
      stdout: '',
      stderr: `[AISLE] FAIL-CLOSED: ${err.message}\n`,
    };
  }
}

// ---------------------------------------------------------------------------
// Prompt-guard endpoint logic (mirrors aisle-prompt-guard.cjs)
// ---------------------------------------------------------------------------

/**
 * Scan a user prompt for credential patterns.
 * Always returns exitCode 0 (warn-only, UserPromptSubmit cannot block).
 *
 * @param {object} input - Parsed hook stdin JSON
 * @returns {{ exitCode: number, stdout: string, stderr: string }}
 */
function evaluatePromptGuard(input) {
  const prompt = (input && (input.prompt || input.content || input.message)) || '';

  if (!prompt) {
    return { exitCode: 0, stdout: '', stderr: '' };
  }

  const patterns = loadPatterns();
  if (_patternLoadError) {
    // Patterns unavailable — do NOT report a false "clean". Warn-only contract
    // (exitCode 0) is preserved; the degradation is surfaced on stderr.
    return {
      exitCode: 0,
      stdout: '',
      stderr: `[AISLE] WARNING: secret-pattern scan DEGRADED (patterns unavailable: ${_patternLoadError}). Prompt was NOT scanned for credentials.\n`,
    };
  }
  for (const { regex, label } of patterns) {
    if (regex.test(prompt)) {
      return {
        exitCode: 0,
        stdout: `[AISLE] Potential ${label} detected in prompt. Remove secrets before submitting.\n`,
        stderr: '',
      };
    }
  }

  return { exitCode: 0, stdout: '', stderr: '' };
}

// ---------------------------------------------------------------------------
// Health endpoint logic
// ---------------------------------------------------------------------------

/**
 * Build the /health response payload.
 *
 * @returns {object}
 */
function buildHealthPayload() {
  const scannerRegistry = require('./core/scanner-registry.cjs');
  const healthMonitor = require('./core/health-monitor.cjs');
  const config = require('./core/config.cjs');

  const scanners = {};
  for (const scanner of scannerRegistry.getAll()) {
    scanners[scanner.id] = scannerRegistry.getState(scanner.id) || 'UNKNOWN';
  }

  let posture;
  try {
    const projectId = config.deriveProjectId();
    const configResult = config.loadConfig(projectId);
    const postureReport = healthMonitor.getPosture(
      scannerRegistry,
      configResult ? configResult.config : null
    );
    posture = postureReport.overall;
  } catch (_err) {
    posture = 'unknown';
  }

  const nowMs = Date.now();
  const idleMs = nowMs - _lastRequestMs;

  return {
    status: 'operational',
    uptime_ms: nowMs - _startTime,
    scanners,
    posture,
    requests_served: _requestCount,
    boot_result: _bootResult || null,
    idle_ms: idleMs,
    // upstream: shutdown_at_ms = 0 signals auto-shutdown disabled. Kept as number
    // to preserve the /health contract (server.test.js typeof === 'number').
    shutdown_at_ms: IDLE_TIMEOUT_MS,
    idle_shutdown_enabled: IDLE_TIMEOUT_MS > 0,
  };
}

// ---------------------------------------------------------------------------
// Posture endpoint logic
// ---------------------------------------------------------------------------

/**
 * Build the /posture response payload (full scanner posture report).
 *
 * @returns {object}
 */
function buildPosturePayload() {
  const scannerRegistry = require('./core/scanner-registry.cjs');
  const healthMonitor = require('./core/health-monitor.cjs');
  const config = require('./core/config.cjs');

  const projectId = config.deriveProjectId();
  const configResult = config.loadConfig(projectId);
  return healthMonitor.getPosture(
    scannerRegistry,
    configResult ? configResult.config : null
  );
}

// ---------------------------------------------------------------------------
// Request router
// ---------------------------------------------------------------------------

/**
 * Main HTTP request handler. Routes incoming requests to the appropriate
 * endpoint handler, updates idle timestamp, increments request counter.
 *
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 */
async function handleRequest(req, res) {
  _lastRequestMs = Date.now();
  _requestCount++;

  const { method, url } = req;

  try {
    // POST /gate — PreToolUse gate evaluation
    if (method === 'POST' && url === '/gate') {
      let input;
      try {
        const body = await readBody(req);
        input = body.trim() ? JSON.parse(body) : {};
      } catch (err) {
        if (err.message === 'Request body too large') {
          sendJson(res, 413, { error: 'Request body too large' });
          return;
        }
        input = {};
      }
      const result = evaluateGate(input);
      sendJson(res, 200, result);
      return;
    }

    // POST /prompt-guard — UserPromptSubmit credential scan
    if (method === 'POST' && url === '/prompt-guard') {
      let input;
      try {
        const body = await readBody(req);
        input = body.trim() ? JSON.parse(body) : {};
      } catch (err) {
        if (err.message === 'Request body too large') {
          sendJson(res, 413, { error: 'Request body too large' });
          return;
        }
        input = {};
      }
      const result = evaluatePromptGuard(input);
      sendJson(res, 200, result);
      return;
    }

    // GET /health — operational health check
    if (method === 'GET' && url === '/health') {
      try {
        const payload = buildHealthPayload();
        sendJson(res, 200, payload);
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
      return;
    }

    // GET /posture — full scanner posture report
    if (method === 'GET' && url === '/posture') {
      try {
        const payload = buildPosturePayload();
        sendJson(res, 200, payload);
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
      return;
    }

    // POST /learn — feedback intake for learning loop (HMAC-authenticated)
    if (method === 'POST' && url === '/learn') {
      let input;
      let rawBody;
      try {
        rawBody = await readBody(req);
        input = rawBody.trim() ? JSON.parse(rawBody) : {};
      } catch (err) {
        if (err.message === 'Request body too large') {
          sendJson(res, 413, { error: 'Request body too large' });
          return;
        }
        sendJson(res, 400, { error: 'Invalid JSON' });
        return;
      }

      // HMAC auth: reject unauthenticated requests when secret is available
      if (_hmacSecret) {
        if (!verifyRequestHmac(req, rawBody || '')) {
          sendJson(res, 403, { error: 'Invalid or missing X-AISLE-HMAC header' });
          return;
        }
      } else {
        const remote = req.socket.remoteAddress;
        const isLocal = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
        if (!isLocal) {
          sendJson(res, 403, { error: 'Learn requires HMAC or localhost' });
          return;
        }
      }

      const { findingId, feedback, agentId } = input;

      if (!findingId || !feedback || !feedback.type) {
        sendJson(res, 400, { error: 'Required: findingId, feedback.type (FP|TP)' });
        return;
      }

      try {
        const learning = require('./core/learning.cjs');
        const result = learning.processFeedback(findingId, feedback, agentId || 'operator');

        // Persist after any accepted feedback — observation counts and agent
        // tallies mutate on every ok path, not just when confidence adjusts
        if (result.ok && _stateDir) {
          learning.saveState(_stateDir);
        }

        sendJson(res, 200, result);
      } catch (err) {
        sendJson(res, 500, { error: `Learning feedback failed: ${err.message}` });
      }
      return;
    }

    // POST /shutdown — graceful shutdown (HMAC-authenticated)
    if (method === 'POST' && url === '/shutdown') {
      // Read body for HMAC verification (may be empty)
      let rawBody = '';
      try {
        rawBody = await readBody(req);
      } catch { /* non-fatal — empty body is valid for shutdown */ }

      // Shutdown auth: HMAC when available, localhost-only fallback
      if (_hmacSecret) {
        if (!verifyRequestHmac(req, rawBody)) {
          sendJson(res, 403, { error: 'Invalid or missing X-AISLE-HMAC header' });
          return;
        }
      } else {
        const remote = req.socket.remoteAddress;
        const isLocal = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
        if (!isLocal) {
          sendJson(res, 403, { error: 'Shutdown requires HMAC or localhost' });
          return;
        }
      }

      sendJson(res, 200, { ok: true });
      // Defer shutdown so the response can be flushed
      // eslint-disable-next-line no-undef -- setImmediate is a Node.js global
      setImmediate(() => shutdown('POST /shutdown'));
      return;
    }

    // 404 for unknown routes
    sendJson(res, 404, { error: `Unknown route: ${method} ${url}` });
  } catch (err) {
    // Unhandled error in routing — return 500, do not crash the server
    process.stderr.write(`[AISLE-SERVER] Unhandled request error: ${err.message}\n`);
    try {
      sendJson(res, 500, { error: 'Internal server error' });
    } catch (_writeErr) {
      // Response write failed — ignore
    }
  }
}

// ---------------------------------------------------------------------------
// Startup sequence
// ---------------------------------------------------------------------------

/**
 * Run the full AISLE startup sequence:
 * 1. Resolve stateDir via config module
 * 2. Load scanners into registry
 * 3. Run boot sequence
 * 4. Compile secret patterns for prompt-guard
 * 5. Start HTTP server on port 0
 * 6. Write port/PID files
 * 7. Start idle timer
 *
 * Exits with code 1 on fatal errors so the calling boot hook can fail-open.
 */
function startup() {
  process.stderr.write('[AISLE-SERVER] Starting up...\n');

  // --- Step 1: Resolve stateDir ---
  let stateDir;
  try {
    const config = require('./core/config.cjs');
    const projectId = config.deriveProjectId();
    const configResult = config.loadConfig(projectId);

    if (!configResult) {
      process.stderr.write('[AISLE-SERVER] No config found for this project — shims will fail-open.\n');
      // Continue startup anyway — /health endpoint is still useful
      stateDir = null;
    } else {
      stateDir = config.resolveStateDir(configResult.config);
    }
  } catch (err) {
    process.stderr.write(`[AISLE-SERVER] Fatal: could not resolve stateDir: ${err.message}\n`);
    process.exit(1);
  }

  _stateDir = stateDir || '';

  // Propagate to AISLE modules that read AISLE_STATE_DIR from env
  if (stateDir) {
    process.env.AISLE_STATE_DIR = stateDir;
  }

  // --- Step 2: Load scanners into registry ---
  try {
    const scannerRegistry = require('./core/scanner-registry.cjs');
    const scannerDir = path.join(__dirname, 'scanners');
    const scannerFiles = fs.readdirSync(scannerDir)
      .filter((f) => f.endsWith('.cjs') && f !== 'event-bus.cjs');

    for (const file of scannerFiles) {
      const result = scannerRegistry.load(path.join(scannerDir, file));
      if (!result.success) {
        process.stderr.write(`[AISLE-SERVER] Warning: scanner load failed (${file}): ${result.error}\n`);
      }
    }
  } catch (err) {
    process.stderr.write(`[AISLE-SERVER] Warning: scanner loading failed: ${err.message}\n`);
    // Non-fatal — server can run in degraded state
  }

  // --- Step 3: Run AISLE boot sequence ---
  if (stateDir) {
    try {
      const { boot } = require('./core/boot.cjs');
      _bootResult = boot(null, stateDir, null);
      process.stderr.write(`[AISLE-SERVER] Boot complete: state=${_bootResult.state}, time=${_bootResult.bootTimeMs}ms\n`);
    } catch (err) {
      process.stderr.write(`[AISLE-SERVER] Boot failed: ${err.message}\n`);
      // Non-fatal — server starts, gate will use fail-closed paths
      _bootResult = { state: 'degraded', bootTimeMs: 0, health: { errors: [err.message] } };
    }

    // --- Step 3b: Arm scanners that passed boot --------------------------------
    // upstream fix: boot.cjs writes scanner cache files and runs canaries but never
    // calls registry.transition() to advance scanners past LOAD state. In the old
    // per-process architecture this didn't matter — each hook invocation had an
    // empty registry, so gate-evaluator's ARMED check was never reached. In the
    // persistent server, scanners stay in LOAD and gate-evaluator fail-closes.
    // Fix: after boot, walk each scanner through the full lifecycle to ARMED if
    // boot succeeded (operational/degraded). Skip arming on fail-closed/setup-required.
    if (_bootResult && _bootResult.state !== 'fail-closed' && _bootResult.state !== 'setup-required') {
      const scannerRegistry = require('./core/scanner-registry.cjs');
      const canaries = (_bootResult.health && _bootResult.health.canaries) || {};
      let armedCount = 0;
      let skipCount = 0;

      for (const scanner of scannerRegistry.getAll()) {
        const sid = scanner.id;
        const currentState = scannerRegistry.getState(sid);

        // Only arm scanners still in LOAD state (not already transitioned)
        if (currentState !== 'LOAD') continue;

        // Skip scanners whose canary explicitly failed
        if (canaries[sid] === 'fail') {
          process.stderr.write(`[AISLE-SERVER] Scanner ${sid}: canary failed, not arming\n`);
          skipCount++;
          continue;
        }

        // Walk through the full lifecycle: LOAD -> VALIDATE -> REGISTER -> SELF-TEST -> INIT -> ARMED
        const lifecycle = ['VALIDATE', 'REGISTER', 'SELF-TEST', 'INIT', 'ARMED'];
        let armed = true;
        for (const nextState of lifecycle) {
          const result = scannerRegistry.transition(sid, nextState);
          if (!result.success) {
            process.stderr.write(`[AISLE-SERVER] Scanner ${sid}: transition to ${nextState} failed: ${result.error}\n`);
            armed = false;
            skipCount++;
            break;
          }
        }

        if (armed) {
          armedCount++;
        }
      }

      process.stderr.write(`[AISLE-SERVER] Scanner arming: ${armedCount} armed, ${skipCount} skipped\n`);
    }
  } else {
    _bootResult = { state: 'setup-required', bootTimeMs: 0 };
  }

  // --- Step 3c: Load persisted learning state ---
  if (stateDir) {
    try {
      const learning = require('./core/learning.cjs');
      learning.loadState(stateDir);
    } catch (err) {
      process.stderr.write(`[AISLE-SERVER] Warning: learning state load failed: ${err.message}\n`);
      // Non-fatal — learning operates in degraded/fresh mode
    }
  }

  // --- Step 3d: Load HMAC secret for endpoint authentication ---
  if (stateDir) {
    try {
      const hmacPath = path.join(stateDir, 'hmac-secret');
      _hmacSecret = fs.readFileSync(hmacPath, 'utf8').trim();
      process.stderr.write('[AISLE-SERVER] HMAC secret loaded — /shutdown and /learn require authentication\n');
    } catch (err) {
      process.stderr.write(`[AISLE-SERVER] Warning: HMAC secret not found (${err.code || err.message}) — /shutdown and /learn unauthenticated\n`);
      // Non-fatal — endpoints operate without auth (setup-mode or first boot)
      _hmacSecret = null;
    }
  }

  // --- Step 4: Compile secret patterns (eager load so first /prompt-guard is fast) ---
  loadPatterns();
  if (_patternLoadError) {
    process.stderr.write(`[AISLE-SERVER] ERROR: secret-pattern scan DEGRADED at boot (${_patternLoadError}) — prompt-guard will report scans as unverified\n`);
  } else {
    process.stderr.write(`[AISLE-SERVER] Loaded ${_compiledPatterns.length} secret patterns\n`);
  }

  // --- Step 5: Create and start HTTP server ---
  _server = http.createServer(handleRequest);

  _server.on('error', (err) => {
    process.stderr.write(`[AISLE-SERVER] Server error: ${err.message}\n`);
    if (err.code === 'EADDRINUSE') {
      process.exit(1);
    }
  });

  // Listen on port 0 — OS assigns an available port
  _server.listen(0, LISTEN_HOST, () => {
    const address = _server.address();
    const port = address.port;

    process.stderr.write(`[AISLE-SERVER] Listening on ${LISTEN_HOST}:${port} (pid ${process.pid})\n`);

    // --- Step 6: Write port and PID files ---
    try {
      fs.mkdirSync(PORT_DIR, { recursive: true });
      fs.writeFileSync(PORT_FILE, String(port), 'utf8');
      fs.writeFileSync(PID_FILE, String(process.pid), 'utf8');
    } catch (err) {
      process.stderr.write(`[AISLE-SERVER] Warning: could not write port/PID files: ${err.message}\n`);
      // Non-fatal — shims can still fail-open if they cannot read the port file
    }

    // --- Step 7: Start idle auto-shutdown timer ---
    _startTime = Date.now();
    _lastRequestMs = Date.now();
    startIdleTimer();

    process.stderr.write('[AISLE-SERVER] Ready\n');
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

startup();
