---
description: "Multi-teammate orchestrator. Use /forge <task>, /forge resume, or /forge park."
argument-hint: "task description, 'resume', or 'park'"
paths: ["plugins/4ge/**", ".claude/**", "lib/os/**", "_runs/**", "docs/superpowers/**"]
---

Parse $ARGUMENTS:
- If "resume": resume a parked forge session
- If "resume <date>": search parked sessions by date (YYYY-MM-DD), show matches, let user pick
- If "resume <topic>": search parked sessions by topic keyword, show matches, let user pick
- If "park": park the current forge session at phase boundary
- If "sessions" or "history": list all indexed forge sessions (most recent first)
- If "layout <name>": load a forge layout by name from `${CLAUDE_PLUGIN_ROOT}/layouts/<name>.yaml`, parse with layout-parser, validate, configure the session with that team topology
- If "layout list": list all available layouts from `${CLAUDE_PLUGIN_ROOT}/layouts/`
- If "why": post-mortem causal attribution — map changed files to teammates via scope assignments
- If empty: ask for a task description
- If the text reads as pasted session/tool output rather than an instruction to this session (e.g. it echoes a prior command's stdout, carries status/signoff/cartridge markers, or contains no imperative directed at Claude) — do not silently start a forge session. Say in one line that the input looks like pasted output, not a forge task, and fall through to normal (non-forge) handling instead.
- Otherwise: treat as the task description for a new forge session

Use `require('${CLAUDE_PLUGIN_ROOT}/lib/session-archaeology.cjs')` for session indexing and search.
Use `require('${CLAUDE_PLUGIN_ROOT}/lib/layout-parser.cjs')` for layout parsing and validation.
Use `require('${CLAUDE_PLUGIN_ROOT}/lib/causal-map.cjs')` for causal attribution.

Before producing any output, read `${CLAUDE_PLUGIN_ROOT}/skills/wizard-engine/references/output-format.md` for formatting rules.
**Output components:** 5 (Progress Line), 6 (Action Menu), 10 (Teammate Row)

> **Delivery rule (HARD):** Component 6 in conversation is a native AskUserQuestion picker — options 1:1, recommended first, nothing on the menu executes before the operator's ruling. The text Action Menu with `> _` is bin/CLI stdout only, never the interactive surface.

## Phase 4.5: Plan Gate (REQUIRED) + 6-agent Review Panel (escalated form)

Baseline ceremony, every forge session (SKILL.md Phase 3.5 + 4.5): the spec gets an adversarial DFE pass before planning; the plan gets paired DFE + GAMBIT reviews before any staging, execution, or signoff. These are REQUIRED gates — rig-sentinel `forge-packet-review-gate` fails any staged packet without recorded review artifacts. Explicit operator word is the only waiver, and it is recorded in the state file + decisions log.

The 6-agent panel below is the ESCALATED form: it REPLACES the baseline pair (and is equally mandatory) when the spec involves any of:
- `.claude/` file modifications (hooks, settings, agents, rules)
- Permission system changes (allow/deny patterns, auto-mode rules)
- Hook authoring or rewiring
- Security-critical logic (AISLE scanners, credential handling, egress control)

**Panel composition** (dispatched in parallel):
1. **Domain expert(s)** -- matched to the spec's domain via the agent-selection decision tree
2. **`audit-config`** skill on `@opus-audit` -- Claude Code configuration correctness
3. **`audit-security`** skill on `@opus-audit` -- security review
4. **`@DFE`** -- 6-pass adversarial AI code review
5. **Second-pass adversarial review** -- catches what structured passes miss
6. **`@master-auditor`** synthesizer -- cross-correlates all findings into a single verdict

**Verdict:** The synthesizer produces a GO (proceed to Phase 5) or NO-GO (fix findings first) recommendation. NO-GO findings are addressed in the plan before execution starts.

**Evidence:** Validated in prior panel runs where the panel caught A-blockers pre-execution: regex colon-format mismatch (silently no-op), `echo $VAR` bypass, `npm publish` deny collision, and duplicate allow entries. All would have silently torpedoed Phase 5.

**History note:** from `1f560d28` (2026-05-29) until the 2026-07-21 restore this section read "NOT a mandatory gate — most forge sessions skip it." That wording was the ceremony-erosion root cause (spec→DFE→plan→DFE+GAMBIT had only ever lived in practice, never as written law). Do not reintroduce optionality here.

Invoke the forge skill with the parsed arguments. Do not output any intermediate text before the skill activates.
