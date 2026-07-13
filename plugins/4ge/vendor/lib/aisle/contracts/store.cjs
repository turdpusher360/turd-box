'use strict';

/**
 * AISLE Intent-Contract Store (P2 of DIS-SEC-001).
 *
 * The enforcement primitive behind the per-task intent-contract hook. Every
 * dispatch may register a contract declaring what a subject (a session / agent)
 * is allowed to do: `{ purpose, allowed_tool_classes, path_ownership,
 * action_envelope }`. A PreToolUse hook then validates every tool call against
 * the live contract for the calling subject. Storage is OUT-OF-REPO under the
 * AISLE state dir (`<stateDir>/contracts/`), on the same trust plane as
 * `~/.claude` settings; the contract store "sits under the file-integrity
 * capability" per the capsule — file-integrity.cjs exposes register/get/list
 * actions that delegate here.
 *
 * ROLLOUT POSTURE: WARN-ONLY first (brief §5.3, CODEX-POINTERS §3). `check()`
 * NEVER denies unless a contract's own `enforce:true` is set. `enforce` defaults
 * false; flipping it to enforcing is a later, deliberate lead decision. This is
 * the ADR-SEC-001 lesson made structural: the deny path ships dormant.
 *
 * FAIL-OPEN is a hard requirement (ADR-SEC-001 session-bricking lesson):
 *  - no contract for the subject            -> ALLOW (unregistered dispatch is
 *    legal in P2; contracts are opt-in).
 *  - missing / unreadable / corrupt store   -> ALLOW.
 *  - any error inside check()               -> the impure wrapper fails open.
 * The store can never brick a session.
 *
 * IDENTITY (brief O1, resolved for P1 and reused here): the subject is
 * (session_id, agent_id) taken from PreToolUse hook stdin. The privileged lead
 * carries NO agent_id; subagents/teammates carry one. A contract is keyed by the
 * hash of that tuple, so lead-context and each subagent get independent
 * contracts and cannot collide into one file.
 *
 * SECURITY: audit/detail strings carry only tool names, class labels, and
 * structured file paths (like P1's url/file_path rule). The raw Bash command is
 * NEVER logged (it can carry secrets) — only its derived classes. No secret
 * value ever enters the store, an audit line, or an error.
 *
 * Purity: `check()`, `lookup()`, `getById()`, `list()` read the store (read-only)
 * but never touch stdin, never call process.exit, and never create directories.
 * mkdir happens only on write paths (`register`, `appendAudit`). Importing this
 * module has no side effects.
 *
 * DELTA (flagged for lead adjudication):
 *  - `action_envelope` is STORED but NOT enforced in P2. The task's "validate …
 *    vs envelope" is satisfied by enforcing tool-class + write-path ownership +
 *    Bash classes. `action_envelope` (operator-gated action classes:
 *    apply/deploy/publish/…) is P3 broker-widening territory (§5.4); enforcing it
 *    here would duplicate the broker. Carried as a schema field for P3.
 *  - `path_ownership` constrains writes ONLY when non-empty. A contract that
 *    allows the `write` class but declares no `path_ownership` permits writes
 *    anywhere (least-surprise, lower warn-noise). Narrowing paths is opt-in per
 *    contract. Documented so the lead can flip to default-deny if desired.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const aisleConfig = require('../core/config.cjs');
const { classify } = require('./classify-bash.cjs');

// Default TTL when a contract omits ttl_ms: 45 min (brief O4 recommendation,
// inside the approved 30-60 min band).
const DEFAULT_TTL_MS = 45 * 60 * 1000;

/**
 * Tool-name -> capability class. Single source of truth shared between
 * registration (registerFromDispatch derives classes from tool names) and
 * validation (check maps a tool call to its class). Vocabulary is the
 * classify-bash set plus `mcp` (any mcp__* tool) and `other` (anything
 * unrecognized). `Bash` is special-cased in check() via classify().
 */
const TOOL_CLASS_MAP = Object.freeze({
  Read: 'read', Glob: 'read', Grep: 'read', NotebookRead: 'read', LS: 'read',
  Write: 'write', Edit: 'write', MultiEdit: 'write', NotebookEdit: 'write',
  WebFetch: 'net-fetch', WebSearch: 'net-fetch',
  Task: 'proc-spawn', Agent: 'proc-spawn',
  // Bash: handled by classify-bash, never via this map.
});

