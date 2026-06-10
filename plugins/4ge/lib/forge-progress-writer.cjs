'use strict';
/**
 * forge-progress-writer.cjs — Producer for the HUD forge-progress zone.
 *
 * Writes `_runs/os/forge-progress.json` in the schema consumed by
 * `plugins/4ge/bin/hud-zone-forge-progress.cjs`. Before this module existed the
 * zone was an orphaned consumer (memory 53c5280c): the renderer, data
 * loader (hud-data-loader.cjs:114), state spine (hud-state.cjs:148) and a
 * 241-line test all shipped, but nothing wrote the file, so
 * `forgeProgressVisible()` always returned false and the zone never rendered.
 *
 * This is the single source of truth for that file's contract. It is invoked
 * both as a library (require) and via a thin CLI shim from the `/forge` SKILL
 * at Phase 5 wave/agent/phase boundaries.
 *
 * ## Schema (must match hud-zone-forge-progress.cjs)
 * {
 *   "session": "<id>", "task": "<desc>", "startedAt": "<ISO>",
 *   "waves": [ { "id","label","status":"shipped|running|queued|deferred|failed",
 *                "commits":<n>,
 *                "agents":[{"name","type","status":"running|done|failed","startedAt"}],
 *                "packages":[...] } ],
 *   "totals": { "shipped":<n>, "packages":<n>, "running":<n>, "queued":<n> }
 * }
 *
 * Totals are always derived (recomputed on every write) — callers never set them.
 * All writes are atomic (writeFileAtomic, Windows EPERM-safe) and best-effort:
 * the module never throws, matching the rest of the HUD pipeline.
 */

const fs = require('node:fs');
const path = require('node:path');
const { writeFileAtomic } = require('./atomic-write.cjs');

const FILE_NAME = 'forge-progress.json';
const VALID_WAVE_STATUS = new Set(['shipped', 'running', 'queued', 'deferred', 'failed']);
const VALID_AGENT_STATUS = new Set(['running', 'done', 'failed']);

/** Resolve the state directory (_runs/os) for the current or given root. */
function resolveStateDir(opts) {
  if (opts && opts.stateDir) return opts.stateDir;
  return path.join(process.cwd(), '_runs', 'os');
}

/** Absolute path to forge-progress.json. */
function progressPath(opts) {
  return path.join(resolveStateDir(opts), FILE_NAME);
}

