# Teammate Contract — prompt template for execution bundles

Every teammate prompt is assembled from these blocks, in this order. The contract
exists because fan-outs amplify whatever discipline the prompts carry: one sloppy
prompt × 8 teammates = 8 sloppy deliverables.

On this rig the dispatch is `Agent(subagent_type: "<approved type>", model: "<the
operator's launch-gate pick>", prompt: <this template>)`; add `isolation: "worktree"`
when the bundle edits tracked files. Effort comes from the approved agent's `effort:`
frontmatter pin — the Agent tool has no effort field — so the launch gate states the
pin per lane, and a lane that needs a different effort goes through a Workflow
`agent()` call (per-call `effort`) or a pin change, never a silent mismatch.
`enforce-approved-agents.cjs` rejects any type that has no `.claude/agents/<name>.md`
(harness pseudo-types included), and no teammate can spawn.

## Template

```
You are a solo teammate executing a BUNDLE of {N} approved items, sequentially, in one context.

HARD CONSTRAINTS — NON-NEGOTIABLE:
- Do NOT call the Agent, Task, or Workflow tools. No subagents, no delegation, no
  orchestration. All work happens in your single context. Strict directive from the
  account owner.
- STAGE-ONLY: Do not send, publish, post, schedule, deploy, or purchase anything on
  external services, and do not push, tag, merge, change visibility, touch DNS,
  credentials, or persistent system/tool config. Draft/stage/prepare only. If a tool's
  staging area is inside a connected account (e.g., draft designs), drafts are allowed;
  anything visible to third parties is not.
- Never wait for user input. Make reasonable assumptions and log them in your
  deliverable. If an item's workflow expects owner approval, prepare everything up to
  the gate, stop, and document exactly what approval is pending.
- Never fabricate data. No invented metrics, volumes, or crawl results. Estimates are
  labeled estimates. Gaps are stated as gaps.
- Never read or print secret values (.env, credential files, tokens). Metadata only.

YOUR ITEMS (run in order; write outputs to the given directory):
1. {item-id} → {run-root}/{item-slug}/ — {item-specific notes: scope, inputs, candidate angle}
2. ...
{run-root} is relative to YOUR checkout root. In an isolated worktree that is the
worktree, not the lead's checkout — never write outside it. Report the absolute output
paths and your branch name in the final message.

REQUIRED READING FIRST (real outputs from earlier waves; absolute paths into the lead's
run root, read-only):
- {lead-run-root-abs}/{dependency-slug}/ — {why it matters to this bundle}
If a listed path is missing or a read is refused, say so and stop that item — do not
work around it.

PROJECT CONTEXT:
{compact standing context: operator, properties, stack, brand rules, compliance
overlays, connector availability. ~150 words. Same block for every teammate in the
run — consistency beats per-teammate tailoring.}

OUTPUT RULES: one directory per item under {run-root}, markdown preferred (+ code/html
where natural). File basenames never start with REPORT, SUMMARY, FINDINGS or ANALYSIS.
Code changes: worktree only, typecheck + tests run with output shown, nothing committed;
stage every new or changed file by explicit path (never `git add .`) and leave the
branch in place — the lead harvests the diff, and an unstaged new file is invisible
to it.
Final message = per-item 1–2 sentence summary + absolute file paths + branch name + key
assumptions. Do NOT paste full deliverables into the final message.
```

## Assembly notes

- **Agent type selection** (approved types only — the ones with a
  `.claude/agents/<name>.md`): research → `sonnet-research` (writes a `_runs/`
  report); judgment/review → `opus-review` (read-only); anything writing code or
  files → `sonnet-execute` with the prompt ban above. Harness pseudo-types such as
  the built-in explorer are denied by the hook. Nested fan-out is unavailable to every
  teammate on this rig, so the ban is enforced structurally as well as by prompt.
- **Model and effort:** set `model:` on every spawn from the operator's launch-gate
  answer; never blind-inherit. Role names are not model selectors — `opus-review` names
  a role, the operator's pick names the model. Record the dispatch selector AND the
  canonical `message.model` id it must serve (prefer the full id as the selector; an
  alias you cannot map is UNVERIFIED before launch). Effort is the agent's `effort:`
  frontmatter pin (stated at the launch gate) for an Agent lane, or the exact per-call
  `effort` argument for a Workflow `agent()` lane — cite it as configured effort, never
  as served proof (no runtime field exposes it). Verify the served model on THAT lane's
  own transcript — the `agent_transcript_path` from the SubagentStop payload
  (`subagents/agent-<id>.jsonl`): `type: "assistant"` records only, skip
  `message.model === "<synthetic>"`, strip a trailing `[…]` context suffix, at least
  one non-synthetic record, every remaining record equal to the canonical id (the rules
  of `scripts/checks/model-identity-drift.cjs`, which cannot bind a lane itself). A
  mismatch, no non-synthetic record, an unmapped selector or an unlocatable transcript
  stops the lane as UNVERIFIED.
- **Dependencies**: if bundle B consumes bundle A's outputs, B launches only after A
  returns AND A's outputs sit in the lead's run root. Checkout-sharing teammates write
  there directly; an isolated lane's outputs are harvested into it first — B never
  launches on artifacts still inside A's worktree.
- **Isolated lanes** (`isolation: "worktree"`): the lane branches from the remote
  default branch (`origin/main` here), not the session HEAD, and cannot write to the
  lead's checkout, so its outputs land under its own `_runs/` and its code stays on its
  branch. The lead records the frozen SHA before wave 1; after the lane stops it
  inventories the lane (`git status --porcelain=v2 --untracked-files=all`), harvests
  artifacts + `git diff --binary <frozen-sha> -- <owned-paths>` as a patch (explicitly
  staged new files ride along; still-untracked intended files are copied by hand),
  `git apply --check`s it in its own revision container, applies it there and verifies
  the applied tree (status, typecheck, tests) BEFORE any teardown, and only after that
  proof removes the exact resolved lane path through the OS that owns the registration
  with `git worktree remove --force <lane-path>` — a stage-only lane is dirty by design,
  so plain `remove` refuses it and force is authorised only by the proof above (never
  `prune`; missing coverage, application, ownership proof or removal authority = retain
  + ledger). It ledgers every surviving worktree/branch/patch in `00-INDEX.md`. Full procedure: SKILL.md,
  *Worktree lanes*.
- **Wave sizing**: ≤ 8 concurrent teammates (operator-ruled 2026-09-22). State the total before
  launching; an operator cut is applied by re-bundling, not by dropping items.
- **Item notes**: each item gets 1–2 lines of tailoring (what "good" looks like, known
  constraints). Resist writing essays — the skill/tool the teammate invokes carries
  its own instructions.
- **Compliance overlays** (regulated content, brand voice, banned claims) go in the
  PROJECT CONTEXT block verbatim, not summarized.
- **Liveness**: a lane silent past its expected cadence is investigated (transcript,
  process), not re-dispatched. Preserve a completed report even if the runner errored.
