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
// authoring). Sections (a), (d) and (e) were rewritten 2026-09-24 against
// 4d7a0d5c for the read-by-path handoff (forge-resolver r2, answering the five
// findings of the S697 r1 BLOCK). Sections (a) and (e) were tightened again
// the same day (r3, S698 L3-8 findings 2 and 3). This is a contract guard, not
// a brittle whole-file snapshot.

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

  // --- (a) command hands off to the skill FILE exactly once ---------------
  // Instruction-plane repair spec §8.5, fix candidate 1. No skill name reaches
  // skills/forge/SKILL.md: (c) hides it from the model, a bare `forge` resolved
  // to TP360's stale commands/forge.md through --add-dir, and `4ge:forge`
  // resolves to this command itself. So the command reads the skill by path.
  // More than one path handoff is the drift signature of a re-fattened router
  // re-emitting dispatch prose.
  const HANDOFF_PATH = '`${CLAUDE_PLUGIN_ROOT}/skills/forge/SKILL.md`';

  it('command reads the forge skill file by plugin-root path exactly once', () => {
    expect(commandParts.body.split(HANDOFF_PATH).length - 1).toBe(1);
    expect(commandParts.body).toContain(
      'Read ' + HANDOFF_PATH + ' in full and follow it as the orchestration instructions for this invocation, whatever the arguments say.',
    );
  });

  // Handoff-target guard. It checks two concrete forms, not every possible
  // phrasing: the object phrase "forge skill" (bare, backticked or
  // 4ge:-namespaced) in either word order ("the forge skill", "skill
  // `4ge:forge`", "skill named forge"), and Skill-tool call syntax whose
  // target is forge or 4ge:forge. The Skill forms need that target quoted
  // within the call's first 80 characters, so Skill({ skill: "forge" }) is
  // caught in either key order while Skill("dfe") and other targets are not
  // (S698 L3-8 finding 2). Because the object phrase itself is banned from the
  // command body, any verb in front of it is caught too; that ban is broad on
  // purpose. A namespaced name with no "skill" word and no Skill syntax (e.g.
  // "hand off to `4ge:forge`") is NOT covered.
  const HANDOFF_TARGET_FORMS = [
    /\b(?:4ge:)?forge`?\s+skill\b/gi,
    /\bskill\b\s*(?:named\s+|called\s+|:\s*)?["'`]?(?:4ge:)?forge\b/gi,
    /\bSkill\s*\([^)]{0,80}?["'`](?:4ge:)?forge["'`]/g,
    /\bSkill\s+(?:\{[^}]{0,80}?)?["'`](?:4ge:)?forge["'`]/g,
  ];
  const handoffTargetHits = (text) => HANDOFF_TARGET_FORMS.flatMap((re) => text.match(re) || []);

  it('command body names no forge skill as a handoff target (object phrase either order, or Skill-tool syntax)', () => {
    expect(
      handoffTargetHits(commandParts.body),
      'commands/forge.md names a forge skill as a handoff target; an --add-dir command can shadow it',
    ).toEqual([]);
  });

  it('handoff-target guard catches every form it claims (positive fixtures)', () => {
    const forms = [
      'Invoke the forge skill with the parsed arguments.',
      'Hand off to the `4ge:forge` skill now.',
      'The forge skill should then be loaded.',
      'Load skill `4ge:forge`.',
      'Run the skill named forge.',
      'Skill("forge")',
      'Skill(skill: "4ge:forge")',
      'Skill({ skill: "forge", args: "x" })',
      'Skill({ args: "run x", skill: "4ge:forge" })',
      "Skill('4ge:forge')",
      'Skill "forge"',
      'Skill {skill: "forge"}',
    ];
    for (const form of forms) expect(handoffTargetHits(form), form).not.toEqual([]);
  });

  it('handoff-target guard ignores Skill calls whose target is another skill (benign negatives)', () => {
    const calls = [
      'Skill("dfe")',
      'Skill({ skill: "review-project", args: "x" })',
      'Skill(skill: "4ge:4ge", args: "trust")',
      'Skill("4ge:forge-shipper")',
      'Skill "fix-hook"',
      'Use the Skill tool for review-adversarial.',
    ];
    for (const call of calls) expect(handoffTargetHits(call), call).toEqual([]);
  });

  it('handoff-target guard ignores prose that only mentions the names (negative fixtures)', () => {
    const prose = [
      'a bare `forge` can resolve to a same-named command from an added directory',
      '`4ge:forge` resolves back to this command',
      'Baseline ceremony, every forge session (SKILL.md Phase 3.5 + 4.5)',
      '**`audit-config`** skill on `@opus-audit`',
      "use the `_runs/` fallback that the skill's session-state reference names",
    ];
    for (const text of prose) expect(handoffTargetHits(text), text).toEqual([]);
  });

  // Output-suppression contract. "Before the skill activates" has no meaning
  // for a path read, and r1's "before you have read the skill file" let
  // assistant text through after the read but before the skill's own first
  // output. The contract spans dispatch to that first prescribed output.
  it("command keeps the no-intermediate-output rule up to the skill file's first prescribed output", () => {
    expect(commandParts.body).toContain(
      'Do not output any intermediate text between this command and the first output the skill file prescribes.',
    );
    expect(commandParts.body).not.toMatch(/before you have read the skill file/i);
  });

  // --- (d) raw-read placeholder mapping -----------------------------------
  // CC 2.1.282 renders a plugin command body through sSe() (the arguments) and
  // then fQ() (CLAUDE_PLUGIN_ROOT, CLAUDE_PROJECT_DIR, and CLAUDE_PLUGIN_DATA
  // when the plugin has a source), then replaces CLAUDE_SESSION_ID and
  // CLAUDE_EFFORT. A Read of the skill file, or of its references, gets none of
  // that. So every braced placeholder the skill tree uses must be mapped by the
  // command, whose own copy of the value IS expanded, and it must be one the
  // command loader expands (CLAUDE_SKILL_DIR, for one, is skill-mode only).
  // The walk covers the whole skill dir, so a placeholder added later fails
  // here until the command maps it.
  const COMMAND_EXPANDED = [
    'CLAUDE_PLUGIN_ROOT',
    'CLAUDE_PROJECT_DIR',
    'CLAUDE_PLUGIN_DATA',
    'CLAUDE_SESSION_ID',
    'CLAUDE_EFFORT',
  ];
  const listMarkdown = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return listMarkdown(full);
      return entry.name.endsWith('.md') ? [full] : [];
    });
  const skillTree = listMarkdown(path.join(pluginRoot, 'skills', 'forge'))
    .map((file) => fs.readFileSync(file, 'utf8'))
    .join('\n');
  const bracedNames = [...new Set([...skillTree.matchAll(/\$\{([A-Z][A-Z0-9_]*)\}/g)].map((m) => m[1]))];

  it('skill tree carries placeholders for the mapping guard to check', () => {
    expect(bracedNames).toContain('CLAUDE_PLUGIN_ROOT');
    expect(bracedNames).toContain('CLAUDE_PLUGIN_DATA');
    expect(skillTree).toContain('$ARGUMENTS');
  });

  it('command maps every braced placeholder the skill tree uses, and each is one the command loader expands', () => {
    for (const name of bracedNames) {
      expect(COMMAND_EXPANDED, name + ' is not expanded in a command body, so a mapping cannot carry it').toContain(name);
      expect(commandParts.body, name).toContain('the `' + name + '` placeholder means `${' + name + '}`');
    }
  });

  it('command maps the ARGUMENTS placeholder to the delimited arguments', () => {
    expect(commandParts.body).toContain(
      'the `ARGUMENTS` placeholder means the arguments between the marker lines above',
    );
  });

  it('command sends an unexpanded plugin-data value to the _runs/ fallback the session-state reference names', () => {
    expect(commandParts.body).toContain(
      "If the plugin-data value in the previous sentence still shows an unexpanded placeholder, this session has no plugin data directory: use the `_runs/` fallback that the skill's session-state reference names.",
    );
    expect(readPluginFile('skills/forge/references/session-state.md')).toMatch(/falls back to `_runs\/`/);
  });

  // --- (e) runtime frontmatter parity -------------------------------------
  // A path Read does not activate skill frontmatter. LOADER_KEYS is every
  // frontmatter key CC 2.1.282's plugin loader reads, for commands and skills
  // alike: wq() in binary sha256 3afe8535…eed3, offsets 204010676-204014446,
  // with the camelCase alias disallowedTools folded into disallowed-tools. The
  // list advances when a CC re-baseline finds wq() reading a different key
  // set. Each loader key is MIRRORED (it changes how the turn runs or renders,
  // so the command carries the skill's value; absent on both sides is parity)
  // or NOT_MIRRORED with its reason (S698 L3-8 finding 3). The skill's
  // `effort: high` was dropped rather than mirrored: a command's effort
  // overrides the session effort for that turn, rig lanes launch at xhigh, and
  // the skill value never applied anyway (the skill was unreachable by name).
  // `tools:` and `paths:` are not loader keys, so they are inert even in skill
  // mode.
  const LOADER_KEYS = [
    'agent', 'allowed-tools', 'argument-hint', 'arguments', 'background', 'context', 'description',
    'disable-model-invocation', 'disallowed-tools', 'effort', 'hooks', 'metadata', 'model', 'name',
    'shell', 'user-invocable', 'version', 'when_to_use',
  ];
  const MIRRORED = ['effort', 'model', 'allowed-tools', 'disallowed-tools', 'context', 'agent', 'shell', 'arguments', 'background'];
  const NOT_MIRRORED = {
    name: 'identity: the skill declares name: forge (pinned above); the command takes its name from its file',
    description: 'listing text; each surface describes itself (the orchestrator-description test below)',
    'argument-hint': 'pinned by the argument-hint contract test below',
    when_to_use: 'a model auto-invocation hint, and the skill disables model invocation',
    version: 'informational',
    metadata: 'informational',
    'disable-model-invocation': 'must differ: true on the skill (pinned above), never true on the command, because /4ge routes run/resume/park through 4ge:forge',
    'user-invocable': 'decides whether the user can type the name; a path read ignores it, and the command must stay typeable',
    hooks: 'loads only in skill mode, so a path read would drop it; the skill must not carry it',
  };
  const INERT_KEYS = ['tools', 'paths'];
  const frontmatterValue = (frontmatter, key) => {
    const match = frontmatter.match(new RegExp('^\\s*' + key + ':\\s*(.+)$', 'm'));
    return match ? match[1].trim() : null;
  };
  const frontmatterKeys = (frontmatter) => [...frontmatter.matchAll(/^([A-Za-z_-]+):/gm)].map((m) => m[1]);

  it('every loader key is either mirrored or excluded with a reason, exactly once', () => {
    const covered = [...MIRRORED, ...Object.keys(NOT_MIRRORED)];
    expect([...covered].sort()).toEqual([...LOADER_KEYS].sort());
    expect(new Set(covered).size).toBe(covered.length);
  });

  it('every frontmatter key either file carries is a loader key or a known inert key', () => {
    for (const key of [...frontmatterKeys(commandParts.frontmatter), ...frontmatterKeys(skillParts.frontmatter)]) {
      expect([...LOADER_KEYS, ...INERT_KEYS], key).toContain(key);
    }
  });

  it('command and skill carry the same value for every mirrored loader key', () => {
    for (const key of MIRRORED) {
      expect(frontmatterValue(commandParts.frontmatter, key), key).toBe(frontmatterValue(skillParts.frontmatter, key));
    }
  });

  it('command stays model-invocable and user-typeable', () => {
    expect(frontmatterValue(commandParts.frontmatter, 'disable-model-invocation')).not.toBe('true');
    expect(frontmatterValue(commandParts.frontmatter, 'user-invocable')).not.toBe('false');
  });

  it('skill carries no skill-mode-only key that a path read would drop', () => {
    expect(skillParts.frontmatter).not.toMatch(/^\s*hooks:/m);
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

describe('forge SKILL burn-gate step — installed-surface path contract', () => {
  const skill = readPluginFile('skills/forge/SKILL.md');

  // The burn gate is the one skill step that shells out to a plugin binary.
  // A repo-relative `node plugins/4ge/bin/...` path only resolves when the
  // consumer project IS this repository; from any installed-plugin cwd it
  // fails MODULE_NOT_FOUND before reading a single transcript.
  it('invokes the usage bin via CLAUDE_PLUGIN_ROOT so the gate runs from any consumer cwd', () => {
    expect(skill).toContain('node "${CLAUDE_PLUGIN_ROOT}/bin/usage.cjs" gate');
  });

  it('never references the repo-relative usage bin path', () => {
    expect(skill).not.toMatch(/node plugins\/4ge\/bin\/usage\.cjs/);
  });
});