// Structured file tools whose tool_input carries a path we can range-check
// against path_ownership. Bash writes are class-level only (no structured path).
const PATH_TOOL_FIELD = Object.freeze({
  Write: 'file_path', Edit: 'file_path', MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
});

// ---------------------------------------------------------------------------
// State-dir + path helpers (mirror P1 policy.cjs)
// ---------------------------------------------------------------------------

/**
 * Resolve the AISLE state dir via the canonical config derivation (single
 * source of truth — never re-derived here). First call per process spawns
 * `git worktree list` (~45ms measured in P1), memoized thereafter. Injectable
 * via opts.stateDir on every public function so tests never pay it or touch
 * real state.
 * @returns {string} absolute AISLE state dir
 */
function resolveStateDir() {
  return aisleConfig.resolveStateDir(null);
}

function contractsDir(stateDir) {
  return path.join(stateDir, 'contracts');
}

function auditPath(stateDir) {
  return path.join(contractsDir(stateDir), 'audit.jsonl');
}

/**
 * Deterministic, collision-free filename for a subject. Hash of the
 * (session_id, agent_id) tuple with a NUL separator so distinct tuples cannot
 * concatenate to the same key. Lead context (no agent_id) hashes distinctly
 * from any subagent.
 * @param {{session_id?:string, agent_id?:string}} subject
 * @returns {string} `<16hex>.json`
 */
function subjectKey(subject) {
  const sid = (subject && subject.session_id) || '';
  const aid = (subject && subject.agent_id) || '';
  const hash = crypto.createHash('sha256').update(`${sid}\x00${aid}`, 'utf8').digest('hex');
  return `${hash.slice(0, 16)}.json`;
}

function contractPath(stateDir, subject) {
  return path.join(contractsDir(stateDir), subjectKey(subject));
}

/**
 * Derive the reproducible NAME handle for a subject — the one identity field a
 * dispatcher can key on at `Agent()` dispatch AND the child can reproduce at its
 * own PreToolUse call.
 *
 * WHY NOT agent_id (O2, empirically resolved): the child's runtime `agent_id`
 * carries a random per-spawn suffix (observed `a<name>-<16hex>`, e.g.
 * `abroker-fu-6974203609860267`), so it is NOT knowable at dispatch. The child's
 * `agent_type`, however, reproduces the dispatch team name exactly (observed
 * `broker-fu` across SubagentStart/PostToolUse/SubagentStop for every named
 * teammate this rig ran). So the dispatcher keys on the name it assigned
 * (`tool_input.name`) and the child matches via its `agent_type`.
 *
 * Robustness for the native-teams dispatch mode: when `agent_type` is the
 * constant `'in_process_teammate'`, the name instead lives in `agent_id`
 * (os-accounting classifyCaller precedent). Fall through to `agent_id` in that
 * case. The lead carries neither → handle '' → never matches a per-name contract.
 * @param {{agent_type?:string, agent_id?:string}} subject
 * @returns {string} the name handle, or '' when none (e.g. the lead)
 */
function nameHandle(subject) {
  if (!subject || typeof subject !== 'object') return '';
  const at = subject.agent_type;
  if (typeof at === 'string' && at && at !== 'in_process_teammate') return at;
  const aid = subject.agent_id;
  return typeof aid === 'string' && aid ? aid : '';
}

/**
 * Filename for a per-NAME (dispatcher-registered) contract. A DISTINCT namespace
 * from subjectKey: the `t-` prefix guarantees no filename collision with an
 * agent_id/session contract even if the two inputs ever hashed alike. Keyed on
 * (session_id, name handle).
 * @param {string} sessionId
 * @param {string} handle
 * @returns {string} `t-<16hex>.json`
 */
function subjectTypeKey(sessionId, handle) {
  const sid = sessionId || '';
  const h = handle || '';
  const hash = crypto.createHash('sha256').update(`${sid}\x00${h}`, 'utf8').digest('hex');
  return `t-${hash.slice(0, 16)}.json`;
}

