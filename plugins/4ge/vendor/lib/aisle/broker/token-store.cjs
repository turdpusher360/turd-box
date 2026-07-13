'use strict';

/**
 * token-store.cjs — AISLE authorization-broker token lifecycle.
 *
 * The broker is the second "person" in a two-person rule: a requester can never
 * self-approve a gated action. A token binds an authorization to {action_class,
 * targets, artifact-hashes-from-disk, expiry} rather than to an identity, and is
 * single-use. The raw nonce (the secret pre-image) is carried by the operator in
 * the paste-token and NEVER persisted — the store holds only sha256(nonce).
 *
 * Two-step by design (see P3-REPORT DELTA): mint() is self-contained and returns
 * a directly-consumable paste-token, but in the real escalation flow the nonce is
 * born inside the operator's CLI (`show`), not the requester's process. The
 * capability `request` action calls createRequest() (no nonce); the operator's
 * CLI calls mint() to approve-and-render. Every required test drives mint() ->
 * consume() directly, which this module supports as the primitive.
 *
 * POSTURE: consume/verify FAIL CLOSED everywhere (the opposite of the P1 ingress
 * policy's fail-open) — this is enforcement of privileged actions. Any doubt =
 * deny.
 *
 * Importable WITHOUT OS boot. Zero imports from boot.cjs / scanner-registry.cjs /
 * gate-evaluator.cjs / quarantine-manager.cjs, and zero imports from lib/os/.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const bindings = require('./bindings.cjs');
const audit = require('./audit.cjs');

const DEFAULT_TTL_MS = 45 * 60 * 1000; // 45 minutes (brief O4)
const NONCE_BYTES = 16; // -> 32 hex chars
const TOKEN_ID_BYTES = 12; // -> 24 hex chars, public handle
const PASTE_TOKEN_RE = /^[0-9a-f]{32}\.[0-9a-f]{16}$/;

// ---------------------------------------------------------------------------
// Path + IO helpers
// ---------------------------------------------------------------------------

function resolveStateDir(opts) {
  if (opts && opts.stateDir) return opts.stateDir;
  // Lazy require: config.cjs does an mkdir at import time. Tests always inject
  // opts.stateDir, so config is only touched in real runtime.
  const config = require('../core/config.cjs');
  return config.resolveStateDir(null);
}

function dirs(opts) {
  const stateDir = resolveStateDir(opts);
  const brokerDir = path.join(stateDir, 'broker');
  return {
    stateDir,
    brokerDir,
    pending: path.join(brokerDir, 'pending'),
    consumed: path.join(brokerDir, 'consumed'),
  };
}

function ensureDirs(d) {
  fs.mkdirSync(d.pending, { recursive: true });
  fs.mkdirSync(d.consumed, { recursive: true });
}

function nowMs(opts) {
  if (opts && typeof opts.now === 'number') return opts.now;
  return Date.now();
}

function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function readRecord(dir, tokenId) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, `${tokenId}.json`), 'utf8'));
  } catch {
    return null;
  }
}

function findPendingByNonceHash(pendingPath, nonceSha) {
  let files;
  try {
    files = fs.readdirSync(pendingPath).filter((f) => f.endsWith('.json'));
  } catch {
    return null;
  }
  for (const file of files) {
    let record;
    try {
      record = JSON.parse(fs.readFileSync(path.join(pendingPath, file), 'utf8'));
    } catch {
      continue; // skip corrupt record rather than fail the lookup
    }
    if (record && record.nonce_sha256 && record.nonce_sha256 === nonceSha) {
      return { tokenId: record.token_id || path.basename(file, '.json'), record };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// createRequest — the requester-facing step (NO nonce)
// ---------------------------------------------------------------------------

/**
 * Record a pending authorization request. Computes the bindings from disk for
 * operator review, but mints NO nonce — the request is inert until an operator
 * approves it at the CLI (which calls mint). Returns only a public token_id and
 * the awaiting status; never a paste-token or nonce.
 *
 * @param {{action_class, targets, artifact_paths}} req
 * @param {object} [opts] - {stateDir, baseDir, now, requestor}
 * @returns {{token_id: string, status: 'awaiting-operator-approval'}}
 */
