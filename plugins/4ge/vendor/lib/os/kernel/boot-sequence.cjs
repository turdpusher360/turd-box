'use strict';

/**
 * boot-sequence.cjs
 *
 * Ordered SessionStart initialization for the Agentic OS.
 *
 * Full boot (source !== 'compact') runs 6 steps in sequence:
 *   1. health:memory    — HTTP GET to memory hub (skip if url is null)
 *   2. health:agents    — Verify agents directory exists with .md files
 *   3. init:registry    — Create state directory structure
 *   4. init:contracts   — Parse all agent frontmatter via contracts.parse()
 *   5. init:observability — Touch activity.jsonl to verify writability
 *   6. report:status    — Build summary string
 *
 * Compact re-boot (source === 'compact') skips expensive re-initialization:
 *   - Skips: health:memory, health:agents, init:contracts (already done at initial boot)
 *   - Runs: init:registry (verify state dir), init:observability, report:status
 *
 * If step 3 (init:registry) fails, osEnabled = false (filesystem broken).
 * All other failures degrade gracefully — osEnabled stays true.
 *
 * Writes .boot-status JSON at end:
 *   { osEnabled, bootTime: ISO, degraded: [step names], source: string }
 */

const fs = require('node:fs');
const path = require('node:path');
const { createObservability } = require('../services/observability.cjs');

// ---------------------------------------------------------------------------
// Internal: timed step runner
// ---------------------------------------------------------------------------

/**
 * Run a step function and capture timing + status.
 *
 * @param {string} name - Step identifier
 * @param {() => 'ok'|'degraded'|'failed'} fn - Step implementation
 * @returns {{ name: string, status: string, ms: number }}
 */
function runStep(name, fn) {
  const start = performance.now();
  let status;
  try {
    status = fn();
  } catch {
    status = 'failed';
  }
  const ms = Math.round(performance.now() - start);
  return { name, status, ms };
}

// ---------------------------------------------------------------------------
// Boot steps
// ---------------------------------------------------------------------------

/**
 * Step 1: health:memory
 * HTTP GET to memoryHubUrl with 2s timeout. Skip if null.
 */
function stepHealthMemory(memoryHubUrl) {
  if (!memoryHubUrl) return 'ok'; // skip — no URL configured

  // Validate URL format before embedding in child process code
  try { new URL(memoryHubUrl); } catch { return 'degraded'; }

  try {
    // Synchronous HTTP check with 2s timeout via spawnSync
    const { spawnSync } = require('node:child_process');
    const result = spawnSync('node', [
      '-e',
      `const http = require('node:http');
       const url = new URL(${JSON.stringify(memoryHubUrl)});
       const req = http.get({ hostname: url.hostname, port: url.port, path: '/health', timeout: 2000 }, (res) => {
         process.exit(res.statusCode < 500 ? 0 : 1);
       });
       req.on('error', () => process.exit(1));
       req.on('timeout', () => { req.destroy(); process.exit(1); });`,
    ], { timeout: 3000, stdio: 'ignore' });

    return result.status === 0 ? 'ok' : 'degraded';
  } catch {
    return 'degraded';
  }
}

/**
 * Step 2: health:agents
 * Check agentsDir exists and has .md files.
 */
function stepHealthAgents(agentsDir) {
  if (!fs.existsSync(agentsDir)) return 'degraded';

  const files = fs.readdirSync(agentsDir).filter(f => f.endsWith('.md'));
  return files.length > 0 ? 'ok' : 'degraded';
}

/**
 * Step 3: init:registry
 * Create state directory structure. REQUIRED — if this fails, osEnabled = false.
 */
function stepInitRegistry(stateDir) {
  fs.mkdirSync(stateDir, { recursive: true });
  // Verify we can write
  const testPath = path.join(stateDir, '.write-test');
  fs.writeFileSync(testPath, '1');
  fs.unlinkSync(testPath);
  return 'ok';
}

