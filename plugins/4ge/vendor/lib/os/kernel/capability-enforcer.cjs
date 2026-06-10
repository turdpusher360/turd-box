'use strict';

const contracts = require('./contracts.cjs');

/**
 * Create a new capability enforcer instance.
 *
 * The enforcer maintains a registry of agent contracts and exposes
 * `checkTool`, `checkScope`, and `getContract` APIs for enforcement
 * decisions at spawn time.
 *
 * STATUS (upstream): registration is wired (boot-sequence stepInitContracts, upstream);
 * `checkTool`/`checkScope` have NO live consumers — enforcement is advisory/inert
 * pending the RBAC-ENF-001 Phase 2/3 enforced flip. Do not describe this module
 * as active RBAC.
 *
 * Design notes:
 * - Default-deny: unregistered agents are blocked. Register a permissive
 *   contract for the lead agent at boot time (e.g. via registerContract('lead', {})).
 * - `registerContract` merges the provided contract over DEFAULT_CONTRACT
 *   so partial overrides (e.g. only `tools`) preserve scope defaults.
 * - Enforcement is deny-only (no input mutation). Callers act on the
 *   returned `{ allowed, reason }` object.
 *
 * @returns {{ registerContract, checkTool, checkScope, getContract }}
 */
function createEnforcer() {
  /** @type {Map<string, object>} */
  const registry = new Map();

  /**
   * Register an agent contract, merging it over DEFAULT_CONTRACT.
   *
   * @param {string} agentId
   * @param {object} contract - Partial or full contract object
   */
  function registerContract(agentId, contract) {
    if (!agentId || typeof agentId !== 'string') {
      throw new Error('registerContract: agentId must be a non-empty string');
    }
    const merged = contracts.merge(contracts.DEFAULT_CONTRACT, contract);
    registry.set(agentId, merged);
  }

  /**
   * Check whether a tool is permitted for the given agent.
   *
   * Unregistered agents are default-denied (no contract = no access).
   * Register a permissive contract at boot time for the lead agent.
   * Registered agents are checked against their stored contract.
   *
   * @param {string} agentId
   * @param {string} toolName
   * @returns {{ allowed: boolean, reason?: string }}
   */
  function checkTool(agentId, toolName) {
    if (!registry.has(agentId)) {
      return { allowed: false, reason: 'no contract registered for agent' };
    }

    const contract = registry.get(agentId);
    const allowed = contracts.isAllowed(contract, toolName);

    if (allowed) {
      return { allowed: true };
    }

    return {
      allowed: false,
      reason: `tool "${toolName}" not in contract for agent "${agentId}"`,
    };
  }

  /**
   * Check whether a file path falls within the agent's scope for
   * the given access mode.
   *
   * Unregistered agents are default-denied (no contract = no access).
   * Register a permissive contract at boot time for the lead agent.
   * Registered agents are checked against their stored contract scope.
   *
   * @param {string} agentId
   * @param {string} filePath
   * @param {'write'|'read'} mode
   * @returns {{ allowed: boolean, reason?: string }}
   */
  function checkScope(agentId, filePath, mode) {
    if (!registry.has(agentId)) {
      return { allowed: false, reason: 'no contract registered for agent' };
    }

    const contract = registry.get(agentId);
    const allowed = contracts.isInScope(contract, filePath, mode);

    if (allowed) {
      return { allowed: true };
    }

    return {
      allowed: false,
      reason: `path "${filePath}" is outside ${mode} scope for agent "${agentId}"`,
    };
  }

  /**
   * Return the stored contract for an agent, or DEFAULT_CONTRACT if
   * the agent has not been registered.
   *
   * @param {string} agentId
   * @returns {object}
   */
  function getContract(agentId) {
    return registry.get(agentId) ?? contracts.DEFAULT_CONTRACT;
  }

  return { registerContract, checkTool, checkScope, getContract };
}

module.exports = { createEnforcer };
