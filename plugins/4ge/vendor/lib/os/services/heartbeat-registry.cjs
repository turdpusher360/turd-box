'use strict';

/**
 * heartbeat-registry.cjs
 *
 * Postmortem P6 (_runs/2026-07-02/postmortem-ecosystem-stranded-work.md), the class-fix doctrine:
 * "a protection without a liveness check does not exist. Any new safety function must declare
 * its heartbeat + tripwire at creation, or it doesn't merge." This module gives that rule teeth:
 * a declarative catalog (`lib/os/config/heartbeat-registry.json`) of every registered heartbeat/
 * tripwire service, plus a validator that cross-checks the catalog against what's actually on
 * disk in `lib/os/services/`.
 *
 * DESIGN CHOICE (flagged for lead, see _runs/s524/lane-a-plan.md): this is a declarative
 * catalog + validator, NOT a live self-registration API. The four services it catalogs today
 * (backlog-staleness, strand-o-meter, closeout-tripwire, operator-queue) are unmodified — none of
 * them call into this module. strand-o-meter.cjs in particular is post-incident hardened (upstream,
 * see its own header comment); editing it to add a `registerHeartbeat()` call for this module's
 * convenience was judged not worth the risk for a doctrine-compliance artifact. If live self-
 * registration is what's wanted instead, that's a separate, higher-risk follow-up, not folded in
 * here.
 *
 * What "validate" actually checks:
 *   1. Every catalog entry's `module` path exists on disk (catches a registered-but-deleted
 *      service — stale doctrine-compliance record).
 *   2. Every `.cjs` file in `lib/os/services/` that ISN'T in a small, explicit exclusion list of
 *      known non-heartbeat infra services (ipc, observability, work-product-router, and this file
 *      itself) IS present in the catalog (catches a new safety function that shipped without
 *      declaring itself — the literal doctrine violation).
 *
 * This is advisory tooling for review time (a human or a future CI/PreToolUse gate runs it
 * against a PR), not a boot-time gate. It is intentionally NOT wired into os-boot.cjs — that
 * wiring is a separate, lead-gated step, same posture as the other three heartbeat services when
 * they were first built.
 *
 * Fail-open throughout: a missing/corrupt catalog or an unreadable services dir returns an empty/
 * degraded result rather than throwing.
 */

const fs = require('node:fs');
const path = require('node:path');

// Infra services in lib/os/services/ that are NOT "safety functions" in the postmortem's sense —
// they don't detect or alarm on a stranding/drift condition, so P6's doctrine doesn't apply to
// them. Excluded so validateRegistry() doesn't flag them as "should have declared a heartbeat".
// context-plane-liveness.cjs (upstream F4) is verification INFRA like the others — it is the module that
// RUNS this validator through the check-wiring-liveness adapters, not a stranding detector that
// needs its own heartbeat entry; without this exclusion it would self-defeat (a 5th on-disk file
// vs the 4-entry catalog -> validateRegistry().ok=false -> CI red on its own landing commit).
const NON_HEARTBEAT_SERVICES = new Set([
  'ipc.cjs',
  'observability.cjs',
  'work-product-router.cjs',
  'heartbeat-registry.cjs',
  'context-plane-liveness.cjs',
]);

function defaultRegistryPath(repoRoot) {
  return path.join(repoRoot || process.cwd(), 'lib', 'os', 'config', 'heartbeat-registry.json');
}

function defaultServicesDir(repoRoot) {
  return path.join(repoRoot || process.cwd(), 'lib', 'os', 'services');
}

/**
 * Load the heartbeat catalog. Fail-open: a missing file, unparseable JSON, or a malformed
 * `services` shape all return an empty array rather than throwing.
 *
 * @param {string} [registryPath]
 * @returns {Array<object>}
 */
function loadRegistry(registryPath) {
  const p = registryPath || defaultRegistryPath();
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.services)) return [];
    return parsed.services.filter((s) => s && typeof s.name === 'string' && typeof s.module === 'string');
  } catch {
    return [];
  }
}

/**
 * List candidate heartbeat service files actually present on disk — every `.cjs` file in
 * `lib/os/services/` except the explicit non-heartbeat infra exclusions.
 *
 * @param {string} [servicesDir]
 * @returns {string[]} basenames, e.g. ['backlog-staleness.cjs', ...]
 */
function discoverServiceFiles(servicesDir) {
  const dir = servicesDir || defaultServicesDir();
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.cjs') && !NON_HEARTBEAT_SERVICES.has(f))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Cross-check the catalog against disk. Two independent failure classes:
 *   - `missingModules`: catalog entries whose `module` path no longer exists.
 *   - `unregisteredServices`: `.cjs` files under services/ that look like heartbeat candidates
 *     (not in the infra exclusion list) but have no catalog entry pointing at them.
 *
 * @param {{ repoRoot?: string, registryPath?: string, servicesDir?: string }} [opts]
 * @returns {{
 *   ok: boolean,
 *   registeredCount: number,
 *   missingModules: string[],
 *   unregisteredServices: string[],
 *   entries: Array<object>,
 * }}
 */
function validateRegistry(opts) {
  const options = opts || {};
  const repoRoot = options.repoRoot || process.cwd();
  const registryPath = options.registryPath || defaultRegistryPath(repoRoot);
  const servicesDir = options.servicesDir || defaultServicesDir(repoRoot);

  const entries = loadRegistry(registryPath);

  const missingModules = [];
  const registeredBasenames = new Set();
  for (const entry of entries) {
    const modulePath = path.isAbsolute(entry.module) ? entry.module : path.join(repoRoot, entry.module);
    if (!fs.existsSync(modulePath)) {
      missingModules.push(entry.module);
    }
    registeredBasenames.add(path.basename(entry.module));
  }

  const onDisk = discoverServiceFiles(servicesDir);
  const unregisteredServices = onDisk.filter((f) => !registeredBasenames.has(f));

  return {
    ok: missingModules.length === 0 && unregisteredServices.length === 0,
    registeredCount: entries.length,
    missingModules,
    unregisteredServices,
    entries,
  };
}

/**
 * One-line summary suitable for a review comment or (if wired later) a boot-brief line.
 * Never throws.
 *
 * @param {ReturnType<typeof validateRegistry>} result
 * @returns {string}
 */
function formatRegistryStatusLine(result) {
  if (!result || typeof result !== 'object') return 'heartbeat registry: no data';
  const { registeredCount, missingModules, unregisteredServices } = result;
  if (result.ok) {
    return `${registeredCount}/${registeredCount} heartbeats registered, 0 drift`;
  }
  const bits = [];
  if (missingModules && missingModules.length) {
    bits.push(`${missingModules.length} registered module(s) missing on disk: ${missingModules.join(', ')}`);
  }
  if (unregisteredServices && unregisteredServices.length) {
    bits.push(`${unregisteredServices.length} unregistered service file(s): ${unregisteredServices.join(', ')}`);
  }
  return `heartbeat registry drift — ${bits.join('; ')}`;
}

module.exports = {
  NON_HEARTBEAT_SERVICES,
  defaultRegistryPath,
  defaultServicesDir,
  loadRegistry,
  discoverServiceFiles,
  validateRegistry,
  formatRegistryStatusLine,
};