function contractTypePath(stateDir, sessionId, handle) {
  return path.join(contractsDir(stateDir), subjectTypeKey(sessionId, handle));
}

// ---------------------------------------------------------------------------
// Normalization + expiry
// ---------------------------------------------------------------------------

/**
 * Normalize a raw contract into the canonical stored shape. Stamps contract_id,
 * created_at, ttl_ms, and enforce defaults. Pure (no I/O).
 * @param {object} raw
 * @param {object} [opts] {now?:number}
 * @returns {object} canonical contract record
 */
function normalizeContract(raw, opts = {}) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const nowMs = typeof opts.now === 'number' ? opts.now : Date.now();
  const subject = (c.subject && typeof c.subject === 'object') ? c.subject : {};
  const contractId = typeof c.contract_id === 'string' && c.contract_id
    ? c.contract_id
    : `ctr_${crypto.randomBytes(6).toString('hex')}`;
  return {
    contract_id: contractId,
    subject: {
      session_id: typeof subject.session_id === 'string' ? subject.session_id : null,
      agent_id: typeof subject.agent_id === 'string' ? subject.agent_id : null,
      agent_type: typeof subject.agent_type === 'string' ? subject.agent_type : null,
      // Base agent type of a dispatcher-registered contract (e.g. 'sonnet-execute'),
      // distinct from agent_type which carries the per-dispatch NAME/handle. Recorded
      // for reporting + FLIP-CANDIDATES; not part of any lookup key.
      subagent_type: typeof subject.subagent_type === 'string' ? subject.subagent_type : null,
    },
    purpose: typeof c.purpose === 'string' ? c.purpose : '',
    allowed_tool_classes: Array.isArray(c.allowed_tool_classes) ? c.allowed_tool_classes.slice() : [],
    path_ownership: Array.isArray(c.path_ownership) ? c.path_ownership.slice() : [],
    action_envelope: Array.isArray(c.action_envelope) ? c.action_envelope.slice() : [],
    created_at: typeof c.created_at === 'string' ? c.created_at : new Date(nowMs).toISOString(),
    ttl_ms: Number.isFinite(c.ttl_ms) && c.ttl_ms > 0 ? c.ttl_ms : DEFAULT_TTL_MS,
    enforce: c.enforce === true,
  };
}

/**
 * True if the contract's TTL window has elapsed by `nowMs`.
 * @param {object} contract normalized contract
 * @param {number} nowMs
 * @returns {boolean}
 */
function isExpired(contract, nowMs) {
  if (!contract || typeof contract.created_at !== 'string') return true;
  const created = Date.parse(contract.created_at);
  if (Number.isNaN(created)) return true;
  const ttl = Number.isFinite(contract.ttl_ms) && contract.ttl_ms > 0 ? contract.ttl_ms : DEFAULT_TTL_MS;
  return nowMs > created + ttl;
}

// ---------------------------------------------------------------------------
// Read path (fail-open)
// ---------------------------------------------------------------------------

function readContractFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null; // missing / unreadable / corrupt -> fail open
  }
}

/**
 * Look up the live contract for a subject. Read-only; never creates dirs.
 * Returns null (the fail-open signal) when absent, corrupt, or expired.
 * @param {{session_id?:string, agent_id?:string}} subject
 * @param {object} [opts] {stateDir?:string, now?:number}
 * @returns {object|null} normalized contract or null
 */
function lookup(subject, opts = {}) {
  const stateDir = opts.stateDir || resolveStateDir();
  const nowMs = typeof opts.now === 'number' ? opts.now : Date.now();
  const parsed = readContractFile(contractPath(stateDir, subject || {}));
  if (!parsed) return null;
  const contract = normalizeContract(parsed, { now: nowMs });
  if (isExpired(contract, nowMs)) return null;
  return contract;
}

/**
 * Look up a per-NAME (dispatcher-registered) contract by (session_id, handle).
 * Read-only; never creates dirs; fail-open (null) on absent/corrupt/expired.
 * check() consults this ONLY after the exact (session_id, agent_id) lookup misses.
 * @param {string} sessionId
 * @param {string} handle name handle (see nameHandle)
 * @param {object} [opts] {stateDir?:string, now?:number}
 * @returns {object|null} normalized contract or null
 */
