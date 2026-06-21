---
name: reconcile
description: "Fold handoffs since the last reconcile into BACKLOG.md — re-surface gold mines, flag drift, archive stale _runs/, regenerate INDEX.md. Anti-rot SSOT step."
tools: Bash, Read, Glob, Grep, Edit, Write
disable-model-invocation: true
---

# reconcile — Tasking Reconciliation

Thin orchestrator. Folds every handoff written since the last reconcile into the single,
deletable, current-state `BACKLOG.md` so gold mines cannot rot, redundancy cannot recur,
and drift is caught the cycle it happens — not months later by a drag-net.

**Do NOT pin a model in this frontmatter.** Per `.claude/rules/agent-selection.md`
"Skill Model Strategy", skills run inline on the operator's session model and dispatch the
heavy fold to an `opus-audit`-class agent in a fresh context. The fold is judgment work
(shipped vs parked vs drift), so the dispatched agent runs **Opus**.

---

## When to run

**Cadence:** every 5 sessions per active repo, OR on any of these triggers (whichever first):
- a launch / release / pivot;
- any `.decisions.jsonl` entry tagged `pivot` / `park` / `kill` / `defer`;
- the On-Startup handoff read (or the `handoff-record-check.cjs` commit advisory) reports the
  latest handoff is ≥5 sessions ahead of `BACKLOG.md`'s "reconciled as of S<N>" marker.

`/reconcile` with no args reconciles the current repo (cwd). Pass a repo path to reconcile a
sibling repo: `/reconcile /absolute/path/to/sibling-repo`.

---

## Step 1 — Locate the reconcile inputs (cheap, inline)

Resolve the target repo (cwd unless an arg gives a path). Then:

```bash
REPO="${1:-$(pwd)}"
# Current SSOT + its marker
ls "$REPO/BACKLOG.md" "$REPO/docs/BACKLOG.md" 2>/dev/null
grep -m1 "reconciled as of S" "$REPO/BACKLOG.md" 2>/dev/null
# Latest handoff session number
ls "$REPO/_runs/HANDOFF-S"*.md 2>/dev/null | sed -E 's/.*HANDOFF-S([0-9]+).*/\1/' | sort -n | tail -1
# Decision-log presence (precondition for the drift check)
ls "$REPO/_runs/.decisions.jsonl" 2>/dev/null || echo "MISSING .decisions.jsonl — drift check degraded"
```

If `BACKLOG.md` does not exist, this is a **first reconcile**: seed it from
`_runs/dragnet/<repo>-backlog.md` if present, else create the empty fixed structure
(see Step 4) with marker `reconciled as of S0`.

If `_runs/.decisions.jsonl` is missing, note it and proceed — the drift check runs in
degraded mode (it can still detect displaced openers from handoffs, just not match them to
decision entries). Recommend seeding the decision log as a follow-up.

## Step 2 — Dispatch the opus-audit fold agent

Dispatch ONE `opus-audit`-class agent with `model: opus`, `mode: bypassPermissions`. It does
the entire fold in a fresh context and writes disk-first. Give it this exact charter:

> **Reconcile <REPO> as of the latest handoff.** Read, in order:
> 1. `<REPO>/BACKLOG.md` (current SSOT) and note its "reconciled as of S<M>" marker.
> 2. EVERY `<REPO>/_runs/HANDOFF-S*.md` with session number > M (the new handoffs). Read
>    their headers/decision blocks in full; body-skim the rest (drvfs-gentle — do NOT
>    deep-read all of them).
> 3. The tail of `<REPO>/_runs/.decisions.jsonl` covering the same session window.
>
> **Fold rules (mechanical):**
> - For each new handoff: move shipped items OPEN→DONE-SINCE-LAST-RECONCILE (one line each);
>   move explicitly-parked items OPEN→PARKED **citing the `.decisions.jsonl` entry** that
>   parked them; move formally-retired items OPEN→KILLED (cite the decision); add genuinely
>   new work as OPEN (id | item | priority | birthed-in S<N> | evidence file:line).
> - **Anti-rot (mandatory):** for EVERY entry in the GOLD MINES section, grep the new handoffs
>   + `git log` since M for any follow-through. A gold mine that survives a reconcile cycle
>   **untouched** gets its priority bumped one notch OR is proposed for KILL with a one-line
>   rationale. Never silently leave a gold mine unranked — re-rank every cycle. This is the
>   mechanism that makes gold mines un-rottable.
> - **Drift check (advisory):** compute and append a `## DRIFT FLAGS` section:
>   - *started-without-decision* — a new build lane appears in a handoff with no
>     `.decisions.jsonl` entry authorizing it.
>   - *stopped-without-decision* — a lane OPEN/in-flight in a prior handoff vanishes from later
>     handoffs with no `park`/`kill`/`defer` entry.
>   - *displaced-opener* — a prior handoff's "NEXT-SESSION OPENER" is not what the next session
>     actually ran, with no defer decision.
>   Each flag reads: *"lane X started/stopped in S<N> with no matching .decisions.jsonl entry
>   — confirm intent or log a decision."* Advisory only; never block.
>
> **Output:** rewrite `<REPO>/BACKLOG.md` in the fixed structure (Step 4 below), bump the
> "reconciled as of" marker to the latest session + current HEAD sha, and write a one-paragraph
> reconcile summary to `<REPO>/_runs/reconcile-S<N>.md` (disk-first) before returning. Return a
> ≤10-line summary: items folded by bucket, gold mines re-ranked/proposed-for-kill, drift flags
> raised.

