---
description: "Review and enrich the session cartridge before ending. Writes a model-curated summary for the next session."
argument-hint: "[optional: specific notes to include in the cartridge]"
paths: ["_runs/**"]
---

# /signoff

Review the current session cartridge, enrich the momentum field with a model-curated summary, and write the enriched cartridge back to disk before ending the session.

## Step 0: Rig Health Advisory

Before reading or enriching the cartridge, inspect the advisory rig cache:

```bash
node - <<'NODE'
const { readRigContextAdvisory } = require('./lib/os/kernel/rig-advisory.cjs');
const advisory = readRigContextAdvisory({ cwd: process.cwd() });
if (advisory) process.stdout.write(advisory + '\n');
NODE
```

This reads `_runs/os/rig-context.json`, if present. If nothing prints, continue silently.

Advisory only: `_runs/os/rig-context.json` is generated context, not proof. Verify live source of truth before relying on it. Do not abort, block, stage, commit, mutate runtime state, or change signing behavior because of rig warnings.

If the advisory prints non-ok or stale rig checks, mention them in the session review and include relevant rig warnings in `momentum.blockers` as advisory blockers.

## Step 1: Read Current State

Attempt to read `_runs/session-cartridge.json` via Bash:

```bash
node - <<'NODE'
const fs = require('fs');
const file = '_runs/session-cartridge.json';
try {
  const raw = fs.readFileSync(file, 'utf8');
  JSON.parse(raw);
  process.stdout.write(raw);
} catch (err) {
  if (err && err.code === 'ENOENT') {
    process.stdout.write('__MISSING__\n');
  } else {
    process.stderr.write(`[signoff] invalid existing cartridge JSON: ${err.message}\n`);
    process.exit(2);
  }
}
NODE
```

If the file is missing or the output is `__MISSING__`, build cartridge data from scratch:

```bash
git branch --show-current
git log --oneline -5 --no-decorate
git diff --name-only HEAD
```

Also read (best-effort):
- First 50 lines of `TASKING.md` for task state
- Last 10 lines of `_runs/.decisions.jsonl` for recent decisions

## Step 2: Guard — Prior Session Cartridge

If the cartridge was read successfully, check these fields:

- If `session_id` exists and does not match the current session ID: warn the user before proceeding, even if the cartridge is not enriched.

  Print:
  ```
  [signoff] Warning: existing cartridge is from a prior session (session <session_id>).
  Enriching it as current would preserve stale git/files/tasks unless rebuilt. Rebuild current-session cartridge? (y/n)
  ```

  Wait for confirmation. If the user says no, stop here.

- If `session_id` matches: proceed silently (re-enriching the same session is fine).
- If `session_id` is absent: treat the existing cartridge as partial input only; rebuild session-scoped fields from live state.

## Step 3: Present Summary

Print a structured review of the session state:

```
[signoff] Session Review
Branch:    <branch>
Commits:   <recent_commits[0]> (and N more)
Modified:  <count> files — <file1>, <file2>, ... (up to 3, then "and N more")
Tasks:     <done_count>/<total_count> complete
Decisions: <last decision.chose over decision.over> (and N more)
```

If any field is unavailable (git failed, file missing), show `(unavailable)` for that field. Do not abort.

## Step 4: Enrich Momentum

Write the `momentum` object with model-authored content based on the session state:

- **`summary`**: 2-3 sentences describing what happened this session. Ground it in the actual commits, modified files, and decisions. Be specific — name files and decisions rather than speaking in generalities.
- **`next`**: 1-2 sentences on the recommended next action. Use the task list, uncommitted files, and pending decisions as signals. If nothing is obviously pending, say so.
- **`blockers`**: Array of strings. Each blocker is one sentence. Include known blockers from decisions, uncommitted files with conflicts, or tasks that are in-progress but not complete. Empty array if none.
- **`user_notes`**: If `$ARGUMENTS` is non-empty, include the full text of `$ARGUMENTS` here verbatim. Otherwise omit the field (do not include an empty string).

## Step 5: Assemble Enriched Cartridge JSON

Construct the final JSON object from current live state. If an existing cartridge was read, preserve only non-session metadata (`v`, `ttl_hours`, and original `ts` when it belongs to the same session). Always rebuild session-scoped fields from current live state before writing:

- `session_id`
- `git`
- `modified_files`
- `decisions`
- `tasks`
- `momentum`
- `enriched`
- `enriched_at`

Derive the `git` block mechanically — never hand-type or eyeball-transcribe it. Run:

```bash
node -e "const w=require('./.claude/hooks/session-cartridge-writer.cjs');process.stdout.write(JSON.stringify(w.collectGitContext(),null,2))"
```