/** Read the current progress doc, or null if absent/unparseable. */
function readProgress(opts) {
  try {
    const p = progressPath(opts);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/** Coerce a raw doc into a well-formed shape with a waves array. */
function normalize(state) {
  const s = state && typeof state === 'object' ? state : {};
  return {
    session: typeof s.session === 'string' ? s.session : '',
    task: typeof s.task === 'string' ? s.task : '',
    startedAt: typeof s.startedAt === 'string' ? s.startedAt : new Date().toISOString(),
    waves: Array.isArray(s.waves) ? s.waves.map(normalizeWave) : [],
    totals: s.totals && typeof s.totals === 'object' ? s.totals : {},
  };
}

function normalizeWave(w) {
  const wave = w && typeof w === 'object' ? w : {};
  const status = VALID_WAVE_STATUS.has(wave.status) ? wave.status : 'queued';
  return {
    id: wave.id != null ? String(wave.id) : '?',
    label: typeof wave.label === 'string' ? wave.label : '',
    status,
    commits: Number.isFinite(wave.commits) ? wave.commits : 0,
    agents: Array.isArray(wave.agents) ? wave.agents.map(normalizeAgent) : [],
    packages: Array.isArray(wave.packages) ? wave.packages.slice() : [],
  };
}

function normalizeAgent(a) {
  const agent = a && typeof a === 'object' ? a : {};
  const status = VALID_AGENT_STATUS.has(agent.status) ? agent.status : 'running';
  return {
    name: typeof agent.name === 'string' ? agent.name : (agent.type || 'agent'),
    type: typeof agent.type === 'string' ? agent.type : '',
    status,
    startedAt: typeof agent.startedAt === 'string' ? agent.startedAt : new Date().toISOString(),
  };
}

/** Derive totals from waves. Callers never set totals directly. */
function recomputeTotals(state) {
  const waves = Array.isArray(state.waves) ? state.waves : [];
  let shipped = 0;
  let packages = 0;
  let running = 0;
  let queued = 0;
  for (const w of waves) {
    if (w.status === 'shipped') shipped++;
    else if (w.status === 'running') running++;
    else if (w.status === 'queued') queued++;
    packages += Array.isArray(w.packages) ? w.packages.length : 0;
  }
  return { shipped, packages, running, queued };
}

/**
 * Write the full progress doc atomically, recomputing totals first.
 * Returns the normalized doc that was written.
 */
function writeForgeProgress(state, opts) {
  const doc = normalize(state);
  doc.totals = recomputeTotals(doc);
  try {
    const p = progressPath(opts);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    writeFileAtomic(p, JSON.stringify(doc, null, 2) + '\n');
  } catch {
    /* best-effort */
  }
  return doc;
}

/** Initialize a fresh session doc (Phase 5 start). */
function startSession(init, opts) {
  const i = init && typeof init === 'object' ? init : {};
  const doc = {
    session: i.session != null ? String(i.session) : '',
    task: i.task != null ? String(i.task) : '',
    startedAt: i.startedAt || new Date().toISOString(),
    waves: Array.isArray(i.waves) ? i.waves : [],
    totals: {},
  };
  return writeForgeProgress(doc, opts);
}

/**
 * Add a wave (if its id is new) or merge into an existing wave by id.
 * Merge is shallow per field; only provided fields overwrite.
 */
function upsertWave(wave, opts) {
  const state = normalize(readProgress(opts) || {});
  const incoming = normalizeWave(wave);
  const idx = state.waves.findIndex((w) => w.id === incoming.id);
  if (idx === -1) {
    state.waves.push(incoming);
  } else {
    const existing = state.waves[idx];
    state.waves[idx] = {
      ...existing,
      label: wave.label != null ? incoming.label : existing.label,
      status: wave.status != null ? incoming.status : existing.status,
      commits: wave.commits != null ? incoming.commits : existing.commits,
      packages: wave.packages != null ? incoming.packages : existing.packages,
      // agents preserved unless explicitly provided
      agents: wave.agents != null ? incoming.agents : existing.agents,
    };
  }
  return writeForgeProgress(state, opts);
}

/** Patch fields of an existing wave by id (no-op if absent). */
function updateWave(id, patch, opts) {
  const state = normalize(readProgress(opts) || {});
  const wid = String(id);
  const idx = state.waves.findIndex((w) => w.id === wid);
  if (idx === -1) return writeForgeProgress(state, opts);
  const p = patch && typeof patch === 'object' ? patch : {};
  const w = state.waves[idx];
  if (p.label != null) w.label = String(p.label);
  if (p.status != null && VALID_WAVE_STATUS.has(p.status)) w.status = p.status;
  if (p.commits != null && Number.isFinite(p.commits)) w.commits = p.commits;
  if (Array.isArray(p.packages)) w.packages = p.packages.slice();
  return writeForgeProgress(state, opts);
}

/**
 * Add or update an agent on a wave, keyed by agent name (upsert — no dupes).
 * Creates the wave (status 'running') if it does not exist yet.
 */
function markAgent(waveId, agent, opts) {
  const state = normalize(readProgress(opts) || {});
  const wid = String(waveId);
  let wave = state.waves.find((w) => w.id === wid);
  if (!wave) {
    wave = normalizeWave({ id: wid, status: 'running' });
    state.waves.push(wave);
  }
  const incoming = normalizeAgent(agent);
  const aidx = wave.agents.findIndex((a) => a.name === incoming.name);
  if (aidx === -1) {
    wave.agents.push(incoming);
  } else {
    const existing = wave.agents[aidx];
    wave.agents[aidx] = {
      ...existing,
      type: agent.type != null ? incoming.type : existing.type,
      status: agent.status != null ? incoming.status : existing.status,
      // keep original startedAt unless explicitly provided
      startedAt: agent.startedAt != null ? incoming.startedAt : existing.startedAt,
    };
  }
  return writeForgeProgress(state, opts);
}

/** Remove the progress file (Phase 7 / park / cancel). Best-effort. */
function clearProgress(opts) {
  try {
    const p = progressPath(opts);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch {
    /* best-effort */
  }
}

module.exports = {
  FILE_NAME,
  progressPath,
  readProgress,
  writeForgeProgress,
  startSession,
  upsertWave,
  updateWave,
  markAgent,
  recomputeTotals,
  clearProgress,
};

// --- CLI shim (invoked by the /forge SKILL at phase boundaries) ---
// Usage: node forge-progress-writer.cjs <start|wave|agent|update|clear> '<json>'
if (require.main === module) {
  const [, , cmd, jsonArg] = process.argv;
  let payload = {};
  if (jsonArg) {
    try {
      payload = JSON.parse(jsonArg);
    } catch (e) {
      process.stderr.write(`forge-progress-writer: invalid JSON arg: ${e.message}\n`);
      process.exit(1);
    }
  }
  switch (cmd) {
    case 'start':
      startSession(payload);
      break;
    case 'wave':
      upsertWave(payload);
      break;
    case 'update':
      updateWave(payload.id, payload);
      break;
    case 'agent':
      markAgent(payload.waveId, payload);
      break;
    case 'clear':
      clearProgress();
      break;
    default:
      process.stderr.write(
        'forge-progress-writer: unknown command. Use start|wave|update|agent|clear\n'
      );
      process.exit(1);
  }
}
