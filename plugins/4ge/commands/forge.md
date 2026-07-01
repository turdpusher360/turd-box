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

## Phase 4.5: Review Panel (OPTIONAL)

An optional 6-agent review panel that runs between Plan (Phase 4) and Execute (Phase 5). Produces a GO/NO-GO verdict before execution begins.

**Trigger criteria** -- invoke manually when the spec involves any of:
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

**This phase is NOT a mandatory gate.** Most forge sessions skip it. Use it when the cost of a silent Phase 5 failure exceeds the cost of the 6-agent review.

Invoke the forge skill with the parsed arguments. Do not output any intermediate text before the skill activates.
