---
description: "Wizard suite launcher. Run /wizard list to see available modes, /wizard <mode> to launch a specific wizard."
argument-hint: "[list | <mode>] [flags]"
paths: ["plugins/4ge/**", ".claude/**", "_runs/**"]
---

Parse $ARGUMENTS:
- If empty or "list": set mode to `wizard` (displays available modes)
- Otherwise: first word is the mode name, remaining words are flags

Before producing any output, read `${CLAUDE_PLUGIN_ROOT}/skills/wizard-engine/references/output-format.md` for formatting rules.

Invoke the wizard-engine skill with the parsed mode and flags. Do not output any intermediate text before the skill activates.
