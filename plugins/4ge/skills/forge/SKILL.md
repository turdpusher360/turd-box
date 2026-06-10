---
name: forge
description: "Multi-teammate orchestrator — 7 phases: scope, brainstorm, spec, plan, execute, integrate, ship"
argument-hint: "task description, 'resume', or 'park'"
tools: Agent, Bash, Read, Write, Edit, Glob, Grep, Skill, SendMessage, TaskCreate, TaskUpdate, TaskList
effort: high
paths: ["plugins/4ge/**", ".claude/**", "lib/os/**", "_runs/**", "docs/superpowers/**"]
disable-model-invocation: true
---

# /forge — Multi-Teammate Orchestrator

Before producing any output, read `${CLAUDE_PLUGIN_ROOT}/skills/wizard-engine/references/output-format.md` for formatting rules.

**Output components:** 5 (Progress Line), 6 (Action Menu), 10 (Teammate Row)

Orchestrates complex implementation tasks through 7 phases using parallel teammates, dependency-aware scheduling, and context-aware handoff.

**Reference files live in `references/` (relative to this skill file).** Read each file on demand when its protocol is needed — do not preload all references at once.

## Parse $ARGUMENTS

- If `$ARGUMENTS` is "resume" or "park": handle per `references/session-state.md`
- If `$ARGUMENTS` matches "resume <date>" (YYYY-MM-DD): search parked sessions by date. Show matches, let user pick one to resume. Load session state from `${CLAUDE_PLUGIN_DATA}/forge/forge-state-*.json`
- If `$ARGUMENTS` matches "resume <topic>": search parked sessions by topic keyword. Show matches, let user pick
- If `$ARGUMENTS` is "sessions" or "history": list all indexed forge sessions (most recent first). Use `require('${CLAUDE_PLUGIN_ROOT}/lib/session-archaeology.cjs')` for indexing and search
- If `$ARGUMENTS` is empty: render the Guided Forge Hub menu (see "Empty Args: Guided Forge Hub" at the bottom of this file) — do not start a session blindly
- Otherwise: treat as task description and begin Phase 1

## Pre-Flight

Before starting any phase:

1. Check for stale `.forge-session.json` (crash recovery — read `references/session-state.md`)
2. Check for parked state files in `${CLAUDE_PLUGIN_DATA}/forge/` then `_runs/` (read `references/session-state.md`)
3. `memory_search` for prior forge sessions on this topic

## Phase 1: Scope

**Context mode:** Low-context (budget <10K tokens). Decisions go to spec.

Evaluate the task description:
- Is it clear enough to proceed? -> Phase 2
- Is it ambiguous or needs exploration? -> Invoke `/autoresearch <topic>` first (if available), or research manually using web search and codebase exploration, then Phase 2
- Is it too large? -> Suggest breaking into sub-projects

For scope gate logic, read `references/phase-scoping.md`.

## Phase 2-3: Brainstorm + Spec

**Context mode:** Low-context (budget <15K tokens). Design goes to spec.

### Phase 2 pre-step: structured clarifying round (FOREGROUND - lead only)

Run this in the lead context BEFORE dispatching forge-brainstorm. `AskUserQuestion`
is in `ALL_AGENT_DISALLOWED_TOOLS` and is retained here only because this skill
executes in the lead's main thread; it will not work inside the forge-brainstorm
subagent. Gathering fork decisions here avoids the brainstorm-agent Q&A
round-trip failure where a subagent cannot prompt the user.

If the task has genuine open decisions the model cannot resolve from Phase 1
scope or from the codebase, ask them with one `AskUserQuestion` call. Batch up
to 4 questions. Never ask anything derivable from the codebase, git history, or
memory — ask only forks that change the spec:

- **Scope boundary** — which surfaces are in vs. out for this session
- **Approach fork** — two or more viable designs with different trade-offs
- **Risk posture** — whether gated surfaces (`.claude/`, permissions, hooks) are in play
- **Acceptance** — what proof counts as done, when that is ambiguous

Each question gets a short `header` and 2-4 mutually exclusive options, with the
recommended option first and "(Recommended)" in its label. Labels name the
concrete choice; descriptions state its trade-off in one line. Never "option A/B".

```
AskUserQuestion(questions: [
  {
    question: "Where should the new trigger logic live?",
    header: "Approach",
    multiSelect: false,
    options: [
      { label: "Extend hook-utils.cjs (Recommended)", description: "One shared code path, but touches a file every hook depends on" },
      { label: "New standalone hook", description: "Zero blast radius, but duplicates stdin parsing" }
    ]
  }
])
```

Capture the selected answers verbatim and pass them into the dispatch prompt
below as `Clarifying answers:`. The subagent receives DECISIONS, not questions.

