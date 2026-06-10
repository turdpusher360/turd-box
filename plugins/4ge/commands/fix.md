---
description: "Inline issue collector. Capture maintenance issues without interrupting workflow. Issues appear in the next /outhouse run."
argument-hint: "<description>"
paths: ["plugins/4ge/**"]
---

Parse $ARGUMENTS as the issue description. If empty, show usage: `/fix <description of the issue>`.

Before producing any output, read `${CLAUDE_PLUGIN_ROOT}/skills/wizard-engine/references/output-format.md` for formatting rules.
**Primary output component:** 7 (Confirmation Card)

Invoke the wizard-engine skill with mode=fix and issue description from $ARGUMENTS. Do not output any intermediate text before the skill activates.
