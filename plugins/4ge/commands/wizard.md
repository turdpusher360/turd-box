---
description: "Wizard suite launcher. Run /wizard list to see available modes, /wizard <mode> to launch a specific wizard."
argument-hint: "[list | <mode>] [flags]"
paths: ["plugins/4ge/**", ".claude/**", "_runs/**"]
---

Parse $ARGUMENTS:
- If empty or "list": set mode to `wizard` (displays available modes)
- Otherwise: first word is the mode name, remaining words are flags

Before producing any output, read `${CLAUDE_PLUGIN_ROOT}/skills/wizard-engine/references/output-format.md` for formatting rules.

Read `${CLAUDE_PLUGIN_ROOT}/skills/wizard-engine/SKILL.md` in full and follow it as the pipeline instructions, with the parsed mode and flags: in that file the `ARGUMENTS` placeholder means the mode followed by the flags. Reach the engine by this path only: the skill sets `disable-model-invocation: true`, so the Skill tool cannot start it. Its `references/` and `modes/` files sit beside it in `${CLAUDE_PLUGIN_ROOT}/skills/wizard-engine/`. Do not output any intermediate text before the first output the skill file prescribes.
