import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// DIS-ARC-001 P0-3 drift guard.
//
// `forge` is the ONLY plugin name that is BOTH a command (commands/forge.md)
// and a same-named skill (skills/forge/SKILL.md). The two files share
// description / argument-hint / Phase-4.5 prose with NO drift detection. This
// test pins the intended command->skill contract so future drift is caught,
// and locks the Leg-2 anti-double-invoke fix (disable-model-invocation: true)
// against regression (FB-02; dev-memory 335453e8 / 103256be).
//
// Assertions were chosen to be TRUE against HEAD b851d7c9 (files read before
// authoring). This is a contract guard, not a brittle whole-file snapshot.

const pluginRoot = path.resolve(import.meta.dirname, '..');

function readPluginFile(relativePath) {
  return fs.readFileSync(path.join(pluginRoot, relativePath), 'utf8');
}

// Naive front-matter splitter: returns { frontmatter, body } for a markdown
// file whose first line is a `---` fence. Good enough for these two files.
function splitFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { frontmatter: '', body: content };
  return { frontmatter: match[1], body: match[2] };
}

describe('forge command<->skill drift guard (DIS-ARC-001 P0-3)', () => {
  const command = readPluginFile('commands/forge.md');
  const skill = readPluginFile('skills/forge/SKILL.md');
  const skillParts = splitFrontmatter(skill);
  const commandParts = splitFrontmatter(command);

  // --- (c) Leg-2 fix must not regress -------------------------------------
  // The forge SKILL must declare disable-model-invocation: true so the model
  // cannot auto-invoke it by description-match ON TOP of the explicit command
  // dispatch (the original FB-02 duplicate-execution mechanism).
  it('skill keeps disable-model-invocation: true (Leg-2 anti-double-invoke fix)', () => {
    expect(skillParts.frontmatter).toMatch(/^\s*disable-model-invocation:\s*true\s*$/m);
  });

  it('skill front-matter declares name: forge (the collision name being guarded)', () => {
    expect(skillParts.frontmatter).toMatch(/^\s*name:\s*forge\s*$/m);
  });

  // --- (a) command dispatches to the skill exactly once -------------------
  // The command body must end by handing off to the forge skill, and must do
  // so exactly once. More than one "invoke ... skill" directive in the command
  // is the drift signature of a re-fattened router re-emitting dispatch prose.
  it('command references invoking the forge skill exactly once', () => {
    const invokeMatches = commandParts.body.match(/[Ii]nvoke the forge skill/g) || [];
    expect(invokeMatches.length).toBe(1);
  });

  it('command dispatch line is the explicit single-handoff form with no intermediate output', () => {
    expect(commandParts.body).toContain(
      'Invoke the forge skill with the parsed arguments. Do not output any intermediate text before the skill activates.',
    );
  });

  // --- (b) command does NOT re-emit the Phase 4.5 body twice ---------------
  // The Phase 4.5 review-panel documentation lives in the command as a single
  // documentation block. Exactly one Phase 4.5 heading and one panel-composition
  // block must exist; duplication is the drift this guard exists to catch.
  it('command emits the Phase 4.5 heading exactly once (no duplicated body)', () => {
    const headings = command.match(/^##\s*Phase 4\.5:/gm) || [];
    expect(headings.length).toBe(1);
  });

  it('command emits the Panel composition block exactly once', () => {
    const panels = command.match(/\*\*Panel composition\*\*/g) || [];
    expect(panels.length).toBe(1);
  });

  // The skill owns the 7-phase pipeline; it must NOT also carry the command's
  // Phase 4.5 review-panel documentation block (that body lives in the command
  // only). This keeps the duplicated prose surface to a single owner.
  it('skill does not re-emit the command Panel composition block', () => {
    expect(skill).not.toContain('**Panel composition**');
  });

  // --- shared metadata parity (drift detection on the duplicated fields) ---
  // description and argument-hint exist in BOTH front-matters. They need not be
  // byte-identical, but argument-hint is the same contract surface in both and
  // is asserted equal so a change to one without the other trips this guard.
  it('command and skill share the same argument-hint contract', () => {
    const cHint = commandParts.frontmatter.match(/^\s*argument-hint:\s*(.+)$/m);
    const sHint = skillParts.frontmatter.match(/^\s*argument-hint:\s*(.+)$/m);
    expect(cHint).not.toBeNull();
    expect(sHint).not.toBeNull();
    expect(cHint[1].trim()).toBe(sHint[1].trim());
  });

  it('both command and skill describe forge as a multi-teammate orchestrator', () => {
    expect(commandParts.frontmatter).toContain('Multi-teammate orchestrator');
    expect(skillParts.frontmatter).toContain('Multi-teammate orchestrator');
  });
});