/**
 * Step 4: init:contracts
 * Read all agent .md files, parse frontmatter, and register contracts.
 *
 * @param {string} agentsDir
 * @param {object|null|undefined} enforcer - optional capability-enforcer instance.
 *   When truthy: registers a permissive 'lead' contract and registers each
 *   parsed agent contract via enforcer.registerContract(). When falsy:
 *   behaves exactly as before (parse-and-discard) — zero behaviour change.
 */
function stepInitContracts(agentsDir, enforcer) {
  if (!fs.existsSync(agentsDir)) return 'degraded';

  const contracts = require('./contracts.cjs');
  const files = fs.readdirSync(agentsDir).filter(f => f.endsWith('.md'));
  let parsed = 0;

  // Register a permissive lead contract so the main session agent is never
  // blocked when enforcement is eventually activated.
  if (enforcer) {
    try {
      enforcer.registerContract('lead', { tools: ['*'], scope: { write: ['*'], read: ['*'] } });
    } catch {
      // non-fatal — if registerContract throws, continue without lead contract
    }
  }

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(agentsDir, file), 'utf8');
      const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (fmMatch) {
        const parsed_contract = contracts.parse(fmMatch[1]);
        parsed++;
        if (enforcer) {
          const agentName = file.replace(/\.md$/, '');
          enforcer.registerContract(agentName, parsed_contract);
        }
      }
    } catch {
      // skip malformed files
    }
  }

  return parsed > 0 ? 'ok' : 'degraded';
}

/**
 * Step 6: init:observability
 * Touch activity.jsonl to verify writability.
 */
function stepInitObservability(stateDir) {
  const jsonlPath = path.join(stateDir, 'activity.jsonl');
  // Touch the file — create if missing, leave contents alone if exists
  fs.closeSync(fs.openSync(jsonlPath, 'a'));
  // Verify readable
  fs.readFileSync(jsonlPath, 'utf8');
  return 'ok';
}

/**
 * Step 7: report:status
 * Build summary string from step results.
 * Always returns 'ok' (it's just summarizing).
 */