function lookupByType(sessionId, handle, opts = {}) {
  if (!handle) return null;
  const stateDir = opts.stateDir || resolveStateDir();
  const nowMs = typeof opts.now === 'number' ? opts.now : Date.now();
  const parsed = readContractFile(contractTypePath(stateDir, sessionId, handle));
  if (!parsed) return null;
  const contract = normalizeContract(parsed, { now: nowMs });
  if (isExpired(contract, nowMs)) return null;
  return contract;
}

/**
 * Read every stored contract (for get/list actions). Read-only. Expired records
 * are excluded unless opts.includeExpired.
 * @param {object} [opts] {stateDir?:string, now?:number, includeExpired?:boolean}
 * @returns {object[]} normalized contracts
 */
function list(opts = {}) {
  const stateDir = opts.stateDir || resolveStateDir();
  const nowMs = typeof opts.now === 'number' ? opts.now : Date.now();
  const dir = contractsDir(stateDir);
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return []; // no store yet -> fail open (empty)
  }
  const out = [];
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const parsed = readContractFile(path.join(dir, name));
    if (!parsed) continue;
    const contract = normalizeContract(parsed, { now: nowMs });
    if (!opts.includeExpired && isExpired(contract, nowMs)) continue;
    out.push(contract);
  }
  return out;
}

/**
 * Look up a contract by contract_id (scans the store). Read-only.
 * @param {string} contractId
 * @param {object} [opts] {stateDir?:string, now?:number, includeExpired?:boolean}
 * @returns {object|null}
 */
function getById(contractId, opts = {}) {
  if (typeof contractId !== 'string' || !contractId) return null;
  const all = list({ ...opts, includeExpired: true });
  const match = all.find((c) => c.contract_id === contractId);
  if (!match) return null;
  if (!opts.includeExpired) {
    const nowMs = typeof opts.now === 'number' ? opts.now : Date.now();
    if (isExpired(match, nowMs)) return null;
  }
  return match;
}

// ---------------------------------------------------------------------------
// Write path (idempotent mkdir)
// ---------------------------------------------------------------------------

/**
 * Register (or replace) a contract for its subject. WRITE PATH: idempotent mkdir
 * of `<stateDir>/contracts/`. Re-registering a subject overwrites — this is
 * "narrowing is free". Returns the canonical stored record.
 * @param {object} contract raw contract (must carry `subject`)
 * @param {object} [opts] {stateDir?:string, now?:number}
 * @returns {object} stored normalized contract
 */
function register(contract, opts = {}) {
  const stateDir = opts.stateDir || resolveStateDir();
  const record = normalizeContract(contract, { now: opts.now });
  const dir = contractsDir(stateDir);
  fs.mkdirSync(dir, { recursive: true });
  const target = contractPath(stateDir, record.subject);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf8');
  fs.renameSync(tmp, target); // atomic replace
  return record;
}

/**
 * Register a per-NAME contract keyed on (session_id, name handle) — the write
 * path for O2 dispatcher-side registration. MUST NOT route through register():
 * a dispatch record has no agent_id, so subjectKey() would resolve to
 * sha256(session_id + NUL + '') = the LEAD's own key and clobber the lead's
 * contract. This writes under the distinct `t-` type namespace instead.
 *
 * `spec.agent_type` is the name handle (the dispatch team name); `spec.subagent_type`
 * is the base agent type (recorded, not keyed). WRITE PATH: idempotent mkdir.
 * @param {object} spec {session_id, agent_type(handle), subagent_type?, purpose?,
 *        allowed_tool_classes?, path_ownership?, action_envelope?, ttl_ms?, enforce?,
 *        contract_id?}
 * @param {object} [opts] {stateDir?:string, now?:number}
 * @returns {object} stored normalized contract
 */
