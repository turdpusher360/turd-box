---
description: "Review and enrich the session cartridge before ending. Writes a model-curated summary for the next session."
argument-hint: "[optional: specific notes to include in the cartridge]"
paths: ["_runs/**"]
---

# /signoff

Review the current session cartridge, enrich the momentum field with a model-curated summary, and write the enriched cartridge back to disk before ending the session.

## Step 1: Read Current State

Attempt to read `_runs/session-cartridge.json` via Bash:

```bash
cat _runs/session-cartridge.json 2>/dev/null || echo "__MISSING__"
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

- If `enriched` is `true` AND `session_id` does not match the current session ID: warn the user before proceeding.

  Print:
  ```
  [signoff] Warning: existing cartridge is from a prior session (session <session_id>) and was model-curated.
  Overwriting it will discard that session's enriched summary. Proceed? (y/n)
  ```

  Wait for confirmation. If the user says no, stop here.

- If `enriched` is `true` AND `session_id` matches: proceed silently (re-enriching the same session is fine).
- If `enriched` is `false` or absent: proceed silently.

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

Construct the final JSON object. If an existing cartridge was read, preserve all fields from it and overwrite only `momentum`, `enriched`, and `enriched_at`. If building from scratch, include the full schema:

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

Write to disk via Bash using a heredoc. Use the exact JSON object assembled in Step 5:

```bash
cat > _runs/session-cartridge.json << 'CARTRIDGE_EOF'
<enriched JSON here>
CARTRIDGE_EOF
```

## Step 7: Confirm

Print a brief confirmation:

```
[signoff] Cartridge enriched and saved to _runs/session-cartridge.json
  Branch: <branch>
  Momentum: <first sentence of summary>
  Enriched at: <enriched_at>
```

If `$ARGUMENTS` was provided, also print:

```
  Notes: <$ARGUMENTS>
```

Do not print the full JSON. Do not repeat the full summary. Keep the confirmation to 5 lines or fewer.
