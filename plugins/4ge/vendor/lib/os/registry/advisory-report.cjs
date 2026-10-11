'use strict';

const { createHash } = require('node:crypto');

// Deliberately narrow public-data protocol, not a generic stdout/stderr passthrough.
const SCHEMA = 'advisory-watch/v1';
const MAX_GATES = 32;
const MAX_OFFENDERS = 8;
const MAX_IDS = 4;
const SEVERITIES = ['unknown', 'info', 'low', 'moderate', 'high', 'critical'];
// Why a gate is STALE, as a fixed code: the cause reaches the sentinel without raw stderr.
const STALE_REASONS = ['ref', 'tree', 'budget', 'binary', 'spawn', 'timeout', 'manifest', 'lockfile', 'audit-output', 'unknown'];
const label = (v) => typeof v === 'string' && /^[a-zA-Z0-9_./@ (),-]{1,120}$/.test(v);
const packageName = (v) => typeof v === 'string' && /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]{1,214}$/i.test(v) && v.length <= 214;
const advisoryId = (v) => typeof v === 'string' && /^(?:GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}|[0-9]{1,16})$/i.test(v);
const count = (v) => Number.isSafeInteger(v) && v >= 0;
const hasOverflow = (g) => g.moreOffenders > 0 || g.offenders.some((o) => o.moreAdvisories > 0);

function publicAdvisoryReport(result) {
  return {
    schema: SCHEMA,
    expected: result.expected,
    gates: result.gates.map((g) => {
      const offenders = [...(g.offenders || [])].sort((a, b) =>
        SEVERITIES.indexOf(b.severity) - SEVERITIES.indexOf(a.severity) || String(a.name).localeCompare(String(b.name)));
      const publicOffenders = offenders.map((o) => ({
        name: packageName(o.name) ? o.name : 'unknown-package',
        severity: SEVERITIES.includes(o.severity) ? o.severity : 'unknown',
        advisories: [...new Set((o.advisories || []).filter(advisoryId))].sort(),
      }));
      // Hash the complete parsed PUBLIC identity set before either display cap.
      // Canonical ordering/deduplication avoids false changes from audit ordering;
      // raw stderr, titles and unvalidated identifiers never enter this digest.
      const identities = [...new Set(publicOffenders.map((o) =>
        JSON.stringify([o.name, o.severity, o.advisories])))].sort();
      const advisorySetSha256 = createHash('sha256').update(JSON.stringify(identities)).digest('hex');
      return {
        advisorySetSha256,
        repo: label(g.repo) ? g.repo : 'unknown-repo',
        gate: label(g.gate) ? g.gate : 'unknown-gate',
        status: g.status,
        ...(g.status === 'stale' ? { reason: STALE_REASONS.includes(g.reason) ? g.reason : 'unknown' } : {}),
        offenders: publicOffenders.slice(0, MAX_OFFENDERS).map((o) => ({ ...o,
          advisories: o.advisories.slice(0, MAX_IDS), moreAdvisories: Math.max(0, o.advisories.length - MAX_IDS),
        })),
        moreOffenders: Math.max(0, offenders.length - MAX_OFFENDERS),
      };
    }),
  };
}

function projectAdvisoryReport(stdout) {
  const invalid = { ok: false, detail: 'invalid advisory report — coverage unknown' };
  if (typeof stdout !== 'string' || stdout.length > 128 * 1024) return invalid;
  let r;
  try { r = JSON.parse(stdout); } catch { return invalid; }
  if (!r || r.schema !== SCHEMA || !count(r.expected) || r.expected > MAX_GATES ||
      !Array.isArray(r.gates) || r.gates.length !== r.expected) return invalid;
  const seen = new Set();
  for (const g of r.gates) {
    if (!g || !label(g.repo) || !label(g.gate) || !['ok', 'red', 'stale'].includes(g.status) ||
        !Array.isArray(g.offenders) || g.offenders.length > MAX_OFFENDERS || !count(g.moreOffenders)) return invalid;
    if (g.status === 'stale' ? !STALE_REASONS.includes(g.reason)
      : Object.prototype.hasOwnProperty.call(g, 'reason')) return invalid;
    const key = JSON.stringify([g.repo, g.gate]);
    if (seen.has(key)) return invalid;
    seen.add(key);
    for (const o of g.offenders) {
      if (!o || !packageName(o.name) || !SEVERITIES.includes(o.severity) || !count(o.moreAdvisories) ||
          !Array.isArray(o.advisories) || o.advisories.length > MAX_IDS || !o.advisories.every(advisoryId)) return invalid;
    }
    if (g.status !== 'red' && (g.offenders.length || g.moreOffenders)) return invalid;
    if ((hasOverflow(g) || g.advisorySetSha256 !== undefined) &&
        (typeof g.advisorySetSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(g.advisorySetSha256))) return invalid;
  }
  const stale = r.gates.filter((g) => g.status === 'stale').length;
  const red = r.gates.filter((g) => g.status === 'red').length;
  const evaluated = r.expected - stale;
  const lines = [`advisory-watch: coverage ${evaluated}/${r.expected}; ${red} red; ${stale} STALE`];
  for (const g of r.gates) {
    if (g.status === 'ok') continue;
    const names = g.offenders.map((o) => `${o.name} ${o.severity}` +
      (o.advisories.length ? ` [${o.advisories.join(',')}${o.moreAdvisories ? `,+${o.moreAdvisories} more` : ''}]` : '')).join('; ');
    lines.push(`${g.repo} ${g.gate}: ${g.status.toUpperCase()} — ` +
      (g.status === 'stale' ? `audit coverage unavailable (${g.reason})` :(names || 'advisory names unavailable')) +
      (g.moreOffenders ? ` (+${g.moreOffenders} more)` : '') +
      (hasOverflow(g) ? ` [full advisory set sha256:${g.advisorySetSha256}]` : ''));
  }
  return { ok: r.expected > 0 && stale === 0 && red === 0, detail: lines.join('\n    ') };
}

module.exports = { SCHEMA, STALE_REASONS, publicAdvisoryReport, projectAdvisoryReport };
