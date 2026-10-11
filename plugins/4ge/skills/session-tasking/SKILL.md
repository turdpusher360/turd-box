---
name: session-tasking
description: >-
  Turn a broad "run everything relevant" intent into a decision surface (native
  AskUserQuestion picker up to 16 items unless rows need per-item context, then the
  single-file HTML picker), execute
  the approved run list with contained no-spawn teammates, consolidate the deliverables
  under _runs/, and always end with next-step options. Use whenever the user wants to
  fan out work across many discrete items — commands to run, repo modules to scaffold,
  fixes to ship, content pieces to produce, migrations to apply — or says anything like
  "task this out", "run the sweep", "give me a picker", "yay or nay", "run list", "what
  are my options", "fan out", or pastes back a block starting with "RUN LIST". Also
  trigger when a work session has produced a pile of findings or candidate actions and
  the user needs a decision surface for what happens next, even if they never name this
  skill.
---

# Session Tasking

Large fan-outs fail in two ways: the agent decides *for* the user (bundles, skips,
silent scope cuts), or it dumps an unstructured wall of options into chat. This skill
fixes both with one loop:

**Inventory → Picker → Run list → Launch gate → Contained execution → Consolidated deliverables → Next bubbles**

The user stays the approver at every gate; the agent does all the enumeration,
rendering, and execution. Every cycle ends with a new decision surface — the
"next-prompt bubbles" — so momentum never dies at a wall of files.

Origin: the operator's Claude Desktop (Cowork) custom skill (2026-07-25), ported into
4ge on 2026-09-22. The loop is unchanged; the rig defaults below are what changed.

## Rig defaults (4ge)

These bind every phase. They restate standing rig rules so a session following this
skill never has to choose between the skill and the rig.

- **Delivery rule (HARD):** in conversation, a decision gate is delivered as a native
  AskUserQuestion picker — options mapped 1:1, recommended option first, rationale in
  prose before the call — and nothing on the menu executes before the operator's
  ruling. AskUserQuestion carries up to 4 questions × 4 options with `multiSelect`, so
  a run list of ≤ 16 plain items fits natively. Text menus and `> _` prompts are never
  the interactive surface.
- **The HTML picker is a disposable per-run artifact.** It lives at
  `<run-root>/picker.html`, is labeled temporary, and is the recorded exception to the
  operator-facing surface reuse gate (AGENTS.md): Forge HQ stays the canonical estate
  surface; this page is a one-run decision form, never a site or dashboard.
- **Run root:** `_runs/<YYYY-MM-DD>/session-tasking-<NN>/` (gitignored, disk-first).
  Never `runs/` at the repo root, never inside a tracked tree.
- **Teammates are approved agent types only** — the ones with a
  `.claude/agents/<name>.md`, hook-enforced: `sonnet-execute` (writes code/files),
  `sonnet-research` (research → `_runs/` report), `opus-review` (read-only judgment).
  Harness pseudo-types (the built-in explorer, planner, etc.) are denied by
  `enforce-approved-agents.cjs`. Nested fan-out is structurally unavailable to any
  teammate on this rig; the contract's no-spawn ban is belt and braces, not the only
  guard.
- **Budget:** ≤ 8 concurrent teammates (operator-ruled 2026-09-22), ≤ 1 heavy gate. Run
  the `/4ge:usage` pre-dispatch gate before the first wave and state the window.
- **Model and effort are selected per lane, never blind-inherited.** The operator picks
  the model at the launch gate and every Agent call carries `model:`. Record two model
  fields per lane at launch: the dispatch selector the Agent or Workflow call accepts
  (a family alias such as `opus`, or a full id such as `claude-opus-5-5`) and the
  canonical id expected in the transcript's `message.model` (`claude-opus-5-5`). Prefer
  the full id as the selector — an alias whose canonical id you cannot name is
  UNVERIFIED before launch, and an Agent-tool `opus` alias was served `claude-opus-5`
  on this rig (2026-09-22). Effort rides on the approved agent's `effort:` frontmatter
  pin (honoured on pinned-default models since CC 2.1.267; the Agent tool itself has no
  effort field), so the launch gate names the pinned effort for each lane and a lane
  that needs a different effort runs through a Workflow `agent()` call, which takes
  per-call `effort`, or waits for the operator to change the pin. When the lane stops,
  verify the served model on THAT lane's own transcript — the `agent_transcript_path`
  the SubagentStop payload names (`subagents/agent-<id>.jsonl` under the session
  directory): parse only `type: "assistant"` records, ignore `message.model ===
  "<synthetic>"` (runtime-injected records), strip a trailing `[…]` context suffix,
  require at least one non-synthetic record, and require every remaining record to
  equal the canonical expected id. Those are the rules
  `scripts/checks/model-identity-drift.cjs` applies to top-level sessions; it cannot
  bind an Agent lane to its transcript, so the lead applies them per lane. No runtime
  field exposes served effort: cite the configured effort — the frontmatter pin for an
  Agent lane, the exact per-call `effort` argument for a Workflow lane — labeled as
  requested, never as served. A model mismatch, a transcript with no non-synthetic
  record, an unknown selector-to-id mapping, or a lane whose transcript cannot be
  located is reported as UNVERIFIED and that lane stops — never silently substitute,
  never accept the lane's own claim.