function createRequest(req, opts = {}) {
  const d = dirs(opts);
  ensureDirs(d);
  const tokenId = crypto.randomBytes(TOKEN_ID_BYTES).toString('hex');
  const bind = bindings.bindRequest(req, { baseDir: opts.baseDir });
  const requestor = opts.requestor || 'privileged-lead';
  const record = {
    token_id: tokenId,
    status: 'awaiting-operator-approval',
    action_class: (req && req.action_class) || '',
    targets: req && Array.isArray(req.targets) ? req.targets : [],
    artifact_paths: req && Array.isArray(req.artifact_paths) ? req.artifact_paths : [],
    bindings: bind.bindings,
    bindings_digest: bind.digest,
    digest_prefix: bind.prefix,
    requested_at: nowMs(opts),
    requestor,
  };
  writeJsonAtomic(path.join(d.pending, `${tokenId}.json`), record);
  audit.appendAudit(d.stateDir, {
    event: 'requested', token_id: tokenId, action_class: record.action_class,
    bindings_digest: record.bindings_digest, targets: record.targets,
    outcome: 'pending', reason: 'awaiting-operator-approval', requestor,
  });
  return { token_id: tokenId, status: 'awaiting-operator-approval' };
}

// ---------------------------------------------------------------------------
// mint — the operator/CLI approval step (generates the nonce)
// ---------------------------------------------------------------------------

/**
 * Mint an approved, directly-consumable token. Generates the nonce, computes the
 * bindings FROM DISK now (operator approves against current reality), stores
 * sha256(nonce) + bindings + digest + TTL, and returns {token_id, paste_token}.
 *
 * The paste_token is returned ONLY to this caller (the trusted CLI surface) and
 * is NEVER persisted, logged, or returned to a requester. The raw nonce exists
 * only in this function's scope and in the returned paste_token string.
 *
 * If opts.tokenId names an existing awaiting request, that record is upgraded in
 * place (token_id preserved, bindings recomputed from disk). Otherwise a fresh
 * token is minted.
 *
 * @param {{action_class, targets, artifact_paths}} req
 * @param {object} [opts] - {stateDir, baseDir, now, ttlMs, tokenId, requestor}
 * @returns {{token_id: string, paste_token: string}}
 */
function mint(req, opts = {}) {
  const d = dirs(opts);
  ensureDirs(d);
  const t = nowMs(opts);
  const ttlMs = (opts && typeof opts.ttlMs === 'number') ? opts.ttlMs : DEFAULT_TTL_MS;

  let tokenId = opts.tokenId || null;
  let requestor = opts.requestor || 'privileged-lead';
  let bindReq = req;
  if (tokenId) {
    const existing = readRecord(d.pending, tokenId);
    if (existing) {
      requestor = existing.requestor || requestor;
      // Re-bind from the recorded claim so the operator approves exactly what
      // was requested — but hashed against CURRENT disk.
      bindReq = {
        action_class: existing.action_class,
        targets: existing.targets,
        artifact_paths: existing.artifact_paths,
      };
    }
  } else {
    tokenId = crypto.randomBytes(TOKEN_ID_BYTES).toString('hex');
  }

  const bind = bindings.bindRequest(bindReq, { baseDir: opts.baseDir });

  const nonceHex = crypto.randomBytes(NONCE_BYTES).toString('hex'); // 32 hex chars
  const nonceSha = bindings.sha256Hex(nonceHex);
  const pasteToken = `${nonceHex}.${bind.prefix}`;

  const record = {
    token_id: tokenId,
    status: 'approved',
    nonce_sha256: nonceSha,
    action_class: (bindReq && bindReq.action_class) || '',
    targets: bindReq && Array.isArray(bindReq.targets) ? bindReq.targets : [],
    artifact_paths: bindReq && Array.isArray(bindReq.artifact_paths) ? bindReq.artifact_paths : [],
    bindings: bind.bindings,
    bindings_digest: bind.digest,
    digest_prefix: bind.prefix,
    minted_at: t,
    expires_at: t + ttlMs,
    ttl_ms: ttlMs,
    requestor,
  };
  writeJsonAtomic(path.join(d.pending, `${tokenId}.json`), record);

  audit.appendAudit(d.stateDir, {
    event: 'minted', token_id: tokenId, action_class: record.action_class,
    bindings_digest: record.bindings_digest, targets: record.targets,
    outcome: 'approved', reason: 'token-minted', requestor,
  });

  // paste_token: in-memory return only. Never persisted, never logged.
  return { token_id: tokenId, paste_token: pasteToken };
}

// ---------------------------------------------------------------------------
// consume — the privileged-script step (verify + atomic single-use)
// ---------------------------------------------------------------------------

