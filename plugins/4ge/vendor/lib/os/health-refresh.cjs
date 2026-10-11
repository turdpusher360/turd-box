// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { deriveWriter, recordWrite } = require('./write-attribution.cjs');

/**
 * Discover capability modules in capDir and return { name, module } for each
 * module that exports a probe() function and a probeCost string.
 */
function discoverProbes(capDir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(capDir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.endsWith('.cjs')) continue;
    const name = entry.replace(/\.cjs$/, '');
    // path.resolve (not path.join) — require() treats bare relative paths like
    // "lib/os/capabilities/foo.cjs" as node_modules lookups and silently fails.
    const fullPath = path.resolve(capDir, entry);
    try {
      const mod = require(fullPath);
      if (mod && typeof mod.probe === 'function' && typeof mod.probeCost === 'string') {
        out.push({ name, module: mod });
      }
    } catch { /* skip broken modules */ }
  }
  return out;
}

/**
 * Partition discovered probes by cost.
 */
function classifyProbes(capDir) {
  const all = discoverProbes(capDir);
  return {
    cheap: all.filter(p => p.module.probeCost === 'cheap'),
    expensive: all.filter(p => p.module.probeCost === 'expensive'),
  };
}

/**
 * Call probe() on each entry, catch throws, return a flat map.
 */
function runProbes(entries) {
  const result = {};
  for (const { name, module: mod } of entries) {
    try {
      const r = mod.probe();
      result[name] = (r && typeof r === 'object')
        ? r
        : { ok: false, reason: 'probe returned non-object' };
    } catch (e) {
      result[name] = { ok: false, reason: `probe threw: ${e.message}` };
    }
  }
  return result;
}

/**
 * Stamp each probe result with the time it was observed (`observed_at`, ISO-8601).
 * Copies each entry: a capability may return the object it caches (aisle does), so
 * stamping in place would leak the time into that capability's own cache.
 *
 * `observed_at` is additive and optional. Every reader keys on `ok` and named fields,
 * and Anvil's HealthSchema passes unknown keys through. Entries written at boot carry
 * no time, and a reader must treat that as "observation time unknown".
 *
 * @param {Record<string, any>} healthMap
 * @returns {Record<string, any>}
 */
function stampObserved(healthMap) {
  const observedAt = new Date().toISOString();
  const out = {};
  for (const [name, entry] of Object.entries(healthMap)) {
    out[name] = { ...entry, observed_at: observedAt };
  }
  return out;
}

/**
 * Read the health map already on disk. A missing, unparseable or non-object file
 * reads as empty, so the caller writes exactly what it probed, as it always has.
 *
 * @param {string} stateDir
 * @returns {Record<string, any>}
 */
function readHealth(stateDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(stateDir, 'health.json'), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Atomic write of a flat health map to stateDir/health.json.
 *
 * health.json itself stays a pure flat cap->health map (no wrapper keys) — its
 * readers iterate every top-level key as a capability. Rung B attribution for
 * this file therefore lives in the boot-writers journal, not in the payload.
 *
 * @param {string} stateDir
 * @param {object} healthMap
 * @param {object} [writerOpts] Optional attribution hints (sessionId, entry, surface).
 */
function writeHealth(stateDir, healthMap, writerOpts) {
  try {
    fs.mkdirSync(stateDir, { recursive: true });
  } catch { /* ignore */ }
  const target = path.join(stateDir, 'health.json');
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(healthMap, null, 2), 'utf8');
  fs.renameSync(tmp, target);

  // Journal the write (best-effort — must never break the health write).
  try {
    const writer = deriveWriter({ ...(writerOpts || {}), stateDir });
    const okCount = Object.values(healthMap).filter(h => h && h.ok).length;
    recordWrite(stateDir, 'health.json', writer, `${okCount}/${Object.keys(healthMap).length} ok`);
  } catch { /* attribution is best-effort */ }
}

/**
 * Run cheap probes only. Used by os-accounting PostToolUse hook.
 *
 * Expensive probes run only in refreshAll (and at boot), so what they last recorded
 * is carried over from the health.json already on disk, not erased. A carried-over
 * entry keeps the `observed_at` it already has; one without a time (boot wrote it)
 * stays untimed. Entries for capabilities that are not a known expensive probe are
 * not carried, so a removed capability cannot linger.
 *
 * @param {string} capDir
 * @param {string} stateDir
 * @param {object} [writerOpts] Optional attribution hints forwarded to writeHealth.
 * @returns {Record<string, any>} The map written to health.json.
 */
function refreshCheap(capDir, stateDir, writerOpts) {
  const { cheap, expensive } = classifyProbes(capDir);
  const healthMap = stampObserved(runProbes(cheap));
  const previous = readHealth(stateDir);
  for (const { name } of expensive) {
    const entry = previous[name];
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) healthMap[name] = entry;
  }
  writeHealth(stateDir, healthMap, writerOpts);
  return healthMap;
}

/**
 * Run cheap + expensive probes. Used by /4ge on-demand path.
 *
 * @param {string} capDir
 * @param {string} stateDir
 * @param {object} [writerOpts] Optional attribution hints forwarded to writeHealth.
 */
function refreshAll(capDir, stateDir, writerOpts) {
  const { cheap, expensive } = classifyProbes(capDir);
  const healthMap = { ...stampObserved(runProbes(cheap)), ...stampObserved(runProbes(expensive)) };
  writeHealth(stateDir, healthMap, writerOpts);
  return healthMap;
}

module.exports = {
  discoverProbes,
  classifyProbes,
  runProbes,
  writeHealth,
  refreshCheap,
  refreshAll,
};