**Preferred (phase delegation):** Dispatch the forge-brainstorm agent, which has the brainstorming skill injected. This keeps ~3,500 tokens of skill content out of the lead's context.

```
Agent(
  subagent_type: "forge-brainstorm",
  prompt: "Task: <task description>\nScope decisions: <from Phase 1>\nClarifying answers: <structured answers from AskUserQuestion, or 'none needed'>\nDate: YYYY-MM-DD",
  name: "brainstorm-phase"
)
```

The agent handles both brainstorming (Phase 2) and spec writing (Phase 3). It returns:
- Spec file path (written to `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`)
- Key design decisions
- Any concerns

If the agent returns status `NEEDS_CONTEXT` with follow-up questions, run another
foreground `AskUserQuestion` round in the lead, then re-dispatch with the new
answers appended. The subagent never prompts the user directly.

**Fallback (forge-brainstorm not available):** Invoke `/superpowers:brainstorming` inline, then write spec to `docs/superpowers/specs/`.

**Inline fallback (no superpowers):** Run inline brainstorming in the lead:
1. Ask clarifying questions with `AskUserQuestion` when needed. Use one call with up to 4 questions, each with a short `header`, 2-4 options, and the recommended option first with "(Recommended)" in the label. Do not add an "Other" option; the harness supplies it automatically.
2. Propose 2-3 approaches with trade-offs and a recommendation
3. Present design sections, get approval after each
4. Write spec to `docs/superpowers/specs/YYYY-MM-DD-<feature-name>.md`

After Phase 2-3, suggest `/compact` if >50% context used.

## Phase 4: Plan

**Context mode:** Low-context (budget <15K tokens). Plan lives on disk.

**Preferred (phase delegation):** Dispatch the forge-planner agent, which has the writing-plans skill injected. This keeps ~3,200 tokens of skill content out of the lead's context.

```
Agent(
  subagent_type: "forge-planner",
  prompt: "Spec path: <path from Phase 2-3>\nSession slug: <slug>\nDate: YYYY-MM-DD",
  name: "plan-phase"
)
```

The agent returns:
- Plan file path (written to `docs/superpowers/plans/YYYY-MM-DD-<topic>.md`)
- Task count and DAG structure
- Estimated complexity

**Fallback (forge-planner not available):** Invoke `/superpowers:writing-plans` inline.

**Inline fallback (no superpowers):** Write the plan directly:
1. Read `references/plan-template.md` for the format
2. Break approved spec into discrete tasks with `depends_on` fields
3. Assign agent types and file scopes per task
4. Present plan for approval

Plans use the `depends_on` field format defined in `references/plan-template.md`.
Each task declares file scope and dependencies per `references/dag-format.md`.

After plan approval, suggest `/compact` if >50% context used.

## Phase 5: Execute

**Context mode:** HIGH-context (budget <50K tokens). Let it ride until teammates done.

1. Parse plan for DAG structure (read `references/dag-format.md` for schema)
2. Write `.forge-session.json` to project root (see below)
3. Topo-sort tasks; launch tasks with satisfied dependencies in parallel
4. Dispatch teammates using templates from `references/teammate-templates.md`
5. Inject context budget rules from `references/context-budget.md` into teammate prompts
6. Monitor via heartbeat (forge-heartbeat.cjs hook — automatic)
7. Handle BLOCKED teammates per `references/integration-protocol.md` auto-retry rules
8. Teammates report status: DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT

**Max parallel teammates:** 4 (configurable per plan).

**Teammate dispatch pattern (subagents):**
```
Agent(
  subagent_type: "<agent-name>",
  prompt: "<filled template from teammate-templates.md>",
  isolation: "worktree",
  run_in_background: true,
  name: "<teammate-name>"
)
```

Do not pass `model` in routine teammate dispatches. Agent frontmatter uses
`model: inherit`, so the runtime/current session controls model choice unless
the operator explicitly asks for a spawn-time override.

**Peer communication:** For subagent-based dispatch, teammates write interface change notifications to `_runs/{date}/forge-changes-{teammate}.md`, and the lead checks these between dispatches. SendMessage is available when using Agent Teams (TeamCreate) instead.

### Session File

When Phase 5 starts, write `.forge-session.json` to the project root:

```json
{
  "slug": "feature-name",
  "started": "2026-03-15T12:00:00Z",
  "phase": "execute",
  "plan_path": "docs/superpowers/plans/YYYY-MM-DD-feature.md",
  "teammates": [
    {
      "name": "impl-foundation",
      "agent": "sonnet-execute",
      "scope": ["src/components/**"],
      "status": "active",
      "started": "2026-03-15T12:01:00Z"
    }
  ]
}
```

Lifecycle: created at Phase 5 start, updated on teammate spawn/completion, deleted at Phase 7 / park / cancel. Added to `.gitignore`.

### Live Progress (HUD forge-progress zone)