Use the existing dispatch path: `Agent({ subagent_type: "opus-audit", model: "opus",
mode: "bypassPermissions", prompt: <the charter above with REPO/M/N substituted> })`
(historical label is `opus-audit`; `model: "opus"` sets the actual model). If `opus-audit` is
unavailable in the project's approved agents, fall back to the `audit-bull` skill →
`@opus-audit`, same charter.

## Step 3 — Archive stale `_runs/` + regenerate INDEX.md (inline, after the fold lands)

Only after `BACKLOG.md` is rewritten (so any live gold mine is already extracted into the SSOT):

```bash
REPO="${1:-$(pwd)}"
LATEST=$(ls "$REPO/_runs/HANDOFF-S"*.md 2>/dev/null | sed -E 's/.*HANDOFF-S([0-9]+).*/\1/' | sort -n | tail -1)
CUTOFF=$((LATEST - 10))
mkdir -p "$REPO/_runs/archive"
# Move per-session working dirs older than the last 10 sessions. NEVER archive the durable set
# (HANDOFF-S*.md, .decisions.jsonl, .constraints.jsonl, BACKLOG.md, session-cartridge.json).
for d in "$REPO/_runs/s"[0-9]*; do
  [ -d "$d" ] || continue
  n=$(basename "$d" | sed -E 's/^s0*([0-9]+).*/\1/')
  case "$n" in (*[!0-9]*|"") continue;; esac
  if [ "$n" -lt "$CUTOFF" ]; then
    echo "archive: $(basename "$d") (< S$CUTOFF)"
    git -C "$REPO" mv "$d" "$REPO/_runs/archive/" 2>/dev/null || mv "$d" "$REPO/_runs/archive/"
  fi
done
```

**Hard rule:** the fold agent must have extracted any still-live gold mine from a session dir
into `BACKLOG.md` BEFORE that dir is archived. Archiving never buries unactioned value — the
gold mine lives in the SSOT, the raw report goes to `_runs/archive/`.

Then regenerate the tracked flat index from handoff headers — one line per session:

```bash
REPO="${1:-$(pwd)}"
{
  echo "# $(basename "$REPO") _runs/ INDEX — regenerated by /reconcile $(date -u +%Y-%m-%dT%H:%MZ)"
  echo ""
  echo "\`S<N> | date | what-shipped | report-dir\`"
  echo ""
  for f in $(ls "$REPO/_runs/HANDOFF-S"*.md 2>/dev/null | sort -t S -k2 -n); do
    n=$(echo "$f" | sed -E 's/.*HANDOFF-S([0-9]+).*/\1/')
    # date + first headline line from the handoff header (best-effort)
    hdr=$(head -8 "$f" | grep -m1 -iE 'date|[0-9]{4}-[0-9]{2}-[0-9]{2}' | tr -d '#*' | sed 's/^ *//' | cut -c1-80)
    dir=$([ -d "$REPO/_runs/s$n" ] && echo "_runs/s$n" || ([ -d "$REPO/_runs/archive/s$n" ] && echo "archived" || echo "-"))
    echo "S$n | ${hdr:-?} | $dir"
  done
} > "$REPO/_runs/INDEX.md"
```

(INDEX.md is tracked; `git add -f "$REPO/_runs/INDEX.md"` since `_runs/` is gitignored.)

## Step 4 — Fixed `BACKLOG.md` structure (what the fold agent writes)

```
# <repo> BACKLOG — reconciled as of S<N> (<HEAD sha>)
## OPEN            (id | item | priority | birthed-in | evidence file:line)
## GOLD MINES      (dormant built/spec'd value — never-actioned, with proof + re-ranked each cycle)
## PARKED          (explicitly held; cite the .decisions.jsonl entry that parked it)
## DONE-SINCE-LAST-RECONCILE  (rolled off OPEN; one line each)
## KILLED          (formally retired; cite the decision)
## DRIFT FLAGS     (lane started/stopped with no matching .decisions.jsonl entry — advisory)
```

`TASKING.md` / `TASKS.md` stay append-only as the raw audit trail. `BACKLOG.md` is the
curated, deletable SSOT — items move OPEN→DONE/PARKED/KILLED and **leave OPEN**.

## Step 5 — Store the reconcile summary in dev-memory

`memory_store` a single concise line (scope=project, using the repo's canonical slug as
scope_id; never an absolute filesystem path):

> "Reconciled <repo> S<M>→S<N>: X folded to DONE, Y new OPEN, Z gold mines re-ranked (W
> proposed KILL), V drift flags. Marker bumped to S<N> (<sha>)."

Tag `["reconcile","backlog"]`. This is the cross-session breadcrumb; the durable detail lives
in `BACKLOG.md`.

---

## Anti-scope-creep (from the SOP)

This skill does NOT replace handoffs, `TASKING.md`, dev-memory, or `.decisions.jsonl` — it
**folds** them. It adds no database, MCP server, or external tracker. The drift check is
advisory and never blocks. Per-repo `BACKLOG.md` + the SBD MEMORY.md "Current Work" index is
the cross-repo roll-up — do NOT centralize into one monolith.
