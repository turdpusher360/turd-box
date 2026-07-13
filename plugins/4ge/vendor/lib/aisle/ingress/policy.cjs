'use strict';

/**
 * AISLE Ingress-Quarantine Policy (P1 of DIS-SEC-001).
 *
 * The enforcement primitive behind the ingress-quarantine hook. Denies raw
 * untrusted ingestion (WebFetch / WebSearch, and configured untrusted-path
 * reads) on the privileged lead when the policy is ARMED, so the lead must
 * launder untrusted content through a no-write-tools quarantine reader (see
 * _runs/2026-07-12/aisle-broker/QUARANTINE-CONTRACT.md).
 *
 * O1 ruling (CC lead, upstream): the privileged lead is a hook event with NO
 * `agent_id` on stdin (the main-loop context). Subagents and in-process
 * teammates always carry `agent_id` (live precedent: os-accounting.cjs:38-44),
 * and quarantine readers are subagents by construction — so the deny fires only
 * on the lead and readers pass untouched.
 *
 * FAIL-OPEN is a hard requirement (ADR-SEC-001 session-bricking lesson): a
 * missing, unreadable, or unparseable policy file ALLOWS. The hook can never
 * brick a session. Audit-write failure is isolated by the caller and never
 * converts a deny into an allow (that is the caller's contract, not this
 * module's — this module returns an audit descriptor; the impure wrapper emits
 * it).
 *
 * Purity: `check()` reads the policy file (read-only) but never touches stdin,
 * never calls process.exit, and never creates directories. mkdir happens only
 * on the write path (`appendAudit`). Importing this module has no side effects.
 *
 * DELTA vs O1 ruling literal return shape: the ruling states `check` returns
 * `{deny:false}` or `{deny:true, exitCode:2, stderr}`. This module adds an
 * optional `audit` descriptor field to that return so the pure check can stay
 * free of I/O while still letting the impure wrapper emit the override/denied
 * audit event. Flagged in P1-REPORT.md as an explicit, intended delta.
 */

const fs = require('fs');
const path = require('path');
const aisleConfig = require('../core/config.cjs');

// Default set denied when policy.deny_tools is absent (O1 ruling).
const DEFAULT_DENY_TOOLS = Object.freeze(['WebFetch', 'WebSearch']);

// Tools whose tool_input.file_path is matched against untrusted_read_paths.
const READ_TOOLS = Object.freeze(['Read', 'Edit']);

// ASCII-only deny message. Must name the sanctioned quarantine path and the
// operator-sanctioned escapes (QUARANTINE-CONTRACT.md sections 2 and 5).
const DENY_STDERR = [
  '[aisle-ingress] BLOCKED: raw untrusted ingestion is denied on the privileged lead.',
  '',
  'AISLE ingress-quarantine is ARMED. The lead must not fetch raw web/file content',
  'directly. Launder it through the quarantine lane (DIS-SEC-001 P1):',
  '',
  '  1. Dispatch a quarantine reader (an agent with NO write tools) with the',
  '     URL/path and a schema-constrained extraction schema for this fetch.',
  '  2. The reader fetches the raw content and returns ONLY typed JSON matching',
  '     the schema (no prose).',
  '  3. Validate the JSON shape, then write it verbatim to',
  '       _runs/<YYYY-MM-DD>/quarantine/<topic-slug>-<hhmm>Z.json',
  '  4. Read only that laundered artifact. The raw bytes never enter this context.',
  '',
  'Contract: _runs/2026-07-12/aisle-broker/QUARANTINE-CONTRACT.md',
  'Policy status: node scripts/aisle-ingress.cjs status',
  '',
  'Operator-sanctioned escapes only:',
  '  - node scripts/aisle-ingress.cjs off     (disarm the policy)',
  '  - AISLE_INGRESS_ALLOW=1 <command>         (one-shot override; audited)',
  '',
].join('\n');

/**
 * Resolve the AISLE state directory via the canonical config derivation.
 * Single source of truth for the path — never re-derived here (a slug that
 * drifts from config.cjs would look in the wrong dir and fail-open forever).
 * NOTE: this runs `git worktree list` on first call per process (~140ms; see
 * config.cjs deriveProjectId comment) — memoized thereafter. Injectable via
 * opts.stateDir on every public function so tests never pay it or touch real
 * state.
 *
 * @returns {string} absolute AISLE state dir
 */
function resolveStateDir() {
  return aisleConfig.resolveStateDir(null);
}

function ingressDir(stateDir) {
  return path.join(stateDir, 'ingress');
}

function policyPath(stateDir) {
  return path.join(ingressDir(stateDir), 'policy.json');
}

function auditPath(stateDir) {
  return path.join(ingressDir(stateDir), 'audit.jsonl');
}

/**
 * Load the ingress policy. Read-only: never creates directories.
 *
 * @param {string} stateDir absolute AISLE state dir
 * @returns {object|null} parsed policy object, or null on
 *          missing/unreadable/unparseable (the fail-open signal).
 */
