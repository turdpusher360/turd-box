'use strict';

/**
 * AISLE dispatcher-side intent-contract registration (O2, DIS-SEC-001 P2).
 *
 * O2 ADJUDICATION (upstream): register a per-task intent contract at `Agent()`/`Task`
 * DISPATCH time (Option A), NOT in a SubagentStart hook. The SubagentStart floor
 * is deferred until P3 gates contract *widening*. This module is the dispatcher
 * side: the fork-storm dispatcher (`_pre-agent-dispatch.cjs`) calls
 * registerDispatchContract(event) on every non-denied spawn.
 *
 * KEYING (empirically resolved — see store.nameHandle): the child's runtime
 * `agent_id` carries a random per-spawn suffix (`a<name>-<16hex>`) and is NOT
 * knowable at dispatch, so we CANNOT key on it. The child's `agent_type` instead
 * reproduces the dispatch team NAME exactly (`tool_input.name`). So we register
 * the contract keyed on (session_id, name) via store.registerTypeContract, and
 * the PreToolUse hook's check() matches it through its (session_id, name-handle)
 * fallback. session_id is shared between the lead and its teammates (verified:
 * all teammates this session carried the lead's session_id), so the dispatch
 * event's session_id equals the child's.
 *
 * SCOPE (honest): NAMED teammates only. An unnamed classic background subagent
 * (bare Agent-tool dispatch of DFE/master-auditor, or a Task with no name) has no
 * reproducible name handle at dispatch → no contract is registered for it. That
 * matches the O2 note's "crowned-lane dispatches the lead actually drives" scope;
 * the universal floor is Option B (SubagentStart), deferred to post-P3.
 *
 * ENVELOPE: allowed_tool_classes are derived MECHANICALLY from the base agent
 * type's frontmatter `tools:` (via store.classesForTools) — not from a free-text
 * spec — so a compromised lead cannot widen a teammate past what its agent type
 * already grants. A `Bash` grant expands to all Bash-reachable classes (an agent
 * with Bash is effectively broad; this avoids false warns on legitimate Bash,
 * residual R3). Agents with `tools: inherit` or no `tools:` line are unbounded →
 * skipped (no meaningful envelope to enforce).
 *
 * ENFORCE: default OFF. `enforce` is the DURABLE enforcement lever and is set
 * ONLY by an explicit opts.enforcePolicy (an allowlist of base agent types, or a
 * predicate). Nothing is flipped live by this module; the FLIP-CANDIDATES table
 * recommends which types to add to the policy.
 *
 * FAIL-OPEN (hard requirement, ADR-SEC-001): registerDispatchContract NEVER
 * throws and NEVER blocks a dispatch. Every failure returns
 * {registered:false, reason}. The caller wraps it in try/catch anyway.
 */

const fs = require('fs');
const path = require('path');
const store = require('./store.cjs');
const { CLASSES: BASH_CLASSES } = require('./classify-bash.cjs');

const SAFE_AGENT_NAME = /^[\w-]+$/;
const MAX_PURPOSE = 200;

/**
 * Parse the `tools:` line out of an agent `.md` frontmatter block and map it to
 * capability classes. Returns null when the agent has no bounded tool surface
 * (missing file, no frontmatter, `tools: inherit`, or no `tools:` line).
 * @param {string} subagentType base agent type (e.g. 'sonnet-execute')
 * @param {object} [opts] {agentsDir?:string}
 * @returns {{classes:string[], tools:string[]}|null}
 */
function classesForAgentType(subagentType, opts = {}) {
  if (typeof subagentType !== 'string' || !SAFE_AGENT_NAME.test(subagentType)) return null;
  const agentsDir = opts.agentsDir || path.join(process.cwd(), '.claude', 'agents');
  let content;
  try {
    content = fs.readFileSync(path.join(agentsDir, `${subagentType}.md`), 'utf8');
  } catch {
    return null; // unknown agent type -> no bounded envelope
  }
  const fm = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return null;
  const toolsLine = fm[1].match(/^tools:\s*(.+)$/m);
  if (!toolsLine) return null; // no tools: line -> inherits all -> unbounded
  const raw = toolsLine[1].trim();
  if (!raw || raw.toLowerCase() === 'inherit') return null; // unbounded
  const tools = raw.split(',').map((t) => t.trim()).filter(Boolean);
  const classes = new Set(store.classesForTools(tools));
  if (tools.includes('Bash')) {
    for (const c of BASH_CLASSES) classes.add(c); // Bash access ~= broad
  }
  return { classes: Array.from(classes), tools };
}

/**
 * Resolve the enforce flag for a dispatch from an optional policy. Default OFF.
 * @param {string} subagentType
 * @param {object} [opts] {enforcePolicy?: string[]|((t:string)=>boolean)}
 * @returns {boolean}
 */
function enforceFor(subagentType, opts = {}) {
  const pol = opts.enforcePolicy;
  if (!pol) return false;
  try {
    if (Array.isArray(pol)) return pol.includes(subagentType);
    if (typeof pol === 'function') return pol(subagentType) === true;
  } catch {
    return false;
  }
  return false;
}

/**
 * Register a per-task intent contract for a dispatched teammate. Called from the
 * dispatch path. Fail-open: never throws, never blocks.
 * @param {object} event PreToolUse stdin event for an Agent/Task tool call
 * @param {object} [opts] {stateDir?:string, agentsDir?:string, now?:number,
 *        enforcePolicy?:string[]|Function, ttl_ms?:number, path_ownership?:string[]}
 * @returns {{registered:boolean, reason?:string, contract_id?:string,
 *           handle?:string, subagent_type?:string, allowed_tool_classes?:string[]}}
 */
function registerDispatchContract(event, opts = {}) {
  try {
    if (!event || (event.tool_name !== 'Agent' && event.tool_name !== 'Task')) {
      return { registered: false, reason: 'not-a-dispatch' };
    }
    const ti = event.tool_input || {};
    const name = typeof ti.name === 'string' ? ti.name.trim() : '';
    // Named teammates only; the constant native-teams marker is not a name.
    if (!name || name === 'in_process_teammate') {
      return { registered: false, reason: 'no-name' };
    }
    const subagentType = typeof ti.subagent_type === 'string' ? ti.subagent_type : '';
    const derived = classesForAgentType(subagentType, opts);
    if (!derived) {
      return { registered: false, reason: 'unbounded-or-unknown-agent-type', handle: name };
    }
    const purpose = typeof ti.description === 'string' ? ti.description.slice(0, MAX_PURPOSE) : '';
    const record = store.registerTypeContract({
      session_id: event.session_id,
      agent_type: name,
      subagent_type: subagentType,
      purpose,
      allowed_tool_classes: derived.classes,
      path_ownership: Array.isArray(opts.path_ownership) ? opts.path_ownership : [],
      ttl_ms: opts.ttl_ms,
      enforce: enforceFor(subagentType, opts),
    }, { stateDir: opts.stateDir, now: opts.now });
    return {
      registered: true,
      contract_id: record.contract_id,
      handle: name,
      subagent_type: subagentType,
      allowed_tool_classes: record.allowed_tool_classes,
    };
  } catch (e) {
    // FAIL-OPEN: a registration failure must never block a dispatch.
    return { registered: false, reason: 'error', error: e && e.message };
  }
}

module.exports = { registerDispatchContract, classesForAgentType, enforceFor };