/**
 * Verify a paste-token against a claimed action and, on success, atomically
 * burn it (single-use). FAILS CLOSED on every doubt with a distinct reason.
 *
 * Verification order:
 *   1. token format
 *   2. locate approved record by nonce pre-image (sha256(nonce) match)
 *   3. status must be approved
 *   4. TTL not expired
 *   5. disk-recompute the digest from the CONSUME-TIME claim + current disk, then
 *      gate on BOTH the operator-carried fragment (tamper-proof anchor, closes
 *      T9) AND the stored digest (drift / claim-mismatch)
 *   6. atomic renameSync(pending -> consumed) as the single-use mutex
 *
 * @param {string} pasteToken - "<nonce-hex>.<digest-prefix>"
 * @param {{action_class, targets, artifact_paths}} req - the action being executed
 * @param {object} [opts] - {stateDir, baseDir, now}
 * @returns {{ok: true, token_id, action_class, targets, artifacts, bindings_digest} | {ok: false, reason}}
 */
function consume(pasteToken, req, opts = {}) {
  const d = dirs(opts);

  const deny = (reason, tokenId, digest) => {
    audit.appendAudit(d.stateDir, {
      event: 'denied', token_id: tokenId || null,
      action_class: (req && req.action_class) || null,
      bindings_digest: digest, targets: (req && req.targets) || [],
      outcome: 'denied', reason,
    });
    return { ok: false, reason };
  };

  // 1. Format. The nonce is half the paste-token by design; it stays local.
  if (typeof pasteToken !== 'string' || !PASTE_TOKEN_RE.test(pasteToken)) {
    return deny('malformed-token', null);
  }
  const dot = pasteToken.indexOf('.');
  const nonceHex = pasteToken.slice(0, dot);
  const operatorPrefix = pasteToken.slice(dot + 1);

  // 2. Locate the approved record by nonce pre-image. Only someone holding the
  //    real nonce can produce a hash that matches a stored record.
  ensureDirs(d);
  const nonceSha = bindings.sha256Hex(nonceHex);
  const found = findPendingByNonceHash(d.pending, nonceSha);
  if (!found) return deny('unknown-or-consumed', null);
  const { tokenId, record } = found;

  // 3. Must be an approved (minted) record.
  if (record.status !== 'approved') return deny('not-approved', tokenId);

  // 4. TTL — burn on expiry.
  const t = nowMs(opts);
  if (typeof record.expires_at === 'number' && t > record.expires_at) {
    try {
      fs.renameSync(
        path.join(d.pending, `${tokenId}.json`),
        path.join(d.consumed, `${tokenId}.json`)
      );
    } catch { /* already gone — still expired */ }
    audit.appendAudit(d.stateDir, {
      event: 'expired', token_id: tokenId, action_class: record.action_class,
      bindings_digest: record.bindings_digest, targets: record.targets,
      outcome: 'denied', reason: 'ttl-expired',
    });
    return { ok: false, reason: 'expired' };
  }

  // 5. Disk-recompute from the CONSUME-TIME claim + current disk bytes.
  const disk = bindings.bindRequest(req, { baseDir: opts.baseDir });
  const diskDigest = disk.digest;
  const diskPrefix = disk.prefix;

  const operatorMatches = diskPrefix === operatorPrefix; // Gate A: tamper-proof anchor
  const storedMatches = diskDigest === record.bindings_digest; // Gate B: stored (tamperable)

  if (!operatorMatches && !storedMatches) {
    // Disk no longer matches either the operator's approval or the stored record
    // — the bound artifacts/action drifted since mint.
    return deny('bindings-drift', tokenId, diskDigest);
  }
  if (operatorMatches && !storedMatches) {
    // The operator's carried fragment agrees with disk, but the stored record
    // was altered — record tamper (the record, not the operator, is wrong).
    return deny('record-tamper', tokenId, diskDigest);
  }
  if (!operatorMatches && storedMatches) {
    // Stored record AND disk agree, but the operator's physically-carried
    // fragment does NOT — the classic store-tamper/rebind (T9): a record
    // rewritten to match a forged action. The operator fragment is the anchor.
    return deny('operator-digest-mismatch', tokenId, diskDigest);
  }

  // 6. Atomic single-use. The rename is the mutex: two racing valid consumers
  //    both reach here; exactly one rename wins, the loser gets ENOENT.
  const src = path.join(d.pending, `${tokenId}.json`);
  const dst = path.join(d.consumed, `${tokenId}.json`);
  try {
    fs.renameSync(src, dst);
  } catch (err) {
    if (err && err.code === 'ENOENT') return deny('already-consumed', tokenId, diskDigest);
    return deny(`consume-failed:${(err && err.code) || 'unknown'}`, tokenId, diskDigest);
  }

  // Stamp the consumed record (cosmetic — the rename already committed the
  // single-use). Never re-introduces the nonce.
  try {
    writeJsonAtomic(dst, {
      ...record, status: 'consumed', consumed_at: t, consumed_digest: diskDigest,
    });
  } catch { /* single-use already enforced by the rename */ }

  audit.appendAudit(d.stateDir, {
    event: 'consumed', token_id: tokenId, action_class: record.action_class,
    bindings_digest: diskDigest, targets: record.targets,
    outcome: 'authorized', reason: 'consumed', requestor: record.requestor,
  });

  return {
    ok: true,
    token_id: tokenId,
    action_class: record.action_class,
    targets: record.targets,
    artifacts: disk.bindings.artifacts,
    bindings_digest: diskDigest,
  };
}

