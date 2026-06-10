---
description: "Run code quality audit — 70 checks across 10 domains"
argument-hint: "[quick] [full] [<domain>] or no args for interactive"
paths: ["plugins/4ge/**", ".claude/**", "_runs/**"]
---

# /audit

Parse $ARGUMENTS:

| Pattern | Action |
|---------|--------|
| `quick` | Run `npx tsc --noEmit`, `npx eslint .`, and `npx vitest run` in sequence. Display pass/fail summary per check. |
| `panel <target>` | Invoke the `audit-panel` skill with `<target>` as arguments. Tactical multi-angle parallel review — dispatches 2-4 reviewers (tier-gated) and converges into a single verdict. |
| `panel` | Invoke the `audit-panel` skill with no arguments (auto-detects from unstaged changes or last commit). |
| `full` | Spawn @master-auditor agent for comprehensive multi-domain audit. |
| `<domain>` | Spawn @master-auditor agent scoped to the specified domain (e.g., security, config, hooks). |
| (empty) | Spawn @master-auditor agent for interactive audit. |

For `quick`: Run the three verification commands via Bash sequentially. Summarize results as a table with pass/fail per check and total error count.

For `full`, `<domain>`, or interactive: Use the Agent tool to spawn `@master-auditor` with `mode: "auto"` and the appropriate scope description. The agent writes its report to `_runs/`.

Note for `full` mode: @master-auditor dispatches domain auditors in a star topology. Instruct it to spawn all domain auditors in a SINGLE Agent tool block (parallel fanout). Some runtimes default to sequential dispatch — explicit parallel instruction is required.

If @master-auditor is not available, fall back to running the `quick` checks and report: "Full audit requires @master-auditor agent. The agent ships with the 4ge plugin — try `/plugin update` or `/reload-plugins`."
