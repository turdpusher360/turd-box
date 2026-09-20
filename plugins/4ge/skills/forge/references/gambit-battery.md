# GAMBIT Coverage Battery

The house breadth/coverage/traceability audit — the historical PAIR to DFE (cross-repo lineage: per-target `gambit.md` + `dfe.md`, run together, twice, on 9 targets). DFE tries to BREAK the artifact adversarially; GAMBIT proves NOTHING IS MISSING. A packet passes review only when both have run. The name and battery were practice-borne (never previously written down as a skill surface) — this reference exists so the pattern survives doctrine diets (restored 2026-07-21; erosion root cause was `1f560d28` documenting review as optional).

## Routing

- Agent: `opus-audit` (write-to-disk audit agent), `mode: "bypassPermissions"`.
- Model: Opus default (judgment). Sonnet is acceptable ONLY for pure-breadth enumeration sweeps (per agent-selection: "coverage/gambit audits" are Sonnet-class when volume dominates judgment) — packet gates default Opus.
- Authority frame (always include): operator locks are RATIFIED — GAMBIT audits coverage, not direction.

## The battery (full matrix, no sampling)

1. **Locks → spec → plan → proof:** every operator lock/ruling maps to the spec section encoding it, the plan task(s) implementing it, and the acceptance/proof step verifying it. Flag any lock that dead-ends at any hop.
2. **Defects → fix task + tests → proof:** every known defect (P1s, adjudicated findings) has a fix task, a test, and a proof step. Include the do-NOT-fix guards (things adjudicated as working).
3. **Security constraints → binding mechanism:** every constraint in the spec has an enforcing mechanism or explicit gate in the plan — prose promises don't count.
4. **Acceptance → proof:** every acceptance item has a concrete final-wave proof step.
5. **Reverse pass:** every plan task traces BACK to a spec requirement. Orphan tasks = scope creep; uncovered spec items = gaps. Both are findings.
6. **Ops reality:** concurrency caps, burn gate, platform pitfalls (reserved basenames, worktree-isolation reliability, repo/branch boundaries), and repo-custody rules are respected by the plan as written.

## Output contract

- Disk-first: `_runs/<date>/<slug>-packet-review/gambit.md` (non-reserved basename).
- Verdict: `COVERED` or `GAPS(n)`, then the compact matrix table, then numbered gaps/orphans with exact location + minimal fix.
- Memory protocol: `memory_search` before, `memory_store` verdict after (project scope).
