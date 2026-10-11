---
description: "Inline issue collector. Capture maintenance issues without interrupting workflow. Issues appear in the next /outhouse run."
argument-hint: "<description>"
paths: ["plugins/4ge/**"]
---

Parse $ARGUMENTS as the issue description. If empty, show usage: `/fix <description of the issue>`.

Before producing any output, read `${CLAUDE_PLUGIN_ROOT}/skills/wizard-engine/references/output-format.md` for formatting rules.
**Primary output component:** 7 (Confirmation Card)

Read `${CLAUDE_PLUGIN_ROOT}/skills/wizard-engine/SKILL.md` in full and follow it as the pipeline instructions, with mode=fix and the issue description from $ARGUMENTS: in that file the `ARGUMENTS` placeholder means `fix` followed by that description. Reach the engine by this path only: the skill sets `disable-model-invocation: true`, so the Skill tool cannot start it. Its `references/` and `modes/` files sit beside it in `${CLAUDE_PLUGIN_ROOT}/skills/wizard-engine/`. Do not output any intermediate text before the first output the skill file prescribes.