function loadPolicy(stateDir) {
  try {
    const raw = fs.readFileSync(policyPath(stateDir), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed;
  } catch (err) {
    return null; // missing / unreadable / corrupt -> fail open
  }
}

/**
 * True if `filePath` is at or under `prefix`, with path-boundary awareness so a
 * sibling like `/tmp/foobar` does NOT match a prefix of `/tmp/foo`. Same bug
 * class the config.cjs:408-412 home-boundary check guards against.
 *
 * @param {string} filePath
 * @param {string} prefix
 * @returns {boolean}
 */
function isUnderPrefix(filePath, prefix) {
  if (typeof filePath !== 'string' || typeof prefix !== 'string') return false;
  if (filePath.length === 0 || prefix.length === 0) return false;
  const resolvedFile = path.resolve(filePath);
  const resolvedPrefix = path.resolve(prefix);
  if (resolvedFile === resolvedPrefix) return true;
  const boundary = resolvedPrefix.endsWith(path.sep) ? resolvedPrefix : resolvedPrefix + path.sep;
  return resolvedFile.startsWith(boundary);
}

/**
 * Append one audit event as a JSONL line. WRITE PATH: idempotent mkdir of
 * <stateDir>/ingress/. Stamps `ts` if absent. Records only
 * {ts, event, tool_name, session_id, reason} — never tool_input content bodies
 * (only a file_path/url string may appear inside `reason`) and never secrets.
 *
 * @param {string} stateDir absolute AISLE state dir
 * @param {object} event {event, tool_name, session_id, reason, ts?}
 * @returns {object} the written record
 */
function appendAudit(stateDir, event) {
  const dir = ingressDir(stateDir);
  fs.mkdirSync(dir, { recursive: true });
  const record = {
    ts: (event && event.ts) || new Date().toISOString(),
    event: (event && event.event) || 'unknown',
    tool_name: (event && event.tool_name) || null,
    session_id: (event && event.session_id) || null,
    reason: (event && event.reason) || '',
  };
  fs.appendFileSync(auditPath(stateDir), JSON.stringify(record) + '\n', 'utf8');
  return record;
}

/**
 * Pure verdict. No stdin, no process.exit, no mkdir. May read the policy file.
 *
 * @param {object} input parsed PreToolUse stdin event
 * @param {object} [opts]
 * @param {string} [opts.stateDir] injectable; defaults to resolveStateDir()
 * @param {object} [opts.env] injectable; defaults to process.env
 * @returns {{deny:boolean, exitCode?:number, stderr?:string, audit?:object}}
 */
function check(input, opts = {}) {
  if (!input || !input.tool_name) {
    return { deny: false };
  }

  // O1: privileged lead = NO agent_id. Subagents / in-process teammates
  // (quarantine readers) carry agent_id -> always allow.
  if (input.agent_id) {
    return { deny: false };
  }

  const stateDir = opts.stateDir || resolveStateDir();
  const policy = loadPolicy(stateDir);
  if (!policy || !policy.enabled) {
    return { deny: false }; // fail-open (no/corrupt policy) or disarmed
  }

  const toolName = input.tool_name;
  const toolInput = input.tool_input || {};
  const denyTools = Array.isArray(policy.deny_tools) ? policy.deny_tools : DEFAULT_DENY_TOOLS;
  const untrustedPaths = Array.isArray(policy.untrusted_read_paths) ? policy.untrusted_read_paths : [];

  let wouldDeny = false;
  let target = null; // only ever a url or file_path string — never a content body

  if (denyTools.includes(toolName)) {
    wouldDeny = true;
    // WebFetch carries a url; WebSearch carries a query (content) -> not logged.
    target = typeof toolInput.url === 'string' ? toolInput.url : null;
  } else if (READ_TOOLS.includes(toolName) && untrustedPaths.length > 0) {
    const fp = toolInput.file_path;
    if (typeof fp === 'string' && untrustedPaths.some((p) => isUnderPrefix(fp, p))) {
      wouldDeny = true;
      target = fp;
    }
  }

  if (!wouldDeny) {
    return { deny: false };
  }

  const sessionId = input.session_id || null;
  const env = opts.env || process.env;
  const reason = `${toolName} ingress-quarantine${target ? ' target=' + target : ''}`;

  // Operator-sanctioned one-shot override: allow, but record the bypass.
  if (env.AISLE_INGRESS_ALLOW === '1') {
    return {
      deny: false,
      audit: {
        event: 'override',
        tool_name: toolName,
        session_id: sessionId,
        reason: reason + ' (AISLE_INGRESS_ALLOW=1)',
      },
    };
  }

  return {
    deny: true,
    exitCode: 2,
    stderr: DENY_STDERR,
    audit: {
      event: 'denied',
      tool_name: toolName,
      session_id: sessionId,
      reason,
    },
  };
}

module.exports = {
  check,
  loadPolicy,
  appendAudit,
  resolveStateDir,
  isUnderPrefix,
  ingressDir,
  policyPath,
  auditPath,
  DEFAULT_DENY_TOOLS,
  DENY_STDERR,
};
