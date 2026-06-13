---
description: "Contextual design assistant — auto-detects design mode (Visual/API/Data/System) and assembles the right toolkit"
argument-hint: "[visual|api|data|system] or describe what you're designing"
paths: ["plugins/4ge/**", "lib/**", ".4ge/**"]
---

# /design

Invoke the `4ge:design-suite` skill.

Pass `$ARGUMENTS` through as the skill argument. If `$ARGUMENTS` is empty, the skill will auto-detect the design context from recent conversation files.
