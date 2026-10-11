import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

const candidatePaths = [
  '.claude/agents/master-auditor.md',
  'plugins/4ge/agents/master-auditor.md',
  'components/agents/master-auditor.md',
  'plugins/4ge/skills/audit-implementation/SKILL.md',
  'plugins/4ge/skills/audit-integration/SKILL.md',
  'plugins/4ge/skills/audit-config/SKILL.md',
];

const sources = Object.fromEntries(
  candidatePaths.map((relativePath) => [
    relativePath,
    fs.readFileSync(path.join(repoRoot, relativePath), 'utf8'),
  ]),
);

const agentPaths = candidatePaths.slice(0, 3);
const fixtureIds = [
  'audit-api-error-contract-v1',
  'audit-performance-measure-first-v1',
  'audit-observability-false-success-v1',
  'audit-migration-expand-contract-v1',
  'audit-adr-tradeoffs-v1',
];
const nonControllerSentence =
  'These lenses enrich the existing domain auditors. They do not replace DFE, create a planner, authorize implementation, or merge source/test/runtime/CI/deploy/operator proof planes.';

describe('S649 audit-domain lens contract', () => {
  it('keeps the five evidence lenses and non-controller boundary in all agent variants', () => {
    for (const agentPath of agentPaths) {
      for (const fixtureId of fixtureIds) {
        expect(sources[agentPath], `${agentPath} missing ${fixtureId}`).toContain(fixtureId);
      }
      expect(sources[agentPath]).toContain(nonControllerSentence);
    }
  });

  it('contains no upstream identity, install command, or new top-level route', () => {
    for (const [relativePath, source] of Object.entries(sources)) {
      expect(source, relativePath).not.toMatch(/addyosmani/i);
      expect(source, relativePath).not.toMatch(
        /https?:\/\/[^\s)]*(?:addyosmani\/agent-skills|nextlevelbuilder\/ui-ux-pro-max-skill)/i,
      );
      expect(source, relativePath).not.toMatch(/npm install/i);
      expect(source, relativePath).not.toMatch(/plugin install/i);
      expect(source, relativePath).not.toMatch(/new top-level route/i);
    }
  });

  it('preserves line endings and harness-specific verification dates', () => {
    for (const agentPath of agentPaths.slice(0, 2)) {
      expect(sources[agentPath].endsWith('\n'), `${agentPath} must end with LF`).toBe(true);
      expect(sources[agentPath], `${agentPath} must not contain CRLF`).not.toContain('\r\n');
      // last-verified advances on every re-verification; assert the field's shape, not a date.
      expect(sources[agentPath]).toMatch(/^last-verified: \d{4}-\d{2}-\d{2}$/m);
    }
    expect(sources['components/agents/master-auditor.md']).toContain('last-verified: {{DATE}}');
  });

  it('uses each frozen cross-harness audit ID exactly once per agent variant', () => {
    expect(new Set(fixtureIds).size).toBe(fixtureIds.length);
    for (const agentPath of agentPaths) {
      for (const fixtureId of fixtureIds) {
        expect(sources[agentPath].split(fixtureId).length - 1, `${agentPath}:${fixtureId}`).toBe(1);
      }
    }
  });
});
