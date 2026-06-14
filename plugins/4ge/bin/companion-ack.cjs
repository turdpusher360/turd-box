'use strict';
// companion-ack.cjs — update-aware preference popup (anti-silent-drift), Wave 1.
//
// When the plugin version bumps, the operator's calm/motion settings may have been
// re-defaulted or new knobs added silently. This helper detects that drift and
// produces a persistent high-tier companion notice telling the user their current
// posture and how to change it. The /hud setter stamps the ack so it stays quiet
// until the NEXT version bump (then re-fires).
//
// Storage: _runs/os/.companion-ack.json → { ackedVersion: "<x.y.z>" }
// Cached reads (version + ack), NOT every tick. Fail-silent everywhere.

const fs = require('fs');
const path = require('path');

let writeFileAtomic;
try {
  writeFileAtomic = require('../lib/atomic-write.cjs').writeFileAtomic;
} catch {
  writeFileAtomic = function (targetPath, content) {
    const tmp = `${targetPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, targetPath);
  };
}

const ACK_PATH = process.env.COMPANION_ACK_PATH
  || path.resolve(__dirname, '..', '..', '..', '_runs', 'os', '.companion-ack.json');

// The persistent update notice. Kept short enough to render in full (~100 chars)
// when posted with an elevated maxLen (the default 60-cap would cut it mid-word).
const UPDATE_NOTICE = '⚙ Face/motion settings updated — yours: calm. Change: /hud face lively · /hud zen · keep: /hud face ok';

// ── Cached version + ack reads (NOT per-tick) ──
let _verCache = null;
let _verCachedAt = 0;
let _ackCache = null;
let _ackCachedAt = 0;
const CACHE_TTL = 10000;

function _pluginVersion() {
  const now = Date.now();
  if (_verCache !== null && (now - _verCachedAt) < CACHE_TTL) return _verCache;
  let ver = null;
  try {
    const pj = require('../.claude-plugin/plugin.json');
    if (pj && typeof pj.version === 'string') ver = pj.version;
  } catch { ver = null; }
  _verCache = ver;
  _verCachedAt = now;
  return ver;
}

function _readAck() {
  const now = Date.now();
  if (_ackCache !== null && (now - _ackCachedAt) < CACHE_TTL) return _ackCache;
  let acked = null;
  try {
    if (fs.existsSync(ACK_PATH)) {
      const raw = JSON.parse(fs.readFileSync(ACK_PATH, 'utf8'));
      if (raw && typeof raw.ackedVersion === 'string') acked = raw.ackedVersion;
    }
  } catch { acked = null; }
  _ackCache = acked;
  _ackCachedAt = now;
  return acked;
}

/**
 * Returns true when the current plugin version differs from the acked version,
 * i.e. the operator has not acknowledged the settings under this version yet.
 * Fail-silent: any error → false (no drift, no notice).
 */
function hasVersionDrift() {
  const ver = _pluginVersion();
  if (!ver) return false;
  const acked = _readAck();
  return acked !== ver;
}

/**
 * The update notice string to surface when there is drift, else null.
 */
function driftNotice() {
  return hasVersionDrift() ? UPDATE_NOTICE : null;
}

/**
 * Stamp ackedVersion = current plugin version, silencing the notice until the
 * next bump. Called by the /hud setter subcommands. Fail-silent.
 * @returns {string|null} the acked version, or null on failure.
 */
function ackVersion() {
  const ver = _pluginVersion();
  if (!ver) return null;
  try {
    const dir = path.dirname(ACK_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    writeFileAtomic(ACK_PATH, JSON.stringify({ ackedVersion: ver }, null, 2));
    _ackCache = ver;
    _ackCachedAt = Date.now();
    return ver;
  } catch {
    return null;
  }
}

/**
 * One-shot drift surfacing — post the update notice as a companion message when
 * there is version drift. Intended for a SessionStart caller (os-boot), which is
 * inherently once-per-session, so NO sentinel/throttle is needed: each boot
 * re-checks drift; unacked → post (rides the 120s critical TTL); acked → silent;
 * next plugin bump → drift true again → re-posts.
 *
 * NOTE: this is a CRITICAL system notice and intentionally bypasses the
 * companion.messages level filter (it is the channel through which the user
 * learns how to set that very filter). It posts with an elevated maxLen so the
 * ~100-char control hint renders in full (the default 60-cap would cut mid-word).
 *
 * Fail-silent. Returns true if a notice was posted, false otherwise.
 *
 * @param {object} [companionState] - injectable companion-state module (for tests);
 *                                    defaults to require('./companion-state.cjs').
 */
function postDriftNoticeIfNeeded(companionState) {
  try {
    if (!hasVersionDrift()) return false;
    const cs = companionState || require('./companion-state.cjs');
    if (!cs || typeof cs.signalMessage !== 'function') return false;
    cs.signalMessage(UPDATE_NOTICE, { tier: 'critical', maxLen: 110 });
    return true;
  } catch {
    return false;
  }
}

function clearCache() {
  _verCache = null; _verCachedAt = 0;
  _ackCache = null; _ackCachedAt = 0;
}

module.exports = {
  hasVersionDrift,
  driftNotice,
  postDriftNoticeIfNeeded,
  ackVersion,
  clearCache,
  ACK_PATH,
  UPDATE_NOTICE,
  _pluginVersion,
};
