---
description: "Repository onboarding scanner — maps the stack, flags missing CI/test/lint config, generates a setup checklist"
argument-hint: "[path] — directory to scan, defaults to current working directory"
paths: ["**"]
---

# /onboard

Invoke the `4ge:repo-onboard` skill.

Pass `$ARGUMENTS` through as the target path. If `$ARGUMENTS` is empty, the skill scans the current working directory.

The skill produces a structured intake report (health grade A–F, missing essentials, setup checklist) written to `_runs/repo-intake-[DATE].md` and prints a summary inline.
