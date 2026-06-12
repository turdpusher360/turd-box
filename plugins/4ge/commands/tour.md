---
description: "5-step guided walkthrough of the highest-value /4ge commands. Use this when a user is new to 4ge, asks 'where do I start', or wants to see what the plugin can do. Trigger phrases: 'tour', 'getting started', 'show me how to use 4ge', 'what should I try first'."
argument-hint: "[--step N] (jump to step N, 1-5)"
paths: ["plugins/4ge/**"]
---

# /tour

A 5-step walkthrough of the highest-value 4ge commands. Each step builds on the last — from reconnaissance to building to reviewing to shipping. Covers the full loop in under 10 minutes.

Parse `$ARGUMENTS`:

| Pattern | Action |
|---------|--------|
| (empty) | Run all 5 steps in sequence |
| `--step 1` through `--step 5` | Jump directly to that step |
| `--step <N>` where N is out of range | Report: "Tour has 5 steps (1-5). Run `/tour` with no arguments to start from step 1." |

---

## Tour Steps

Display the following walkthrough. Use the `--step N` argument to start from a specific step if provided — print only that step and the "What's next" prompt below it.

---

```
/4ge Tour — 5 Steps from Installed to Shipping
════════════════════════════════════════════════

Step 1/5 — Know your terrain
  Run:  /4ge:recon --map
  Shows your repo organized by semantic category — what's where,
  what depends on what. The first thing to run in any new codebase.

  Then: /4ge:recall <topic>
  Searches persistent memory across sessions. Your past decisions,
  architecture notes, and debugging context — all retrievable.
  Example: /4ge:recall auth middleware refactor

Step 2/5 — Build with agents
  Run:  /4ge:forge <task description>
  The 7-phase orchestrator: scope, brainstorm, spec, plan, execute,
  integrate, ship. Dispatches specialized agents in parallel; model
  choice inherits the active runtime unless you explicitly override it.
  Example: /4ge:forge add rate limiting to the API

  Also try: /4ge:debug <symptom>
  Guided root-cause analysis with memory search, causal mapping,
  and fix verification. Not a debugger — a debugging process.

Step 3/5 — Review before anyone else sees it
  Run:  /4ge:dfe --staged
  Six-pass adversarial review: 5 domain passes (existence, security,
  logic, runtime, artifacts) + 1 adversarial pass that actively tries to
  break what the first five approved. Catches hallucinated APIs,
  logic errors, and dead code before the PR.

  Run:  /4ge:audit quick
  70 checks across 10 domains in one command. Or /4ge:audit
  for the interactive wizard that lets you pick your focus.

Step 4/5 — Ship it
  Run:  /4ge:commit
  Runs tsc + eslint + vitest, then commits with an auto-generated
  message derived from the diff. No manual message writing.

  Run:  /4ge:ship
  Same pre-flight checks, plus push. Or /4ge:pr to also open
  a pull request with a generated title and description.

Step 5/5 — See what's running
  Run:  /4ge:hud on
  Live OS dashboard in the statusline — capability health,
  boot timing, context budget, active forge session, companion
  state. Stays updated as you work.

  Run:  /4ge:help
  Full command index grouped by tier. 37 commands, 40 skills,
  9 OS capabilities. Try /4ge:help <command> for any command's
  full spec.

════════════════════════════════════════════════
Tour complete.

Daily drivers: /forge, /ship, /dfe, /debug, /recall, /hud
Full index:    /4ge:help
```

---

## Step-Specific Output (--step N)

When `--step N` is provided, display only the requested step's block plus this footer:

```
(Step N/5 complete)
Run /4ge:tour --step <N+1> to continue, or /4ge:tour to restart from step 1.
```

If `--step 5` is requested, use this footer instead:

```
(Step 5/5 — tour complete)
Daily drivers: /forge, /ship, /dfe, /debug, /recall, /hud
Run /4ge:help to explore the full command index.
```

---

## Notes

- All Free-tier commands shown (`/4ge:recon`, `/4ge:recall`, `/4ge:hud`, `/4ge:help`, `/4ge:debug`) work immediately after `claude plugin install 4ge@turd-box`.
- `/4ge:recon` is the unified discovery command — it absorbs the older `/map` and `/recall` commands. Use `--map` for the repo dependency map, pass a query for memory search, or `--budget` for the current context budget. Both `/map` and `/recall` still resolve as redirects but the canonical form is `/4ge:recon`.
- `/4ge:recall` (memory search) requires a running dev-memory hub (local Docker, or the hosted hub on the Team tier). If memory is unavailable, it reports what's missing gracefully — no crash.
- `/4ge:forge`, `/4ge:dfe`, and `/4ge:audit` require Pro tier. Free users see an upgrade prompt with the cost and upgrade URL. (`/ship`, `/commit`, and `/pr` are now free — the delivery loop runs on every tier.)
- The `--step N` flag exists for chaining: the first-run onboarding flow uses `--step 1` to begin the tour immediately after setup.
