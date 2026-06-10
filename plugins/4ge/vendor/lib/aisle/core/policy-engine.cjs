'use strict';

/**
 * AISLE Policy Engine
 *
 * Aggregates scanner findings into a final policy decision via:
 *   1. Rule of Two compound escalation (runs FIRST to prevent LOG-tier evasion)
 *   2. Tier resolution (highest tier wins; BLOCK > WARN > LOG)
 *   3. Exception check (config-defined, time-limited overrides)
 *   4. Final aggregation (union actions, attach ruleOfTwoTriggered)
 *
 * QUARANTINE is an action modifier, not a tier.
 * Decision shape: { tier, actions[], findings[], ruleOfTwoTriggered }
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TIER_RANK = { BLOCK: 3, WARN: 2, LOG: 1, ALLOW: 0 };
const VALID_TIERS = new Set(['BLOCK', 'WARN', 'LOG', 'ALLOW']);

// ---------------------------------------------------------------------------
// evaluateRuleOfTwo(findings) -> { triggered, flags, escalation }
//
// OR-aggregates { untrusted, sensitive, external } boolean flags across ALL
// findings for a single tool call (cross-scanner aggregation). Findings with
// missing flags are excluded from aggregation (no false escalation).
//
// 2-of-3 true -> BLOCK
// 3-of-3 true -> BLOCK+quarantine
// <2 true     -> no escalation (escalation: null)
// ---------------------------------------------------------------------------

function evaluateRuleOfTwo(findings) {
  if (!Array.isArray(findings) || findings.length === 0) {
    return { triggered: false, flags: { untrusted: false, sensitive: false, external: false }, escalation: null };
  }

  // OR-aggregate across findings that have explicit flags; skip findings with missing flags
  const flaggedFindings = findings.filter(f => f.flags != null);
  if (flaggedFindings.length === 0) {
    return { triggered: false, flags: { untrusted: false, sensitive: false, external: false }, escalation: null };
  }
  const aggregated = flaggedFindings.reduce(
    (acc, finding) => {
      const f = finding.flags;
      return {
        untrusted: acc.untrusted || (f.untrusted === true),
        sensitive: acc.sensitive || (f.sensitive === true),
        external:  acc.external  || (f.external === true),
      };
    },
    { untrusted: false, sensitive: false, external: false }
  );

  const trueCount = [aggregated.untrusted, aggregated.sensitive, aggregated.external]
    .filter(Boolean).length;

  if (trueCount >= 3) {
    return { triggered: true, flags: aggregated, escalation: 'BLOCK+quarantine' };
  }
  if (trueCount >= 2) {
    return { triggered: true, flags: aggregated, escalation: 'BLOCK' };
  }
  return { triggered: false, flags: aggregated, escalation: null };
}

// ---------------------------------------------------------------------------
// checkException(finding, exceptions) -> { excepted, overrideTier? }
//
// Checks whether a finding is covered by a documented, non-expired exception
// in aisle-config.json. Match criteria: same scanner + same pattern.
// Expired exceptions (expires date in the past) are ignored.
//
// P2-5: Scanner D (integrity) findings are never excepable — integrity
// violations must always surface at their original tier regardless of any
// universal or scanner-null exception entries in config.
// P2-6: Scanner D sets only 1 R2 flag (sensitive), so Rule-of-Two cannot
// rescue an excepted Scanner D finding. The exception-immunity here also
// closes the R2 gap described in P2-6.
// ---------------------------------------------------------------------------

// P2-5/P2-6: Scanners whose findings are immune to exception downgrades.
const EXCEPTION_IMMUNE_SCANNERS = new Set(['D']);

function checkException(finding, exceptions) {
  if (!Array.isArray(exceptions) || exceptions.length === 0) {
    return { excepted: false };
  }

  // P2-5: Scanner D findings are never excepable — skip exception processing.
  if (EXCEPTION_IMMUNE_SCANNERS.has(finding.scanner)) {
    return { excepted: false };
  }

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  for (const ex of exceptions) {
    // Reject universal wildcards: at least one of scanner or pattern must be specified
    if (ex.scanner == null && ex.pattern == null) continue;
    const scannerMatch = ex.scanner == null || ex.scanner === finding.scanner;
    const patternMatch = ex.pattern == null || ex.pattern === finding.pattern;

    if (!scannerMatch || !patternMatch) {
      continue;
    }

    // Expired exception — skip
    if (ex.expiry && ex.expiry < today) {
      continue;
    }

    return { excepted: true, overrideTier: ex.tier };
  }

  return { excepted: false };
}

// ---------------------------------------------------------------------------
// _resolveTier(tier) -> canonical tier string
//
// Unknown/invalid tiers default to BLOCK (fail-closed).
// ---------------------------------------------------------------------------

function _resolveTier(tier) {
  if (VALID_TIERS.has(tier)) {
    return tier;
  }
  return 'BLOCK';
}

// ---------------------------------------------------------------------------
// aggregate(findings, config) -> { tier, actions[], findings[], ruleOfTwoTriggered }
//
// Full pipeline:
//   Step 1: Rule of Two (before tier resolution — prevents LOG-tier evasion)
//   Step 2: Tier resolution per finding (invalid tier -> BLOCK)
//   Step 3: Exception check per finding (may lower tier)
//   Step 4: Final aggregation (highest tier wins; union actions)
// ---------------------------------------------------------------------------

function aggregate(findings, config) {
  if (findings == null || !Array.isArray(findings) || findings.length === 0) {
    return { tier: 'ALLOW', actions: [], findings: [], ruleOfTwoTriggered: false };
  }

  const exceptions = (config && Array.isArray(config.exceptions)) ? config.exceptions : [];

  // --- Step 1: Rule of Two (runs first) ---
  const ruleOfTwo = evaluateRuleOfTwo(findings);

  // --- Steps 2 + 3: Resolve tiers and apply exceptions per finding ---
  const resolvedFindings = findings.map(finding => {
    const baseTier = _resolveTier(finding.tier);
    const { excepted, overrideTier } = checkException(finding, exceptions);
    const effectiveTier = excepted && overrideTier ? _resolveTier(overrideTier) : baseTier;
    return { ...finding, _effectiveTier: effectiveTier };
  });

  // --- Step 4: Aggregate ---

  // Highest tier across all findings (after exceptions)
  let highestTier = 'ALLOW';
  for (const rf of resolvedFindings) {
    if (TIER_RANK[rf._effectiveTier] > TIER_RANK[highestTier]) {
      highestTier = rf._effectiveTier;
    }
  }

  // Rule of Two escalation overrides if it demands a higher tier
  const ruleOfTwoTriggered = ruleOfTwo.triggered;
  if (ruleOfTwo.triggered) {
    const rot2Tier = 'BLOCK';
    if (TIER_RANK[rot2Tier] > TIER_RANK[highestTier]) {
      highestTier = rot2Tier;
    }
  }

  // Union all actions; Rule of Two 3-of-3 injects quarantine
  const actionSet = new Set();
  for (const rf of resolvedFindings) {
    if (Array.isArray(rf.actions)) {
      for (const action of rf.actions) {
        actionSet.add(action);
      }
    }
  }
  if (ruleOfTwo.escalation === 'BLOCK+quarantine') {
    actionSet.add('quarantine');
  }

  // Strip internal _effectiveTier from returned findings
  const cleanFindings = resolvedFindings.map(({ _effectiveTier: _, ...rest }) => rest);

  return {
    tier: highestTier,
    actions: Array.from(actionSet),
    findings: cleanFindings,
    ruleOfTwoTriggered,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { aggregate, evaluateRuleOfTwo, checkException };