// ---------------------------------------------------------------------------
// revoke / expire — terminal lifecycle moves
// ---------------------------------------------------------------------------

function terminate(tokenId, event, reason, opts = {}) {
  const d = dirs(opts);
  ensureDirs(d);
  const record = readRecord(d.pending, tokenId);
  const src = path.join(d.pending, `${tokenId}.json`);
  const dst = path.join(d.consumed, `${tokenId}.json`);
  try {
    fs.renameSync(src, dst);
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: false, reason: 'not-found' };
    return { ok: false, reason: `${event}-failed:${(err && err.code) || 'unknown'}` };
  }
  const stampStatus = event === 'revoked' ? 'revoked' : 'expired';
  try {
    writeJsonAtomic(dst, {
      ...(record || { token_id: tokenId }),
      status: stampStatus,
      [`${stampStatus}_at`]: nowMs(opts),
    });
  } catch { /* terminal move already committed */ }
  audit.appendAudit(d.stateDir, {
    event, token_id: tokenId,
    action_class: record && record.action_class,
    bindings_digest: record && record.bindings_digest,
    targets: (record && record.targets) || [],
    outcome: stampStatus, reason,
  });
  return { ok: true, token_id: tokenId };
}

/** Operator-initiated revocation of a pending token. */
function revoke(tokenId, opts = {}) {
  return terminate(tokenId, 'revoked', 'operator-revoked', opts);
}

/** Force-expire a specific pending token (housekeeping). */
function expire(tokenId, opts = {}) {
  return terminate(tokenId, 'expired', 'force-expired', opts);
}

// ---------------------------------------------------------------------------
// Read surfaces for the CLI + capability (never expose the nonce hash usefully)
// ---------------------------------------------------------------------------

/**
 * Augment a stored record with CURRENT disk state for operator display: the
 * per-artifact hashes recomputed now, the current digest, and a drift flag vs
 * what was bound at mint. TTL remaining is computed against opts.now.
 */
function describe(record, opts = {}) {
  const disk = bindings.bindRequest(
    {
      action_class: record.action_class,
      targets: record.targets,
      artifact_paths: record.artifact_paths,
    },
    { baseDir: opts.baseDir }
  );
  const t = nowMs(opts);
  const expiresAt = typeof record.expires_at === 'number' ? record.expires_at : null;
  return {
    token_id: record.token_id,
    status: record.status,
    action_class: record.action_class,
    targets: record.targets,
    artifacts: disk.bindings.artifacts, // {path, current-hash}
    bound_digest: record.bindings_digest, // digest at mint/request
    current_digest: disk.digest, // digest from disk now
    drift: disk.digest !== record.bindings_digest,
    minted_at: record.minted_at || null,
    expires_at: expiresAt,
    ttl_ms_remaining: expiresAt !== null ? Math.max(0, expiresAt - t) : null,
    requestor: record.requestor || null,
  };
}

/** List all pending records (awaiting + approved) augmented with disk state. */
function listPending(opts = {}) {
  const d = dirs(opts);
  let files;
  try {
    files = fs.readdirSync(d.pending).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const file of files) {
    const record = readRecord(d.pending, path.basename(file, '.json'));
    if (record) out.push(describe(record, opts));
  }
  out.sort((a, b) => String(a.token_id).localeCompare(String(b.token_id)));
  return out;
}

/** Fetch + describe a single pending record, or null. */
function getPending(tokenId, opts = {}) {
  const d = dirs(opts);
  const record = readRecord(d.pending, tokenId);
  return record ? describe(record, opts) : null;
}

/** Raw record accessor (for the CLI mint path — needs the stored claim). */
function getPendingRaw(tokenId, opts = {}) {
  const d = dirs(opts);
  return readRecord(d.pending, tokenId);
}

module.exports = {
  DEFAULT_TTL_MS,
  PASTE_TOKEN_RE,
  createRequest,
  mint,
  consume,
  revoke,
  expire,
  describe,
  listPending,
  getPending,
  getPendingRaw,
  // exposed for the CLI/capability to derive dirs consistently
  _dirs: dirs,
};