function registerTypeContract(spec, opts = {}) {
  const s = spec && typeof spec === 'object' ? spec : {};
  const handle = typeof s.agent_type === 'string' ? s.agent_type : '';
  if (!handle) throw new Error('registerTypeContract: spec.agent_type (name handle) is required');
  const stateDir = opts.stateDir || resolveStateDir();
  const record = normalizeContract({
    contract_id: s.contract_id,
    subject: {
      session_id: s.session_id,
      agent_id: null,
      agent_type: handle,
      subagent_type: s.subagent_type,
    },
    purpose: s.purpose,
    allowed_tool_classes: s.allowed_tool_classes,
    path_ownership: s.path_ownership,
    action_envelope: s.action_envelope,
    ttl_ms: s.ttl_ms,
    enforce: s.enforce,
  }, { now: opts.now });
  const dir = contractsDir(stateDir);
  fs.mkdirSync(dir, { recursive: true });
  const target = contractTypePath(stateDir, s.session_id, handle);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf8');
  fs.renameSync(tmp, target); // atomic replace
  return record;
}

/**
 * Registration helper usable from BOTH O2 candidates (dispatcher-side at
 * Agent() dispatch, or a SubagentStart hook). Maps a dispatch spec into a
 * contract and registers it. When `spec.tools` (raw tool names) is given and
 * `allowed_tool_classes` is not, classes are derived via TOOL_CLASS_MAP (the
 * single source of truth). Does NOT wire either registration point — that is the
 * lead's O2 decision (see O2-NOTE.md).
 * @param {object} spec {session_id, agent_id?, agent_type?, purpose?,
 *        allowed_tool_classes?, tools?, path_ownership?, action_envelope?,
 *        ttl_ms?, enforce?}
 * @param {object} [opts] {stateDir?:string, now?:number}
 * @returns {object} stored normalized contract
 */
function registerFromDispatch(spec, opts = {}) {
  const s = spec && typeof spec === 'object' ? spec : {};
  let classes = Array.isArray(s.allowed_tool_classes) ? s.allowed_tool_classes.slice() : null;
  if (!classes && Array.isArray(s.tools)) {
    classes = classesForTools(s.tools);
  }
  const contract = {
    contract_id: s.contract_id,
    subject: {
      session_id: s.session_id,
      agent_id: s.agent_id,
      agent_type: s.agent_type,
    },
    purpose: s.purpose,
    allowed_tool_classes: classes || [],
    path_ownership: s.path_ownership,
    action_envelope: s.action_envelope,
    ttl_ms: s.ttl_ms,
    enforce: s.enforce,
  };
  return register(contract, opts);
}

/**
 * Map a list of raw tool names to the deduped set of capability classes via
 * TOOL_CLASS_MAP. `Bash` maps to no static class (its classes are
 * command-dependent, resolved at check time) — callers that grant Bash should
 * also grant the specific classes the task's Bash will exercise.
 * @param {string[]} tools
 * @returns {string[]} deduped classes
 */
function classesForTools(tools) {
  const set = new Set();
  for (const t of tools) {
    if (t === 'Bash') continue; // command-dependent; resolved at check time
    if (typeof t === 'string' && t.startsWith('mcp__')) { set.add('mcp'); continue; }
    set.add(TOOL_CLASS_MAP[t] || 'other');
  }
  return Array.from(set);
}

/**
 * Remove expired contract files. WRITE PATH. Returns the count removed.
 * @param {object} [opts] {stateDir?:string, now?:number}
 * @returns {{removed:number}}
 */
function expire(opts = {}) {
  const stateDir = opts.stateDir || resolveStateDir();
  const nowMs = typeof opts.now === 'number' ? opts.now : Date.now();
  const dir = contractsDir(stateDir);
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return { removed: 0 };
  }
  let removed = 0;
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const fp = path.join(dir, name);
    const parsed = readContractFile(fp);
    if (!parsed) continue;
    const contract = normalizeContract(parsed, { now: nowMs });
    if (isExpired(contract, nowMs)) {
      try { fs.unlinkSync(fp); removed++; } catch { /* already gone */ }
    }
  }
  return { removed };
}

/**
 * Append one contract-violation audit event as a JSONL line. WRITE PATH:
 * idempotent mkdir of `<stateDir>/contracts/`. Stamps `ts` if absent. Records
 * `{ts, event, contract_id, tool_name, detail}` — never the raw Bash command,
 * never a content body, never secrets.
 * @param {string} stateDir
 * @param {object} event {event?, contract_id, tool_name, detail, ts?}
 * @returns {object} the written record
 */
