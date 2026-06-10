# Context Lifecycle

The governing principle for context management in forge sessions. Context is a finite, valuable resource — the lifecycle model determines when to preserve it and when to shed it.

## Context-Aware Handoff Model

Not all work is equal. The nature of the current phase determines when to hand off:

### High-Context Work (let it ride)

Momentum matters. Shedding context here forces expensive re-reads:

- **Implementation (Phase 5):** editing files, running tests, fixing errors
- **Integration (Phase 6):** applying diffs, resolving conflicts — need full picture
- **Debugging loops:** systematic-debugging, error -> hypothesis -> fix -> verify

### Low-Context Work (hand off early, shed aggressively)

Artifacts live on disk. Context is disposable after the artifact is written:

- **Scoping (Phase 1):** decisions go to spec
- **Brainstorming (Phase 2):** decisions go to spec
- **Spec writing (Phase 3):** spec lives on disk
- **Planning (Phase 4):** plan lives on disk
- **Shipping (Phase 7):** update TASKING.md, memory, HANDOFF.md

### The Heuristic

> "Does the next action depend on something I'm holding in context, or on something I can read from disk?"
> If disk -> hand off. If in-flight -> let it ride.

## Phase-Specific Context Budgets

"Entry budget" = forge-specific context loaded when entering the phase. Does not include codebase context from reads.

| Phase | Mode | Entry Budget | Handoff Behavior |
|-------|------|-------------|-----------------|
| 1 (scope) | Low-context | <10K tokens | Compact after; decisions go to spec |
| 2 (brainstorm) | Low-context | <15K tokens | Compact after; design goes to spec |
| 3 (spec) | Low-context | <20K tokens | Compact after; spec is on disk |
| 4 (plan) | Low-context | <15K tokens | Compact after; plan is on disk |
| 5 (execute) | **High-context** | <50K tokens | Let it ride until teammates done |
| 6 (integrate) | High-context | <30K tokens | Let it ride through verification |
| 7 (ship) | Low-context | <10K tokens | Triple-write: TASKING + memory + HANDOFF |

## Intra-Session Handoff

At each phase boundary (low-context phases only), forge:

1. Evaluates current context usage
2. If >50% used: create phase checkpoint, suggest `/compact` with structured summary
3. Compact summary preserves: current phase, task status, key decisions, next action
4. Discards: file contents from previous phases, teammate transcripts, research details

**Important:** `/compact` cannot be triggered programmatically. Forge outputs a suggestion; the user decides.

### Compact Summary Format

```
Forge session '{slug}', Phase {N} complete.
Key decisions: {list}.
Next: Phase {N+1}.
State: _runs/{date}/forge-state-{slug}.json
Spec: {spec_path}
Plan: {plan_path}
```

## Triple-Write on Every Handoff

Whether intra-session (compact) or cross-session (park), every handoff writes to 3 persistence layers:

1. **TASKING.md** — current forge progress (human-readable)
2. **memory_store** — session summary with key decisions (searchable across sessions)
3. **HANDOFF.md** — context for the next session (machine-readable quick start)

This ensures any future session (or human) can reconstruct forge state regardless of which persistence layer they check first.
