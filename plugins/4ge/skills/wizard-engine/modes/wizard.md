---
name: wizard
description: "Generic wizard mode router -- lists available modes and launches the selected one"
execution-model: interactive
pipeline-stages: []
---

# Wizard Mode Router

This mode is a pass-through. When the user invokes `/wizard <mode>`, the engine loads the named mode file directly. When invoked with no arguments or `list`, the engine lists available modes.

This file exists for completeness -- the wizard-engine SKILL.md handles the routing logic directly. If the engine routes here, simply list available modes from the `modes/` directory and prompt the user to select one.

## Behavior

1. Read all `.md` files in `modes/` directory (excluding this file)
2. Extract `name` and `description` from YAML frontmatter
3. Display available modes:

```
=== WIZARD SUITES ===

Available modes:

  outhouse   9-category repository health scan with interactive fix menu
  fix        Issue collector -- capture issues for the next maintenance run

Future modes (not yet implemented):
  hook       Generate a Claude Code hook from interview
  agent      Generate an agent definition from interview
  skill      Generate a skill with references from interview

Launch: /wizard <mode> [flags]
```

Direct mode dispatch (e.g., `/wizard outhouse`) is handled by the wizard-engine SKILL.md routing logic -- this file does not need to re-invoke the engine.