In lockstep with the `.forge-session.json` lifecycle, drive the HUD forge-progress
zone by writing `_runs/os/forge-progress.json` through the dedicated writer
(`plugins/4ge/lib/forge-progress-writer.cjs`). The HUD consumer
(`hud-zone-forge-progress.cjs`) only renders the zone when this file has a
non-empty `waves` array, so without these calls the zone stays hidden.

Run these shell one-liners at each boundary (path is relative to the plugin root;
use the absolute plugin path if cwd differs):

1. **Phase 5 start** — seed the session and one queued wave per DAG layer:
   ```bash
   node plugins/4ge/lib/forge-progress-writer.cjs start \
     '{"session":"<slug>","task":"<task desc>","waves":[{"id":"1","label":"<layer 1>","status":"queued","packages":["<scope>"]},{"id":"2","label":"<layer 2>","status":"queued","packages":[]}]}'
   ```
2. **Wave begins** (its teammates dispatched) — flip the wave to running:
   ```bash
   node plugins/4ge/lib/forge-progress-writer.cjs update '{"id":"1","status":"running"}'
   ```
3. **Teammate spawn / completion** — upsert the agent by name:
   ```bash
   node plugins/4ge/lib/forge-progress-writer.cjs agent '{"waveId":"1","name":"<teammate>","type":"<agent>","status":"running"}'
   # on DONE/BLOCKED:
   node plugins/4ge/lib/forge-progress-writer.cjs agent '{"waveId":"1","name":"<teammate>","status":"done"}'
   ```
4. **Wave complete + integrated** — ship it and record commit count:
   ```bash
   node plugins/4ge/lib/forge-progress-writer.cjs update '{"id":"1","status":"shipped","commits":<n>}'
   ```
5. **Phase 7 / park / cancel** — clear the file (mirror `.forge-session.json` deletion):
   ```bash
   node plugins/4ge/lib/forge-progress-writer.cjs clear
   ```

Totals (shipped/packages/running/queued) are derived automatically on every write —
never set them by hand. Writes are atomic and best-effort; a failed call never blocks
the forge run.

## Phase 6: Integrate

**Context mode:** High-context (budget <30K tokens). Let it ride through verification.

Read `references/integration-protocol.md` for the full procedure:
1. Create git tag checkpoint
2. Apply teammate results sequentially (not all at once)
3. Type-check after each application
4. Full verification after all applied: `npx tsc --noEmit && npx eslint . && npx vitest run`

## Phase 7: Ship

**Context mode:** Low-context (budget <10K tokens).

**Preferred (phase delegation):** Dispatch the forge-shipper agent, which has verification and finishing skills injected. This keeps ~7,100 tokens of skill content out of the lead's context.

```
Agent(
  subagent_type: "forge-shipper",
  prompt: "Plan path: <path>\nIntegration status: <from Phase 6>\nSession summary: <key changes>",
  name: "ship-phase"
)
```

The agent handles verification, triple-write handoff, and cleanup. It returns:
- Verification results (tsc/eslint/vitest pass/fail)
- Ship recommendation
- Triple-write confirmation

**Fallback (forge-shipper not available):**

1. Run full verification suite
   **Fallback (superpowers not installed):** If `/superpowers:verification-before-completion` is not available, run verification directly:
   - `npx tsc --noEmit` — zero errors
   - `npx eslint .` — passes
   - `npx vitest run` — all tests green
2. Dispatch review (read `references/review-protocol.md`)
3. Triple-write handoff (read `references/context-lifecycle.md` section on triple-write):
   - Update TASKING.md with forge results
   - `memory_store` session summary with key decisions
   - Update HANDOFF.md with next steps
4. Clean up `.forge-session.json` and heartbeat files, and clear the HUD progress file (`node plugins/4ge/lib/forge-progress-writer.cjs clear`)
5. Delete checkpoint tag (if integration succeeded)
6. Offer: commit, PR, or additional review

## Cost Tracking

During Phase 5 (execution), track per-teammate metrics:

| Metric | Source |
|--------|--------|
| Tool use count | Count Agent tool calls per teammate |
| Estimated tokens | Sum of tool result sizes (rough proxy) |
| Wall-clock duration | Teammate spawn time to completion |

Report in the Phase 7 handoff:

```
## Token Usage (estimated)
| Teammate | Tools | Est. Tokens | Duration |
|----------|-------|-------------|----------|
| impl-1   | 47    | ~85K        | 12m      |
| review-1 | 23    | ~40K        | 6m       |
```

## Performance History

After each forge session completes (Phase 7), store a performance summary:

```
memory_store content="Forge session {slug}: {N} tasks, {M} teammates.
Agent performance: sonnet-execute (3 tasks, 2 DONE, 1 BLOCKED on type error).
sonnet-research (1 task, DONE, 8 searches).
Total duration: {duration} minutes."
tags=["forge", "performance", "agent-metrics"]
importance=0.6
```