- **Stage-only = the charter gates.** Publish, deploy, DNS, money, visibility,
  credentials and persistent system/tool changes stay per-action operator-gated no
  matter what the run list says. A checked box is not that word.
- **Steer before serving.** The operator will approve the slate as served. Tags are the
  lead's ruling: pre-check only what you would defend running, and never use the picker
  to offload an unresolved judgment call.

## Phase 0 — Is this actually a fan-out?

| items | surface |
|---|---|
| < 5 | one AskUserQuestion (`multiSelect`), no ceremony |
| 5–16 | AskUserQuestion, 4 options per question, grouped by theme |
| > 16, or any size where rows need per-item `warn`/`tag` context to decide | the HTML picker |

Skip the loop entirely when the request is one decision, not a fan-out.

## Phase 1 — Inventory

Enumerate the FULL decision space for the domain. One row per atomic item. Do not
pre-bundle items into packs — bundling steals the user's per-item veto, and users
notice. (Bundles come later, at execution, where they're an efficiency choice — not at
decision time, where they're a control choice.)

Each row:

| field | meaning |
|---|---|
| `group` | section header (plugin, module family, fix tier, content pillar) |
| `id` | exact runnable identifier (`/4ge:skill`, `src/tools/foo.ts`, `P0-3`) — no `;`, CR or LF (paste-back delimiters) |
| `desc` | one line, ≤ 12 words, what running it produces |
| `tag` | `yes` (recommended — pre-checked), `maybe`, `na` (unlikely, still listed) |
| `warn` | optional: dependency gaps, dupes, "needs X connector", "runs as agent", "owner-gated" |

Tag honestly from real project context, not vibes. Duplicates get listed and marked
`na` + `dupe` rather than silently dropped — the user decides what's redundant. If an
item can't run well (missing connector, no data), that's a `warn`, not an exclusion.
An item that ends at a charter gate (publish, deploy, DNS, money, visibility) carries
`warn: owner-gated` so the box means "prepare to the gate", not "do it".

## Phase 2 — The picker

Write the rows to `<run-root>/rows.json` (`[[group, id, desc, tag, warn?], …]`) and
render the page with the shipped renderer — never by hand-substituting the
placeholders, because `__DATA__` lands inside a `<script>` block and a row containing
`</script>` or a line terminator would break the page:

```
node <skill-dir>/assets/render-picker.cjs --title "<title>" --subtitle "<subtitle>" \
  --rows <run-root>/rows.json --out <run-root>/picker.html
```

The renderer HTML-escapes the title/subtitle, JS-escapes the data literal, validates
tags, and rejects ids carrying paste-back delimiters. Then deliver the file through
whatever file/artifact delivery tool the live session actually exposes — probe the
tool surface first; tool names differ across Claude Code, Desktop and Cowork and
old names are not proof of availability. If no delivery tool is present, give the
local path and say `delivery unverified`. Never use localStorage/sessionStorage in the
page — in-memory state only; those APIs fail in sandboxed artifact iframes.

The template provides: search, filter chips (All / Relevant / Maybe / Unlikely /
Selected), per-section select all/none, pre-checked `yes` rows, live selected count,
and a **Generate run list** button that emits the paste-back block. Don't reinvent it;
consistency is what makes the paste-back parseable.

Paste-back grammar — two forms, parse both:

```
RUN LIST — approved (N run / M skipped)
RUN (N):
/item-id
/item-id [optional freeform args]
```

```
RUN LIST: /item-id; /item-id [args]; /item-id
```

The **Copy one-line** button emits the second form. Phone/Termius operators paste that
one: Termius splits a multi-line paste into separate prompts, and the first line alone
("RUN LIST — approved …") carries no items. When the clipboard is blocked (sandboxed
iframe, denied permission) the page says so and leaves the text selected for a manual
copy.

Tell the user explicitly: check what runs, hit Generate, paste it back. Pasted slash
commands are inert text — nothing executes until they paste and you act.

## Phase 2.5 — Launch gate (one call, then no re-prompting)

On paste-back: parse, echo the count, then one AskUserQuestion that carries every
launch decision at once — the model per lane (operator picks; recommended first), the
effort per lane (the approved agent's `effort:` pin, stated; a different effort means the
Workflow `agent()` path or a pin change), the concurrency (default ≤ 8), and the
announced budget "N items → K teammates in W waves".
Run `/4ge:usage` before serving it and put the window in the prose. This is the only
ceremony between paste-back and execution: once the answer is in, the run is Tab-driven
— no pickers for routine steps inside an already-decided flow.

## Phase 3 — Contained execution

Non-negotiables, learned the hard way:

1. **Announce the agent budget before launching.** "N items → K teammates in W waves,
   worst case K agents total." Users who have watched a runaway fan-out (91 agents)
   need the number up front, and they may cut it — respect the cut immediately by
   consolidating items into themed bundles (4–6 items per teammate, run sequentially
   inside one context).
2. **Default shape:** themed bundles, ≤ 8 teammates concurrent, waves ordered by
   dependency (recon → strategy → execution; strategy outputs feed execution bundles
   through the lead's run root — written there directly by checkout-sharing teammates,
   harvested first from isolated lanes, see *Worktree lanes* below). Every bundle that
   edits tracked files runs with `isolation: "worktree"` (the contract's rule); bundles
   whose file ownership overlaps are additionally made disjoint or serialized before
   dispatch.
3. **Every teammate carries the contract** in `references/teammate-contract.md`:
   no-spawn hard ban (no Agent/Task/Workflow calls), stage-only, no fabrication
   (estimates labeled, gaps stated), never wait for user input (log assumptions), write
   deliverables to `<run-root>/<item-slug>/` under the lane's own checkout root, return
   a short summary + absolute file paths + branch + assumptions — never the full
   deliverable as chat text.
4. **Match the type to the item:** `sonnet-research` for research, `opus-review` for
   judgment (read-only), `sonnet-execute` with the prompt ban for anything that writes.
5. If an item's skill/tool expects interactive approval, the teammate prepares
   everything **up to the gate and stops**, documenting exactly what approval is
   pending. Approval gates belong to the user, always.
6. Deliverable basenames never start with `REPORT`, `SUMMARY`, `FINDINGS` or `ANALYSIS`
   (subagent Write refusal class); `00-INDEX.md` and `<item-slug>.md` are safe.
7. Monitor productive work to completion. Investigate a concrete stall (transcript
   silent, runaway consumption) — never launch a duplicate lane, never invent a spend or
   time cutoff the operator did not set.

### Worktree lanes (`isolation: "worktree"`)

An isolated lane does not see the lead's tree, and the lead's tree does not see the
lane's output. Both facts are harness behaviour on this rig, so the procedure is
mandatory whenever a bundle is isolated:

- **Frozen ref before wave 1.** Harness worktrees (under `.claude/worktrees/`; `git
  worktree list` is the truth) branch from `origin/<default-branch>`, not the session
  HEAD — this repo sets no `worktree.baseRef`. Resolve the default ref
  (`git symbolic-ref refs/remotes/origin/HEAD`; `origin/main` here), record its SHA
  (`git rev-parse <ref>`) as the frozen ref and the lead's HEAD in `00-INDEX.md`. If a lane needs unpushed work, push the lane branch
  first (when the packet covers it) or hand the lane the diff as a file; never assume it
  sees uncommitted or unpushed changes.
- **Lane-local artifacts.** `_runs/` is gitignored and no `.worktreeinclude` copies it,
  and worktree enforcement refuses main-checkout writes from an isolated lane. The
  teammate therefore writes `<run-root>/<item-slug>/` under ITS OWN worktree root (same
  relative path) and reports the absolute path plus its branch name. Prior-wave inputs
  are given as absolute paths into the lead's run root, read-only; a refused read is
  reported, not worked around.
- **Harvest before anything depends on it.** When the lane stops: copy
  `<lane-worktree>/_runs/<date>/session-tasking-<NN>/<item-slug>/` into the lead's run
  root. For code lanes: inventory the lane with `git -C <lane-worktree> status
  --porcelain=v2 --untracked-files=all`; the teammate has staged every new or changed
  file by explicit path (uncommitted), and any intended file still untracked is copied
  by hand; then `git -C <lane-worktree> diff --binary <frozen-sha> -- <owned-paths>` →
  `<run-root>/<item-slug>/lane.patch` (`--binary` keeps binary payloads;
  `<owned-paths>` = the bundle's file ownership) and `git apply --check <lane.patch>`
  in the lead's worktree BEFORE any teardown. Note the branch. A lane whose inventory
  is not fully covered by the patch plus copies stays dirty: retain it, ledger it,
  never force-remove it. A dependent wave launches only after its inputs sit in the
  lead's run root.
- **Integrate in the lead's revision container.** Patches apply to the run's lane
  branch in the lead's worktree, where tsc + vitest run and, for Claude-written gate and guard code, the Sonnet 5.5 read-only audit applies (Codex only for the task class AGENTS.md › Model Routing names)
  before any signed commit — never onto `main` directly.
- **Retain, then clean.** Keep a lane worktree until (1) its inventory is proven covered by the
  patch plus copies, (2) the patch passes `git apply --check` in the lead's revision
  container, and (3) it is actually applied there and the applied tree verified (status,
  typecheck, tests). Only then remove the exact resolved lane path through the OS that
  owns its registration with `git worktree remove --force <lane-path>` — a stage-only
  lane is dirty by design, so plain `remove` refuses it, and force is authorised only by
  steps 1–3; missing coverage, application, ownership proof or authority = retain +
  ledger. Ownership:
  `git worktree list --porcelain` shows the registered gitdir string; a WSL-form path
  (`/mnt/<drive>/…`) is removed from WSL, a Windows-form path (`<Drive>:/…`) from Windows (the
  AGENTS.md lens-partition rule) — never `git worktree prune`. If ownership cannot be
  proven, retain the worktree and ledger it. Delete the branch once integrated, and
  list every surviving worktree, branch and patch in the run's Open Resources ledger —
  the successor inherits closure debt explicitly.

## Phase 4 — Consolidation

When all waves return: write `<run-root>/00-INDEX.md` — grouped by theme, one line per
deliverable, plus a **"Decisions only you can make"** section (the unresolved forks,
approval gates, and owner-only actions surfaced by the run) and an **Open Resources**
ledger (lane worktrees, branches, patches; "none" when no lane was isolated). Zip the
run root. Deliver:
index + zip. A visual readback of a large run goes through Forge HQ (the canonical
operator surface); a standalone dashboard page needs the same recorded exception as
the picker and the same temporary label. The user's summary in chat is 3–6 sentences
of what changed their picture — not a recap of every file.

Durable outcomes leave the run root: decisions and dead-ends go to
`_runs/.decisions.jsonl` / `_runs/.constraints.jsonl` (`/4ge:decide`,
`/4ge:constraint`); one `memory_store` per run for facts that outlive the session.
Session state never goes to memory.

## Phase 5 — Next bubbles (never skip)

The run always surfaces follow-on choices. Convert them into the next decision
surface instead of prose suggestions:

- **≤ 4 clear options** → AskUserQuestion, one line each, recommended first.
- **More, or options needing context** → a second mini-picker from the same template,
  titled "Next moves", where each row is a runnable next step (fix to apply, module to
  build, decision to make) with the same tag/warn treatment.
- **Already decided and linear** → no picker. End on one crisp `Next: <exact action>`
  line so the suggestion chip mirrors it (Tab = approve).

This is the Lovable-style loop: deliverable → bubbles → new run list → repeat. A
session using this skill should never end on "let me know if you want anything else."

## Domain adaptations

Same loop, different rows:

- **Skill/command sweep**: rows = every runnable `/4ge:*` command and plugin skill,
  grouped by plugin; warn on missing connectors and dupes.
- **Repo building**: rows = modules/files/endpoints to scaffold (`src/tools/seo.ts`,
  `migrations/003_*.sql`); warn on items needing repo access or unverified
  conventions; execution teammates write real, typecheck-verified code in a worktree.
- **Fix rollout**: rows = audit/DFE findings (P0-1, P1-4…) or `/4ge:fix` collector
  items with effort tags; execution = staged patches/checklists, never live deploys.
- **Content batch**: rows = posts/assets/videos (site, social, stream); execution
  stages drafts behind approval gates.

## Failure modes to avoid

- Bundling at decision time. (Control theft — the original sin this skill exists to fix.)
- Launching without announcing the agent count. (Budget trust.)
- Letting a teammate answer with the deliverable pasted into chat. (Files, always.)
- Fabricated metrics anywhere in the corpus. (One invented number poisons trust in
  all 120 real ones.)
- Ending without bubbles. (The wall of files is where momentum goes to die.)
- Re-prompting inside a decided run. (The launch gate is the one call; after it, Tab.)
- Ratification pickers. The picker chooses what runs; it never asks the operator to
  sign off on what already ran — report results, surface real forks only.
- Hand-substituting `__DATA__`, a `runs/` directory at the repo root, or an HTML
  picker presented as a new surface.
- Launching a dependent wave on artifacts still inside an isolated lane's worktree, or
  removing that worktree before the harvest.
