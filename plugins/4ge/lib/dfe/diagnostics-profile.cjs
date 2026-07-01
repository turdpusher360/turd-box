'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SCHEMA = 'forge.dfe.diagnostics-profile.v1';

const REQUIRED_FIELDS = Object.freeze([
  'subsystem',
  'operation',
  'phase',
  'resource',
  'code',
  'message',
  'recovery',
  'proof_plane',
]);

const TARGET_DEFINITIONS = Object.freeze([
  {
    id: 'anvil-desktop',
    label: 'Anvil packaged desktop startup',
    paths: ['claude-commander/src/main'],
    proof_planes: ['source', 'desktop-package', 'desktop-launch'],
    fail_loud: [
      'Electron main process cannot load',
      'packaged renderer entry cannot load',
      'required runtime dependency is missing',
    ],
    degrade: [
      'optional account/profile discovery is unavailable',
      'optional board/history preview is unavailable',
    ],
  },
  {
    id: 'claude-hooks',
    label: 'Claude hook runtime',
    paths: ['.claude/hooks'],
    proof_planes: ['source', 'hook-runtime'],
    fail_loud: [
      'blocking hook cannot parse its input',
      'required continuity writer selects stale session state',
    ],
    degrade: [
      'advisory hook cannot write a non-critical report',
      'optional telemetry append fails',
    ],
  },
  {
    id: 'agentic-os',
    label: 'Agentic OS boot/kernel/services',
    paths: ['lib/os'],
    proof_planes: ['source', 'boot-runtime'],
    fail_loud: [
      'required kernel registry cannot initialize',
      'capability contract validation fails',
    ],
    degrade: [
      'optional health probe is unavailable',
      'non-critical observer/watch read fails',
    ],
  },
  {
    id: 'operator-companion',
    label: 'Operator Companion event spine and cartridge',
    paths: ['plugins/operator-companion'],
    proof_planes: ['source', 'codex-hook-runtime', 'console'],
    fail_loud: [
      'session cartridge writer loses current-session identity',
      'hook event redaction fails before persistence',
    ],
    degrade: [
      'console cannot read optional history',
      'advisory enrichment source is unavailable',
    ],
  },
  {
    id: 'plugin-4ge',
    label: '4ge plugin commands, DFE, signoff, and HUD helpers',
    paths: ['plugins/4ge'],
    proof_planes: ['source', 'plugin-runtime'],
    fail_loud: [
      'declared command/skill path is missing',
      'DFE report path cannot be written',
      'signoff continuity write silently fails',
    ],
    degrade: [
      'HUD optional zone cannot render',
      'advisory diagnostics report is incomplete',
    ],
  },
  {
    id: 'forge-codex',
    label: 'Forge for Codex plugin review skills',
    paths: ['plugins/forge-codex'],
    proof_planes: ['source', 'codex-skill'],
    fail_loud: [
      'public skill manifest exposes private control-plane surface',
      'review skill claims multi-agent parity it did not run',
    ],
    degrade: [
      'optional continuity note cannot be appended',
      'advisory review artifact is unavailable',
    ],
  },
  {
    id: 'volatile-runs',
    label: 'Volatile _runs state readers and writers',
    paths: ['_runs'],
    proof_planes: ['runtime-artifact'],
    fail_loud: [
      'continuity artifact is replaced with stale or generic paths',
      'atomic write leaves a corrupt parseable artifact',
    ],
    degrade: [
      'history tail read hits EBUSY/EPERM/EACCES',
      'optional preview screenshot/log is locked',
    ],
  },
]);

const AUDIT_CONTRACT = Object.freeze({
  fail_loud_when: [
    'primary startup cannot complete',
    'a command reports success while the requested proof plane failed',
    'a continuity writer would persist stale, generic, or wrong-repo state',
    'a security/redaction path cannot prove secret values were withheld',
  ],
  degrade_when: [
    'optional history, preview, or telemetry read is unavailable',
    'watchers observe transient file locks such as EBUSY, EPERM, or EACCES',
    'advisory add-on discovery fails without blocking the primary action',
  ],
  redaction: [
    'Do not include secret values',
    'Report secret presence, class, and length only when useful',
    'Prefer project-relative paths unless an absolute path is required for recovery',
  ],
});