Over time, this builds a performance profile per agent type. Use `memory_search query="forge performance" limit=5` to recall past session metrics and inform team composition decisions.

## Cancellation

At any point, user can cancel. Read `references/cancellation-protocol.md`:
- Graceful: wait for in-progress teammates, collect partial results, triple-write
- Abort: kill teammates immediately, triple-write with partial state
- Always clean up `.forge-session.json` and runtime files, and clear the HUD progress file (`node plugins/4ge/lib/forge-progress-writer.cjs clear`)

## Context Lifecycle

Read `references/context-lifecycle.md` for:
- Phase-specific context budgets
- High-context vs low-context work classification
- Intra-session handoff (suggest `/compact`) protocol
- Triple-write on every handoff point

**Important:** `/compact` cannot be triggered programmatically. At phase boundaries, output a suggestion: "Context is at ~X%. Suggest running `/compact` before Phase N+1." The user decides.

## Park / Resume

Read `references/session-state.md` for:
- `/forge park` — persist state at phase boundary
- `/forge resume` — restore from parked state
- Crash recovery — detect stale session files

## Known Limitations

Documented via research:

1. **`@references/` imports don't work in skill files.** Only supported in CLAUDE.md and `.claude/rules/`. This skill uses explicit "read `references/X.md`" directives instead.
2. **`/compact` cannot be triggered programmatically.** Skill suggests compaction; user executes.
3. **SendMessage requires Agent Teams** (TeamCreate), not subagents (Agent tool). Subagents dispatched via `Agent(isolation: "worktree")` cannot use SendMessage. Peer communication falls back to file-based coordination.
4. **SendMessage to completed agents is silently lost** (GitHub Issue #25135). Parameter is `recipient:`, not `to:`. Lead cannot see peer-to-peer messages — only messages addressed to `"team-lead"`.
5. **Agent Teams worktree isolation had bugs** (Issue #28175 fixed, Issue #27749 open). Subagent worktrees are more reliable.
6. **Hooks are separate processes** — no in-memory state across invocations. Heartbeat uses file-based counter.
7. **`skills:` frontmatter accepts skill names only**, not file paths. Cannot use `skills: ["forge/references/X.md"]` for knowledge injection.

## Empty Args: Guided Forge Hub

When `$ARGUMENTS` is empty, do not start a session blindly. Forge is the make-and-analyze hub: render a cheap status strip, then use `AskUserQuestion` as the native menu shell. The menu is a router into existing capabilities — it adds discoverability, not a new implementation path. Menu navigation is native (≈0 model tokens); the model is spent only on the leaf the operator selects.

### HUD strip

Render one deterministic line before the menu. Do not summarize or reinterpret it.

1. If `_runs/os/boot-status.json` exists, read `_runs/os/boot-status.json` and `_runs/os/health.json`, merge them into `{ ...bootStatus, health: healthJson }`, then pipe the JSON to:

```bash
node plugins/4ge/bin/hud-engine.cjs --mode=strip
```

2. If the OS files are missing, print `Forge OS: not booted` and continue to the menu.

### Menu round 1

Call `AskUserQuestion` with one question:

```text
question: "What should Forge do?"
header: "Forge"
options:
- Build a feature (Recommended): start the 7-phase pipeline. Ask for the task
  description, then begin Phase 1 (scope).
- Review or audit: code/security audit, DFE adversarial review, or architecture plan.
- Debug or research: investigate a failure, search memory, or run autoresearch.
- Manage sessions: resume, park, list, or post-mortem a forge session.
```

### Menu round 2a (only if "Review or audit")

```text
question: "Which review?"
header: "Review"
options:
- Full audit (Recommended): route to /audit.
- DFE adversarial review: route to /dfe.
- Architecture plan: invoke the plan-architecture skill.
- Multi-angle panel: route to /audit-panel.
```

### Menu round 2b (only if "Debug or research")

```text
question: "Debug or research?"
header: "Investigate"
options:
- Debug an issue (Recommended): route to /debug.
- Memory recall: route to /recall.
- Autoresearch: route to /autoresearch.
- Knowledge search: route to /recall.
```

### Menu round 2c (only if "Manage sessions")

```text
question: "Session action?"
header: "Session"
options:
- Resume a parked session (Recommended): handle per references/session-state.md.
- Park the current session: persist state at the phase boundary.
- List sessions: show indexed forge sessions, most recent first.
- Why (post-mortem): causal attribution of changed files to teammates.
```

After a selection, dispatch exactly as if the operator had typed the direct command/skill. For "Build a feature", proceed with the normal Phase 1 flow above. Do not ask extra confirmation when the selected action is unambiguous.