and paste the result verbatim as the `git` value. (Defect class this guards against: a hand-derived list once shipped `ASKING.md` — shell `$(...)`/display trims eat the leading status-space of the first porcelain line, and a manual `cut -c4-`-style transcription then drops the path's first character. The writer module's parser handles that class; it is the single source of truth for `uncommitted`.)

Never preserve prior-session `git`, `modified_files`, `decisions`, or `tasks` into the enriched output. If building from scratch, include the full schema:

```json
{
  "v": 1,
  "ts": "<original cartridge ts, or current ISO timestamp if building from scratch>",
  "ttl_hours": 48,
  "session_id": "<session_id from original cartridge, or current session if building from scratch>",
  "git": {
    "branch": "<branch>",
    "recent_commits": ["<hash> <message>", "..."],
    "uncommitted": ["<file>", "..."]
  },
  "modified_files": ["<file>", "..."],
  "decisions": [{"ts": "...", "decision": "...", "chose": "...", "over": "...", "reason": "..."}],
  "tasks": [{"done": false, "text": "..."}],
  "momentum": {
    "summary": "<2-3 sentences: what happened>",
    "next": "<1-2 sentences: what to do next>",
    "blockers": ["<blocker sentence>"],
    "user_notes": "<$ARGUMENTS verbatim, if provided>"
  },
  "enriched": true,
  "enriched_at": "<current ISO timestamp>"
}
```

Ensure the JSON is valid: no trailing commas, all strings properly escaped, no undefined values.

## Step 6: Write Enriched Cartridge

Write to disk via Bash using a temp file, JSON validation, and atomic move. Use the exact JSON object assembled in Step 5:

```bash
tmp="_runs/session-cartridge.json.$$.$RANDOM.tmp"
cat > "$tmp" << 'CARTRIDGE_EOF'
<enriched JSON here>
CARTRIDGE_EOF
node -e "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'))" "$tmp" &&
  mv "$tmp" _runs/session-cartridge.json
```

If validation fails, leave the prior `_runs/session-cartridge.json` untouched, remove the temp file if it still exists, print the validation error, and stop before staging or committing continuity.

## Step 7: Commit the continuity (so it can't strand)

The cartridge, `TASKING.md`, and the decision/constraint logs are now updated on disk but **uncommitted**. Historically nothing committed them and the manual closeout commits lapsed — several sessions of continuity piled up uncommitted, making the repo look dead and letting a stale brief get trusted on the next boot. This step closes that hole. `/signoff` is operator-invoked, so the 1Password PIN is available for signing.

First, keep `TASKING.md` and `_runs/.decisions.jsonl` bounded so they don't re-accrete before the next closeout:

```bash
if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "$CLAUDE_PLUGIN_ROOT/bin/rotate-continuity.cjs" ]; then
  node "$CLAUDE_PLUGIN_ROOT/bin/rotate-continuity.cjs" --apply
elif [ -f scripts/rotate-continuity.cjs ]; then
  node scripts/rotate-continuity.cjs --apply
else
  echo "continuity rotation skipped: no rotate-continuity helper found"
fi
```

Report what it moved (e.g. "rotating 2 rows / 3 entries to archive") or "nothing to rotate" if both are still under the caps. The plugin-shipped helper targets the current project directory by default; the repo-local helper remains the fallback for this source checkout. This is safe every time it runs: it dry-runs by default (only `--apply` mutates), writes atomically (temp file + rename), and aborts with no mutation at all if line-count conservation ever fails. Overflow lands in gitignored archives (`_runs/tasking-archive.md`, `_runs/.decisions.archive.jsonl`) — nothing is lost, it just moves off the files read whole every closeout.

**Board-advance sub-step (campaign sessions only — pre-stage).** If `_runs/forge-board/campaign.json` exists AND this session is a campaign session (its dispatch card names a C-position), advance the board now, BEFORE staging:

- Update `position` / `block` / `state` per the session outcome.
- Append the `sessions[]` entry: `pos`, `s_number`, `date`, `type`, `verdict`, `shipped_range`.
- Bump or reset `tripwire_counter` (board sessions only — spec §5.4).
- Append the `gates[]` entry when the card is a gate.

Apply the update via a Bash node heredoc with atomic tmp+rename (the Step 6 cartridge pattern):

```bash
node - <<'NODE'
const fs = require('fs');
const file = '_runs/forge-board/campaign.json';
const board = JSON.parse(fs.readFileSync(file, 'utf8'));
// apply the updates above: position/block/state, sessions[] entry,
// tripwire_counter, gates[] entry (gate cards only)
const tmp = file + '.' + process.pid + '.tmp';
fs.writeFileSync(tmp, JSON.stringify(board, null, 2) + '\n');
fs.renameSync(tmp, file);
NODE
```

