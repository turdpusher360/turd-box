'use strict';
/**
 * hud-state.cjs — TTL-based active/idle flag for the HUD.
 *
 * Purpose: when Claude is genuinely idle (waiting on user input), the HUD
 * should emit byte-stable output across CC's 2-second statusLine polls so
 * the renderer skips repaints. On mobile Termius, repaints land in scrollback
 * and bounce the viewport, burying response text.
 *
 * Active state is set by UserPromptSubmit/PostToolUse hooks with a TTL.
 * Idle is set by the Stop hook OR by TTL expiry (defensive fallback if Stop
 * never fires).
 *
 * State file: <cwd>/_runs/os/hud-active.json
 *   { "active": true, "since": "ISO", "expires_at": "ISO" }
 *
 * Reads/writes are best-effort; all errors are swallowed. The renderer's
 * fallback when state is unreadable is "idle" (safe default — no animation).
 */

const fs = require('node:fs');
const path = require('node:path');

// TTL is a defensive fallback for when the Stop hook fails to fire (crash,
// kill -9, hook pipeline disruption). Primary idle transition is via Stop
// hook → setIdle(), which is immediate. TTL just caps how long a stale
// active flag can linger. Short TTL = orb settles to idle quickly after
// Claude stops responding, which matches mobile scrollback expectations.
// Must be >= refreshInterval (2s) so the flag survives between polls during
// continuous tool activity. 5s gives 2.5× headroom for scheduling jitter.
const DEFAULT_TTL_MS = 5 * 1000;
const STATE_REL_PATH = ['_runs', 'os', 'hud-active.json'];

function getStatePath(cwd) {
  return path.join(cwd || process.cwd(), ...STATE_REL_PATH);
}

function isActive(cwd) {
  try {
    const raw = fs.readFileSync(getStatePath(cwd), 'utf8');
    const state = JSON.parse(raw);
    if (!state || state.active !== true) return false;
    const expiresAt = new Date(state.expires_at).getTime();
    if (!Number.isFinite(expiresAt)) return false;
    return expiresAt > Date.now();
  } catch {
    return false;
  }
}

function setActive(cwd, ttlMs) {
  try {
    const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : DEFAULT_TTL_MS;
    const now = Date.now();
    const state = {
      active: true,
      since: new Date(now).toISOString(),
      expires_at: new Date(now + ttl).toISOString(),
    };
    const dst = getStatePath(cwd);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, JSON.stringify(state, null, 2));
  } catch { /* best-effort */ }
}

function setIdle(cwd) {
  try {
    const state = { active: false, at: new Date().toISOString() };
    const dst = getStatePath(cwd);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, JSON.stringify(state, null, 2));
  } catch { /* best-effort */ }
}

/**
 * When idle, returns a timestamp (ms) that should be used in place of Date.now()
 * for time-based animations, so the orb freezes on the frame it was on when the
 * session went idle rather than snapping to rest. Sources, in order:
 *   1. `at` — set by setIdle (Stop hook path)
 *   2. `expires_at` — set by setActive (TTL-expired fallback path)
 *   3. null — flag is active, or file malformed (caller falls back to Date.now())
 */
function getFreezeTime(cwd) {
  try {
    const raw = fs.readFileSync(getStatePath(cwd), 'utf8');
    const state = JSON.parse(raw);
    if (!state) return null;
    // Treat as idle if explicitly false OR TTL-expired active state (defensive).
    const expiresAtMs = state.expires_at ? new Date(state.expires_at).getTime() : null;
    const explicitlyIdle = state.active === false;
    const ttlExpired = state.active === true
      && Number.isFinite(expiresAtMs)
      && expiresAtMs <= Date.now();
    if (!explicitlyIdle && !ttlExpired) return null;
    // Freeze source: `at` (set by setIdle on Stop) preferred over `expires_at`
    // (fallback for TTL-expired path where Stop never fired).
    if (state.at) {
      const ms = new Date(state.at).getTime();
      if (Number.isFinite(ms)) return ms;
    }
    if (Number.isFinite(expiresAtMs)) return expiresAtMs;
    return null;
  } catch {
    return null;
  }
}

module.exports = { isActive, setActive, setIdle, getStatePath, getFreezeTime, DEFAULT_TTL_MS };
