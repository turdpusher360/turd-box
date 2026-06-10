---
description: "Docker container health monitoring. Use: /infra or /infra check to see container health, /infra heal <container> to restart a container"
argument-hint: "'check', 'heal <container>', or empty for health check"
paths: ["plugins/4ge/**", "lib/os/**"]
---

Before producing any output, read `${CLAUDE_PLUGIN_ROOT}/skills/wizard-engine/references/output-format.md` for formatting rules.

**Output components:** 8 (Status Table)

Run the infra capability check. If a specific action is requested, route accordingly:

- No args or "check": `os.invoke('infra', 'check')`
- "heal <container>": `os.invoke('infra', 'heal', { container: '<name>' })`

Present results as a table:

| Container | Stack | Status | Docker State | Health |
|-----------|-------|--------|-------------|--------|

Highlight any non-healthy containers and suggest `/infra heal <name>` for degraded/down ones.

If `_runs/os/boot-status.json` does not exist, report: "Agentic OS not booted. Requires `lib/os/` modules and the `os-boot.cjs` SessionStart hook. Run `/blueprint setup` to install, or check that the OS hook is wired in settings.json."