function stepReportStatus() {
  return 'ok';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the boot sequence.
 *
 * @param {{ agentsDir: string, stateDir: string, memoryHubUrl: string|null, source?: string, enforcer?: object }} opts
 *   source: 'compact' triggers a lightweight re-boot that skips expensive discovery steps.
 *           Any other value (or omitted) runs the full boot sequence.
 *   enforcer: optional capability-enforcer instance. When provided, contract registration
 *             is wired during the init:contracts step (RBAC-ENF-001 Phase 1). When omitted
 *             or null, step 4 behaves identically to the pre-Phase-1 parse-and-discard path.
 * @returns {{
 *   osEnabled: boolean,
 *   source: string,
 *   steps: Array<{ name: string, status: string, ms: number }>,
 *   summary: string,
 * }}
 */
function run({ agentsDir, stateDir, memoryHubUrl, source, enforcer }) {
  const isCompact = source === 'compact';
  const steps = [];
  let osEnabled = true;
  const bootT0 = Date.now();

  if (isCompact) {
    // --- Compact re-boot path ---
    // Skip: health:memory (already verified at initial boot)
    steps.push({ name: 'health:memory', status: 'skipped', ms: 0 });

    // Skip: health:agents (already verified at initial boot)
    steps.push({ name: 'health:agents', status: 'skipped', ms: 0 });

    // Step 3: init:registry (REQUIRED — verify state dir is still writable)
    const registryStep = runStep('init:registry', () => stepInitRegistry(stateDir));
    steps.push(registryStep);
    if (registryStep.status === 'failed') {
      osEnabled = false;
    }

    // Skip: init:contracts (already parsed at initial boot)
    steps.push({ name: 'init:contracts', status: 'skipped', ms: 0 });

    // Step 6: init:observability (verify JSONL is still writable)
    if (osEnabled) {
      steps.push(runStep('init:observability', () => stepInitObservability(stateDir)));
    } else {
      steps.push({ name: 'init:observability', status: 'failed', ms: 0 });
    }

    // Step 7: report:status
    steps.push(runStep('report:status', () => stepReportStatus()));
  } else {
    // --- Full boot path ---

    // Step 1: health:memory
    steps.push(runStep('health:memory', () => stepHealthMemory(memoryHubUrl)));

    // Step 2: health:agents
    steps.push(runStep('health:agents', () => stepHealthAgents(agentsDir)));

    // Step 3: init:registry (REQUIRED)
    const registryStep = runStep('init:registry', () => stepInitRegistry(stateDir));
    steps.push(registryStep);
    if (registryStep.status === 'failed') {
      osEnabled = false;
    }

    // Step 4: init:contracts — pass enforcer when provided (RBAC-ENF-001 Phase 1)
    steps.push(runStep('init:contracts', () => stepInitContracts(agentsDir, enforcer)));

    // Step 6: init:observability
    if (osEnabled) {
      steps.push(runStep('init:observability', () => stepInitObservability(stateDir)));
    } else {
      steps.push({ name: 'init:observability', status: 'failed', ms: 0 });
    }

    // Step 7: report:status
    steps.push(runStep('report:status', () => stepReportStatus()));
  }

  // ---------------------------------------------------------------------------
  // Boot lifecycle observability events
  // Emitted after all steps complete so we have final osEnabled + step results.
  // Only emit if osEnabled — if the state dir is broken, we can't write anyway.
  // ---------------------------------------------------------------------------
  if (osEnabled) {
    try {
      const obs = createObservability(stateDir);
      const totalBootMs = Date.now() - bootT0;
      const bootSource = source || 'initial';

      obs.log('kernel', 'boot:start', {
        capability: 'kernel',
        severity: 'info',
        message: `Boot sequence started (${bootSource})`,
        source: bootSource,
        startedAt: new Date(bootT0).toISOString(),
      });

      for (const step of steps) {
        obs.log('kernel', 'boot:step', {
          capability: 'kernel',
          severity: step.status === 'failed' ? 'error' : step.status === 'degraded' ? 'warn' : 'info',
          message: `${step.name}: ${step.status}`,
          step: step.name,
          stepStatus: step.status,
          stepMs: step.ms,
        });
      }

      obs.log('kernel', 'boot:complete', {
        capability: 'kernel',
        severity: 'info',
        message: `Boot complete (${bootSource})`,
        source: bootSource,
        totalDurationMs: totalBootMs,
        stepCount: steps.length,
        degraded: steps.filter(s => s.status === 'degraded').map(s => s.name),
        failed: steps.filter(s => s.status === 'failed').map(s => s.name),
      });
    } catch (_) {
      // Observability events are best-effort — never fail the boot sequence
    }
  }

  // Build summary
  const degraded = steps.filter(s => s.status === 'degraded').map(s => s.name);
  const failed = steps.filter(s => s.status === 'failed').map(s => s.name);
  const skipped = steps.filter(s => s.status === 'skipped').map(s => s.name);
  const totalMs = steps.reduce((sum, s) => sum + s.ms, 0);

  const bootLabel = isCompact ? 'OS re-boot (compact)' : 'OS boot';
  const summary = osEnabled
    ? `${bootLabel}: ${steps.length} steps, ${totalMs}ms` +
      (skipped.length > 0 ? ` (skipped: ${skipped.join(', ')})` : '') +
      (degraded.length > 0 ? ` (degraded: ${degraded.join(', ')})` : '') +
      (failed.length > 0 ? ` (failed: ${failed.join(', ')})` : '')
    : `OS DISABLED — init:registry failed (${totalMs}ms)`;

  // Write .boot-status
  try {
    const bootStatus = {
      osEnabled,
      bootTime: new Date().toISOString(),
      source: source || 'initial',
      degraded,
    };
    fs.writeFileSync(
      path.join(stateDir, '.boot-status'),
      JSON.stringify(bootStatus, null, 2) + '\n'
    );
  } catch {
    // If we can't write the status file, the OS is likely disabled anyway
  }

  return { osEnabled, source: source || 'initial', steps, summary };
}

module.exports = { run };
