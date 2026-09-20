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
 * @param {string} capDir
 * @param {string} stateDir
 * @param {object} [writerOpts] Optional attribution hints forwarded to writeHealth.
 */
function refreshCheap(capDir, stateDir, writerOpts) {
  const { cheap } = classifyProbes(capDir);
  const healthMap = runProbes(cheap);
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
  const healthMap = { ...runProbes(cheap), ...runProbes(expensive) };
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