Non-campaign session or file absent → skip silently. Board facts are session-close facts needing no post-commit HEAD, so the board rides its OWN session's continuity commit (spec §6.3 invocation-point decision, P2-1).

Then stage ONLY the (now-bounded) continuity files (never `git add .` — `guard-git-scope` blocks it). Force-add the latest handoff if one was written this session (handoffs are gitignored):

```bash
git add TASKING.md _runs/.decisions.jsonl _runs/.constraints.jsonl _runs/session-cartridge.json 2>/dev/null
[ -f _runs/forge-board/campaign.json ] && git add -f _runs/forge-board/campaign.json
LATEST_HO=$(ls _runs/HANDOFF-S*.md 2>/dev/null | sort -t S -k2 -n | tail -1)
[ -n "$LATEST_HO" ] && git add -f "$LATEST_HO" 2>/dev/null
git diff --cached --name-only
```

Why the board line needs its own `-f`: plain `git add` will NOT do — `.gitignore:50` (`_runs/*`) refuses NEW files under `_runs/`, and the first `git add` line's `2>/dev/null` swallows that refusal silently; latest.json and the cartridge survive only because already tracked. `-f` is harmless once tracked and effective while ignored-new, matching the handoff force-add precedent in this same block. A gitignore negation was rejected (3-line dir-unignore dance). This design is FINAL (adjudicated P1-1) — do not redesign.

**If the staged list above is empty**, the continuity was already committed this session — report "continuity already committed — nothing to land" and skip to Step 8. Otherwise commit it **signed and timeout-boxed** (git commit is atomic — a killed signing makes no commit, so the timeout is safe). Use the session number you just enriched; if unknown, omit it:

```bash
timeout 120 git commit -m "docs(session): S<N> closeout — continuity (cartridge + TASKING + logs)"
```

Then branch on the result — do NOT improvise:
- **rc == 0:** report the SHA + signature (`git log -1 --format='%h sig=%G?'`). Done.
- **rc != 0** (timed out / 1Password locked / signing failed — the staged files printed above are real but uncommitted): do NOT retry with `-c commit.gpgsign=false`, and do NOT silently move on. Leave the files staged and print, verbatim:

  ```
  [signoff] Continuity is STAGED but NOT committed (signing unavailable).
  Land it with:  git commit -m "docs(session): closeout — continuity"
  ```

**Never land an unsigned closeout here** — an unsigned commit is the exact anti-pattern `commit-signature-guard` exists to catch. Signed, or staged-with-a-loud-reminder — never unsigned, never silent. Do NOT push: pushing is operator-gated (main has PR-required branch protection).

## Step 7.5: Emit the session pill (pill-only, fail-open)

Emit the session pill NOW — after Step 7's commit — because the pill needs the FINAL HEAD: emitting earlier bakes a HEAD that Step 7's own commit immediately stales (pill design constraints 1–2 — docs/transition-kit.md design record; spec §6.3). This step is PILL-ONLY; the board already advanced pre-stage in Step 7.

Dual-resolution invocation (same shape as the rotate-continuity helper in Step 7):

```bash
if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "$CLAUDE_PLUGIN_ROOT/bin/emit-pill.cjs" ]; then
  node "$CLAUDE_PLUGIN_ROOT/bin/emit-pill.cjs" || echo "pill: FAILED — boot from cartridge/handoff"
elif [ -f scripts/emit-pill.cjs ]; then
  node scripts/emit-pill.cjs || echo "pill: FAILED — boot from cartridge/handoff"
else
  echo "pill: no emit-pill helper found — boot from cartridge/handoff"
fi
```

The emitter prints the raw pill to stdout and writes it to `_runs/pill-latest.md` (default; `--out <path>` overrides), exiting 0 on success / 1 on failure. Then relay the emitted pill to the operator as a FENCED block in the closing response — that is the copy surface (one phone screen, spec §6.5).

Fail-open contract: emission failure warns and NEVER blocks or un-lands the already-committed continuity (spec §6.3). The pill file (`_runs/pill-latest.md`) is gitignored/ephemeral by design — never stage it.

## Step 8: Confirm

Print a brief confirmation:

```
[signoff] Cartridge enriched and saved to _runs/session-cartridge.json
  Branch: <branch>
  Momentum: <first sentence of summary>
  Enriched at: <enriched_at>
  Pill: <emitted → _runs/pill-latest.md | FAILED — boot from cartridge/handoff>
```

If `$ARGUMENTS` was provided, also print:

```
  Notes: <$ARGUMENTS>
```

Do not print the full JSON. Do not repeat the full summary. Keep the confirmation to 5 lines or fewer.