function appendAudit(stateDir, event) {
  const dir = contractsDir(stateDir);
  fs.mkdirSync(dir, { recursive: true });
  const record = {
    ts: (event && event.ts) || new Date().toISOString(),
    event: (event && event.event) || 'contract_violation',
    contract_id: (event && event.contract_id) || null,
    tool_name: (event && event.tool_name) || null,
    detail: (event && event.detail) || '',
  };
  fs.appendFileSync(auditPath(stateDir), JSON.stringify(record) + '\n', 'utf8');
  return record;
}

/**
 * Flip a stored contract's `enforce` flag by contract_id (the enforce-flip
 * MECHANISM; the operator/lead decides WHETHER to flip). Scans the store for the
 * contract, rewrites it in place under its EXISTING filename (so both agent_id-
 * and type-keyed contracts are handled), and appends an `enforce_flip` audit
 * line. WRITE PATH.
 *
 * EPHEMERAL BY DESIGN: a per-contract flip lives only until that subject is
 * re-registered (dispatch re-registration writes the spec's default enforce) or
 * the contract's TTL elapses. This is a "spot-enforce this live instance now"
 * lever, not a durable posture — the durable enforce lever is the registration-
 * time enforce policy (see dispatch-register.cjs). Documented so a CLI flip that
 * "reverts on its own" is understood, not mistaken for a bug.
 * @param {string} contractId
 * @param {boolean} enforce target value
 * @param {object} [opts] {stateDir?:string, now?:number}
 * @returns {{contract_id:string, from:boolean, to:boolean, file:string}|null}
 *          null when no contract with that id exists
 */
