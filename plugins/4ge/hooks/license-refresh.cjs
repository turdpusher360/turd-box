'use strict';

// SessionStart hook — opportunistic, staleness-gated license re-validation.
//
// The synchronous tier gate (check/current/require in lib/tier-gate.cjs) is
// cache-only and never touches the network. refresh() is the ONLY path that may
// rewrite the cache, but it must run out-of-band so it never blocks a command
// and never breaks offline use. The plugin has no long-lived process that keeps
// tier-gate loaded — every consumer (hooks, bin scripts) is a short-lived
// process that ends with process.exit(0), which would kill a plain
// fire-and-forget fetch mid-flight. So, like the AISLE server block in
// os-boot.cjs, this hook spawns a DETACHED, unref'd child (`tier-gate.cjs
// --refresh`) that outlives the hook: the hook forgets it and exits (0), while
// the child awaits refresh() and rewrites the cache for the NEXT session's reads.
//
// This hook does NO network itself (the detached child does), so it needs no
// enforceTimeout — it only reads a small config, stats the license, spawns, and
// exits. SessionStart cannot block; exit codes are advisory.
//
// Egress posture: DEFAULT-ON but narrow. Only an installed, STALE, email-bearing
// (paid) license ever spawns; free / unlicensed / email-less / fresh sessions
// never spawn and never egress. Unlike the AISLE server, this is a one-shot ~3s
// GET the paying user expects, not a persistent listener. Suppress with either
// env FORGE_NO_LICENSE_REFRESH=1 (hard kill-switch) or ~/.4ge/config.json
// { "license": { "autoRefresh": false } } (explicit opt-out).

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const child_process = require('node:child_process');

function readConfig() {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(os.homedir(), '.4ge', 'config.json'), 'utf8')
    );
  } catch {
    return null; // no config → default posture (on)
  }
}

// isEnabled(env, readConfigFn) — DEFAULT-ON. Disabled only by the hard env
// kill-switch or an explicit ~/.4ge/config.json license.autoRefresh === false.
function isEnabled(env = process.env, readConfigFn = readConfig) {
  if (env.FORGE_NO_LICENSE_REFRESH) return false; // hard kill-switch
  const cfg = readConfigFn();
  if (cfg && cfg.license && cfg.license.autoRefresh === false) return false; // explicit opt-out
  return true;
}

// passThrough — copy only present, non-empty keys into the child env.
function passThrough(env, keys) {
  const out = {};
  for (const k of keys) {
    if (env[k] !== undefined && env[k] !== '') out[k] = env[k];
  }
  return out;
}

// maybeSpawnRefresh — the whole decision + detached spawn. Returns true iff a
// worker was spawned. `env` and `spawn` are injectable for tests (so the real
// detached process is never forked under vitest). Never throws.
function maybeSpawnRefresh({ env = process.env, spawn = child_process.spawn } = {}) {
  try {
    if (!isEnabled(env)) return false;

    // Cheap pre-gate: skip forking a no-op child for a free/unlicensed/email-less
    // or fresh (<24h) license. refresh()'s own 24h gate is the backstop.
    const tierGatePath = path.join(__dirname, '..', 'lib', 'tier-gate.cjs');
    const tg = require(tierGatePath);
    if (!tg.shouldRefresh(tg._readLicense())) return false;

    const child = spawn(process.execPath, [tierGatePath, '--refresh'], {
      detached: true,
      stdio: 'ignore',
      env: {
        PATH: env.PATH || '',
        HOME: env.HOME || env.USERPROFILE || '',
        USERPROFILE: env.USERPROFILE || env.HOME || '',
        NODE_PATH: env.NODE_PATH || '',
        // Only-when-present knobs: a self-hosted / test endpoint override, and
        // proxy / custom-CA settings so the child's fetch works behind a proxy
        // (absent → the child fetch simply fails non-authoritative → cache kept).
        ...passThrough(env, [
          'FORGE_LICENSE_ENDPOINT',
          'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy',
          'NO_PROXY', 'no_proxy', 'NODE_EXTRA_CA_CERTS',
        ]),
      },
    });
    if (child && typeof child.unref === 'function') child.unref();
    return true;
  } catch {
    return false; // non-fatal — a license refresh must never block the session
  }
}

module.exports = { isEnabled, maybeSpawnRefresh, readConfig };

if (require.main === module) {
  try {
    maybeSpawnRefresh();
  } catch {
    /* non-fatal */
  }
  process.exit(0);
}
