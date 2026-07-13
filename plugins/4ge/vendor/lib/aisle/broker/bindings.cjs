'use strict';

/**
 * bindings.cjs — AISLE authorization-broker binding computation.
 *
 * A "binding" ties an authorization to WHAT is being authorized, computed from
 * disk truth rather than requester claims. The requester supplies the shape of
 * the request (action_class, targets, artifact_paths); this module reads the
 * artifacts FROM DISK and hashes them, so the bound identity of the action is
 * anchored to the actual bytes on disk at the moment of binding — not to
 * anything the requester asserts.
 *
 * The bindings-digest is the single value both the operator (via the paste-token
 * fragment) and the consumer (via disk-recompute) compare against. It is what
 * closes the store-tamper case (T9): an attacker who rewrites a stored record
 * cannot forge the digest fragment the operator physically carried.
 *
 * Importable WITHOUT OS boot: privileged scripts require() this directly. Zero
 * imports from lib/aisle/core/boot.cjs, scanner-registry.cjs, gate-evaluator.cjs,
 * quarantine-manager.cjs, and zero imports from lib/os/.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DIGEST_PREFIX_LEN = 16; // hex chars carried in the paste-token fragment

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Hash a single artifact FROM DISK.
 *
 * Presence is part of the binding: a file that is absent hashes to a distinct
 * marker, and an unreadable file to another, so a file appearing, disappearing,
 * or losing read access between mint and consume flips the digest and fails
 * the consume closed. The requester's claimed path is preserved verbatim in the
 * canonical form; the hash is always disk truth.
 *
 * @param {string} artifactPath - path as claimed by the requester
 * @param {string} baseDir - base to resolve relative paths against (for reading)
 * @returns {{ path: string, hash: string }}
 */
function hashArtifact(artifactPath, baseDir) {
  const abs = path.isAbsolute(artifactPath)
    ? artifactPath
    : path.resolve(baseDir, artifactPath);
  let hash;
  try {
    const bytes = fs.readFileSync(abs);
    hash = `sha256:${sha256Hex(bytes)}`;
  } catch (err) {
    hash = err && err.code === 'ENOENT' ? 'absent' : 'unreadable';
  }
  // Canonicalize on the resolved absolute path so cwd differences between the
  // mint and consume call sites cannot change the binding. Within one machine
  // (the only lifetime of a token) the absolute path is stable.
  return { path: abs, hash };
}

/**
 * Compute the full set of artifact bindings from disk.
 *
 * @param {string[]} artifactPaths
 * @param {object} [opts]
 * @param {string} [opts.baseDir] - base for relative resolution (default cwd)
 * @returns {Array<{path: string, hash: string}>} sorted by path
 */
function computeArtifacts(artifactPaths, opts = {}) {
  const baseDir = opts.baseDir || process.cwd();
  const list = (Array.isArray(artifactPaths) ? artifactPaths : [])
    .map((p) => hashArtifact(p, baseDir));
  list.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return list;
}

/**
 * Build the canonical bindings object from a request + disk state.
 *
 * Canonical form is deterministic: action_class, then sorted unique targets,
 * then artifacts sorted by path with {path, hash} keys in fixed order. Because
 * this module constructs the object with a fixed insertion order and pre-sorts
 * both arrays, JSON.stringify() over it is a stable canonical serialization.
 *
 * @param {{action_class: string, targets: string[], artifact_paths: string[]}} req
 * @param {object} [opts] - {baseDir}
 * @returns {{action_class: string, targets: string[], artifacts: Array<{path,hash}>}}
 */
function computeBindings(req, opts = {}) {
  const actionClass = String((req && req.action_class) || '');
  const targets = Array.from(
    new Set((req && Array.isArray(req.targets) ? req.targets : []).map(String))
  ).sort();
  const artifacts = computeArtifacts(req && req.artifact_paths, opts);
  return { action_class: actionClass, targets, artifacts };
}

/**
 * Deterministic canonical string for a bindings object.
 * @param {object} bindings - output of computeBindings
 * @returns {string}
 */
function canonicalize(bindings) {
  // Rebuild with fixed key order to defend against callers passing a bindings
  // object whose keys were re-ordered (e.g. round-tripped through a store).
  const canonical = {
    action_class: String(bindings.action_class || ''),
    targets: Array.isArray(bindings.targets) ? bindings.targets.slice().sort() : [],
    artifacts: (Array.isArray(bindings.artifacts) ? bindings.artifacts.slice() : [])
      .map((a) => ({ path: a.path, hash: a.hash }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  };
  return JSON.stringify(canonical);
}

/**
 * Full digest over the canonical bindings form.
 * @param {object} bindings
 * @returns {string} 64-char hex sha256
 */
function bindingsDigest(bindings) {
  return sha256Hex(canonicalize(bindings));
}

/**
 * The operator-carried fragment: first DIGEST_PREFIX_LEN hex chars of the digest.
 * @param {string} digest - full hex digest
 * @returns {string}
 */
function digestPrefix(digest) {
  return String(digest || '').slice(0, DIGEST_PREFIX_LEN);
}

/**
 * Convenience: compute bindings + digest + prefix for a request in one call.
 * @param {{action_class, targets, artifact_paths}} req
 * @param {object} [opts] - {baseDir}
 * @returns {{bindings: object, digest: string, prefix: string}}
 */
function bindRequest(req, opts = {}) {
  const bindings = computeBindings(req, opts);
  const digest = bindingsDigest(bindings);
  return { bindings, digest, prefix: digestPrefix(digest) };
}

module.exports = {
  DIGEST_PREFIX_LEN,
  sha256Hex,
  hashArtifact,
  computeArtifacts,
  computeBindings,
  canonicalize,
  bindingsDigest,
  digestPrefix,
  bindRequest,
};