function setEnforce(contractId, enforce, opts = {}) {
  if (typeof contractId !== 'string' || !contractId) return null;
  const stateDir = opts.stateDir || resolveStateDir();
  const dir = contractsDir(stateDir);
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null; // no store
  }
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const fp = path.join(dir, name);
    const parsed = readContractFile(fp);
    if (!parsed) continue;
    const record = normalizeContract(parsed, { now: opts.now });
    if (record.contract_id !== contractId) continue;
    const from = record.enforce === true;
    const to = enforce === true;
    record.enforce = to;
    const tmp = `${fp}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf8');
    fs.renameSync(tmp, fp); // atomic in-place replace, key preserved
    appendAudit(stateDir, {
      event: 'enforce_flip',
      contract_id: contractId,
      tool_name: null,
      detail: `enforce ${from} -> ${to}`,
    });
    return { contract_id: contractId, from, to, file: name };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Validation (pure)
// ---------------------------------------------------------------------------

/**
 * True if `filePath` is at or under `prefix`, with separator-boundary awareness
 * so `/tmp/foobar` does NOT match a prefix of `/tmp/foo` (same bug class the
 * config.cjs home-boundary check guards against).
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
 * Compute the capability classes a single tool call exercises.
 *  - Bash -> classify(command)  (may be several, may be [])
 *  - mcp__* -> ['mcp']
 *  - mapped tool -> [its class]
 *  - unknown tool -> ['other']  (deliberate: an unlisted 'other' warns, so a
 *    narrow contract surfaces unrecognized capabilities rather than silently
 *    permitting them under a read grant)
 * @param {string} toolName
 * @param {object} toolInput
 * @returns {string[]}
 */
function toolCallClasses(toolName, toolInput) {
  if (toolName === 'Bash') {
    return classify((toolInput && toolInput.command) || '');
  }
  if (typeof toolName === 'string' && toolName.startsWith('mcp__')) {
    return ['mcp'];
  }
  return [TOOL_CLASS_MAP[toolName] || 'other'];
}

/**
 * Pure verdict for one tool call against the calling subject's live contract.
 * No stdin, no process.exit, no mkdir. May read the store.
 *
 * Returns allow ({deny:false, warn:false}) when there is no contract, no
 * violation, or the store is missing/corrupt (fail-open). On a violation it
 * always returns the warn channel + audit descriptor; it returns deny:true ONLY
 * when the matched contract has enforce:true.
 *
 * @param {object} input parsed PreToolUse stdin event
 * @param {object} [opts] {stateDir?:string, now?:number}
 * @returns {{deny:boolean, warn:boolean, exitCode?:number, stderr?:string,
 *           warnStdout?:string, audit?:object, contract_id?:string}}
 */
function check(input, opts = {}) {
  if (!input || !input.tool_name) {
    return { deny: false, warn: false };
  }

  const stateDir = opts.stateDir || resolveStateDir();
  const nowMs = typeof opts.now === 'number' ? opts.now : Date.now();
  const subject = { session_id: input.session_id, agent_id: input.agent_id, agent_type: input.agent_type };

  // Exact per-instance lookup first (session_id + agent_id). If it misses, fall
  // back to a dispatcher-registered per-NAME contract keyed on (session_id, name
  // handle) — what O2 dispatcher-side registration writes, because the child's
  // runtime agent_id is unknowable at dispatch (random suffix) while its
  // agent_type reproduces the dispatch name (see nameHandle). Fallback fires ONLY
  // on an exact miss, so existing agent_id/session-keyed contracts are unchanged,
  // and the lead (no handle) never matches a per-name contract.
  let contract = lookup(subject, { stateDir, now: nowMs });
  if (!contract) {
    const handle = nameHandle(subject);
    if (handle) contract = lookupByType(input.session_id, handle, { stateDir, now: nowMs });
  }
  if (!contract) {
    return { deny: false, warn: false }; // no contract / corrupt / expired -> allow
  }

  const toolName = input.tool_name;
  const toolInput = input.tool_input || {};
  const allowed = Array.isArray(contract.allowed_tool_classes) ? contract.allowed_tool_classes : [];
  const violations = [];

  // (a) + (c) tool-class / Bash-class check: every class this call exercises
  // must be within the contract's allowed_tool_classes.
  const callClasses = toolCallClasses(toolName, toolInput);
  const outOfEnvelope = callClasses.filter((c) => !allowed.includes(c));
  if (outOfEnvelope.length > 0) {
    violations.push(`tool ${toolName} exercises class(es) [${outOfEnvelope.join(', ')}] outside allowed_tool_classes [${allowed.join(', ')}]`);
  }

  // (b) write-path ownership: structured file-tool writes must fall under a
  // path_ownership prefix, but only when path_ownership is non-empty (see the
  // module DELTA). Bash writes are class-level only (no structured path).
  const pathField = PATH_TOOL_FIELD[toolName];
  if (pathField && Array.isArray(contract.path_ownership) && contract.path_ownership.length > 0) {
    const target = toolInput[pathField];
    if (typeof target === 'string' && target.length > 0) {
      const owned = contract.path_ownership.some((p) => isUnderPrefix(target, p));
      if (!owned) {
        violations.push(`write to ${target} is outside path_ownership [${contract.path_ownership.join(', ')}]`);
      }
    }
  }

  if (violations.length === 0) {
    return { deny: false, warn: false, contract_id: contract.contract_id };
  }

  const detail = violations.join('; ');
  const audit = {
    event: 'contract_violation',
    contract_id: contract.contract_id,
    tool_name: toolName,
    detail,
  };
  const warnStdout = `[intent-contract] WARN: ${toolName} violates contract ${contract.contract_id} (purpose: ${contract.purpose || 'n/a'}). ${detail}. [warn-only]\n`;

  if (contract.enforce === true) {
    return {
      deny: true,
      warn: true,
      exitCode: 2,
      stderr: `[intent-contract] BLOCKED: ${detail} (contract ${contract.contract_id}, enforce=true)\n`,
      warnStdout,
      audit,
      contract_id: contract.contract_id,
    };
  }

  return { deny: false, warn: true, warnStdout, audit, contract_id: contract.contract_id };
}

module.exports = {
  // pure verdict + validation helpers
  check,
  toolCallClasses,
  classesForTools,
  isUnderPrefix,
  isExpired,
  normalizeContract,
  nameHandle,
  // read path
  lookup,
  lookupByType,
  getById,
  list,
  // write path
  register,
  registerFromDispatch,
  registerTypeContract,
  setEnforce,
  expire,
  appendAudit,
  // path/state helpers
  resolveStateDir,
  contractsDir,
  auditPath,
  contractPath,
  subjectKey,
  subjectTypeKey,
  contractTypePath,
  // constants
  TOOL_CLASS_MAP,
  DEFAULT_TTL_MS,
};