function exists(repoRoot, relativePath) {
  return fs.existsSync(path.join(repoRoot, relativePath));
}

function readPackageName(repoRoot) {
  const packagePath = path.join(repoRoot, 'package.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    if (parsed && typeof parsed.name === 'string' && parsed.name.trim()) {
      return parsed.name.trim();
    }
  } catch {
    // Fall through to directory-derived name; the diagnostics profile is advisory.
  }
  return path.basename(repoRoot);
}

function normalizeRepoRoot(repoRoot) {
  return path.resolve(repoRoot || process.cwd());
}

function discoverTargets(repoRoot) {
  const targets = [];
  for (const target of TARGET_DEFINITIONS) {
    const presentPaths = target.paths.filter((relativePath) => exists(repoRoot, relativePath));
    if (presentPaths.length === 0) continue;
    targets.push({
      id: target.id,
      label: target.label,
      paths: presentPaths,
      proof_planes: [...target.proof_planes],
      fail_loud: [...target.fail_loud],
      degrade: [...target.degrade],
    });
  }
  return targets;
}

function buildDiagnosticsProfile(options = {}) {
  const repoRoot = normalizeRepoRoot(options.repoRoot);
  const repoName = options.repoName || readPackageName(repoRoot);
  return {
    schema: SCHEMA,
    generated_at: new Date(0).toISOString(),
    repo: {
      name: repoName,
      root: repoRoot,
    },
    required_fields: [...REQUIRED_FIELDS],
    targets: discoverTargets(repoRoot),
    audit_contract: {
      fail_loud_when: [...AUDIT_CONTRACT.fail_loud_when],
      degrade_when: [...AUDIT_CONTRACT.degrade_when],
      redaction: [...AUDIT_CONTRACT.redaction],
    },
    output_paths: {
      profile_json: '_runs/review/dfe-diagnostics-profile.json',
      report_md: '_runs/review/dfe-diagnostics-report.md',
      board_field: '_runs/forge-board/latest.json',
    },
  };
}

function redactDiagnosticText(value) {
  return String(value || '')
    .replace(/\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*)=([^\s]+)/gi, '$1=[REDACTED]')
    .replace(/\b(password|secret)\s*=\s*([^\s]+)/gi, '$1=[REDACTED]')
    .replace(/\b(token)\s+(sk-[A-Za-z0-9_-]+|sk-proj-[A-Za-z0-9_-]+|gh[pousr]_[A-Za-z0-9_]+)/gi, '$1 [REDACTED]')
    .replace(/\b(sk-proj-[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]+|gh[pousr]_[A-Za-z0-9_]+)\b/g, '[REDACTED]');
}

function renderDiagnosticsBrief(profile) {
  const lines = [];
  lines.push('### Diagnostics Robustness Profile');
  lines.push(`Repo: ${profile.repo.name}`);
  lines.push(`Required structured fields: ${profile.required_fields.join(', ')}`);
  lines.push('Audit targets:');
  for (const target of profile.targets) {
    lines.push(`- ${target.id}: ${target.paths.join(', ')} (${target.proof_planes.join(', ')})`);
  }
  if (profile.targets.length === 0) {
    lines.push('- none discovered from known Forge diagnostic surfaces');
  }
  lines.push('Fail loud when:');
  for (const rule of profile.audit_contract.fail_loud_when) lines.push(`- ${rule}`);
  lines.push('Degrade when:');
  for (const rule of profile.audit_contract.degrade_when) lines.push(`- ${rule}`);
  lines.push('Redaction:');
  for (const rule of profile.audit_contract.redaction) lines.push(`- ${rule}`);
  return redactDiagnosticText(lines.join('\n'));
}

if (require.main === module) {
  const repoRoot = process.argv[2] || process.cwd();
  const profile = buildDiagnosticsProfile({ repoRoot });
  process.stdout.write(JSON.stringify(profile, null, 2) + '\n');
}

module.exports = {
  SCHEMA,
  REQUIRED_FIELDS,
  TARGET_DEFINITIONS,
  AUDIT_CONTRACT,
  buildDiagnosticsProfile,
  renderDiagnosticsBrief,
  redactDiagnosticText,
};
