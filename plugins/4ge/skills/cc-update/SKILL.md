---
name: cc-update
description: "Update cc, cc upgrade, new version, version audit, claude code update, CC upgraded, harness update. Use when Claude Code has been updated to a new version and the codebase needs to be audited for impact."
tools: Bash, Read, Write, Edit, Glob, Grep
disable-model-invocation: true
---

# /cc-update — CC Version Audit Workflow

7-phase workflow for auditing Claude Code upgrades and keeping `harness-internals.md` current.

Run after any CC version bump to detect breaking changes, stale refs, and new capabilities.

## Parse $ARGUMENTS

| Pattern | Action |
|---------|--------|
| `--from <ver>` | Override "previous version" instead of reading from memory/harness-internals.md |
| `--dry-run` | Run all detection phases but skip writes and commits |
| (empty) | Full 7-phase audit |

---

## Phase 1: DETECT

Capture the current installed version:

```bash
claude --version
```

Determine the previous version from two sources (first wins):

1. Search memory: `memory_search query="CC version harness-internals" limit=3`
2. Read the version stamp at the top of `docs/harness-internals.md` — line format: `Last verified against: vX.Y.Z (YYYY-MM-DD).`

Compute the delta:
- If current == previous: report "No version change detected. Nothing to do." and stop.
- If current > previous: proceed to Phase 2 with `PREV_VER` and `NEW_VER` set.

---

## Phase 2: RESEARCH

Fetch official release notes for every version between `PREV_VER` and `NEW_VER` (inclusive of new):

```bash
gh api repos/anthropics/claude-code/releases --jq '.[].tag_name' 2>/dev/null | head -10
```

For each new release tag, fetch its body:

```bash
gh api repos/anthropics/claude-code/releases/tags/<TAG> --jq '.body' 2>/dev/null
```

Also search memory for prior CC version context and known issues:

```
memory_search query="harness hooks permission cascade" limit=5
memory_search query="agent frontmatter fields effort model" limit=5
```

Compile a **Delta Summary** covering these feature categories (mark each as NEW / CHANGED / REMOVED / NO CHANGE):

| Category | Status | Notes |
|----------|--------|-------|
| Hook events (new/removed hookable events) | | |
| Agent frontmatter fields (new keys, new defaults) | | |
| hookSpecificOutput capabilities (new output fields) | | |
| Permission cascade changes | | |
| New env vars or settings.json keys | | |
| New effort levels or default changes | | |
| Deprecated / removed commands or tools | | |
| Auto-compact algorithm changes | | |
| Subagent budget or turn limit changes | | |
| MCP protocol changes | | |
| GrowthBook / feature flag changes | | |
| Security or permission model changes | | |

---

## Phase 3: IMPACT SCAN

Scan the codebase for stale references introduced by the version delta.

### 3a. Keybinding and command refs

```bash
# Check for removed/renamed CLI commands or flags in hook files and skills
grep -rn --include='*.cjs' --include='*.md' \
  -E 'claude (agents|update|powerup|fork|batch|loop)' \
  .claude/ plugins/ 2>/dev/null | head -20
```

### 3b. settings.json keys

```bash
# Compare known settings keys against current settings.json
cat .claude/settings.json 2>/dev/null
```

Check release notes for any deprecated or newly required keys. Flag mismatches.

### 3c. Agent frontmatter fields

```bash
# Scan all agent .md files for frontmatter
grep -rn --include='*.md' -E '^(model|effort|tools|isolation|maxTurns|memory|disable-model-invocation):' \
  .claude/agents/ plugins/4ge/skills/ 2>/dev/null | head -40
```

Cross-reference against release notes for new fields like `keep-coding-instructions`, `initialPrompt`, `sessionTitle`, or changed defaults. Flag agents missing newly required fields or using removed fields.

### 3d. Hook event references

```bash
# Check hooks-contract.md and settings.json for event names
grep -n 'PreToolUse\|PostToolUse\|SessionStart\|SessionEnd\|SubagentStop\|TaskCreated\|TeammateIdle\|InstructionsLoaded\|PermissionDenied\|WorktreeCreate\|FileChanged' \
  docs/hooks-contract.md .claude/settings.json 2>/dev/null
```

Flag any events that are new (not yet in hooks-contract.md) or removed (wired but no longer valid).

### 3e. harness-internals.md stale sections

Read `docs/harness-internals.md` and cross-reference each numbered section against the release notes delta. Identify sections requiring updates:

- Section 1: Permission cascade steps
- Section 2: Hook event table (count and names)
- Section 3: Tool loading / deferred tool behavior
- Section 4: Auto-compact algorithm
- Section 5: Subagent budgets
- Section 6/6b: Release-specific notable changes (add new section for `NEW_VER`)
- Section 8: Feature flag status
- Section 9: GrowthBook runtime flags

Output a **Stale Ref Report**:

```
## Impact Scan Results

### Settings.json: [N issues / CLEAN]
[list any deprecated keys or missing required keys]

### Agent Frontmatter: [N issues / CLEAN]
[list agents with stale or missing fields]

### Hook Events: [N issues / CLEAN]
[list new events not yet wired; retired events still wired]

### harness-internals.md sections needing update: [N / NONE]
[list section numbers and what changed]

### Other stale refs: [N / NONE]
[list any command/flag refs that are no longer valid]
```

---

## Phase 4: SMOKE TEST

Run the verification triad and capture output:

```bash
npx tsc --noEmit 2>&1 | tail -5
```

```bash
npx vitest run 2>&1 | tail -10
```

```bash
# hook-utils.cjs smoke test — verify require() works
node -e "const u = require('./.claude/hooks/hook-utils.cjs'); console.log('hook-utils OK, exports:', Object.keys(u).join(', '));"
```

Record baseline counts:
- TypeScript errors before fixes: N
- Test pass/fail counts: N passing, N failing
- hook-utils.cjs: OK / FAIL

If tsc or hook-utils.cjs fails → note as **blocking** (must fix before Phase 6 can pass).
If vitest fails → compare against known pre-existing failures (check `.maintain-baseline.json` if present).

---

## Phase 5: FIX

**Cost-routing note:** Phase 5 runs in the parent session context (Opus). For batch
fix work (≥5 files or ≥100 lines total), dispatch to `@sonnet-execute` via the
`implement-feature` or relevant `fix-*` skill — this routes the heavy edit volume
to Sonnet rates while keeping orchestration here. For isolated single-file fixes,
edit inline (Opus rates, but tiny scope).

Apply fixes for each item flagged in Phase 3, in priority order:

**Priority 1 — Blocking (tsc errors, hook-utils failure):**
Fix first. Each fix gets its own commit:

```bash
git add <specific-files>
git commit -m "fix(<scope>): <what> after CC vX.Y.Z upgrade"
```

**Priority 2 — harness-internals.md update:**

Update `docs/harness-internals.md`:

1. Change the version stamp on line 1:
   `Last verified against: v<NEW_VER> (<TODAY_DATE>). Source: ...`
   Append the new version to the release notes list at the end of that line.

2. Add a new section `## 6c. v<NEW_VER> Notable Changes` (or increment the letter — follow the existing pattern). List each notable change from the release notes that affects our hooks, agents, or workflow.

3. Update any stale rows in the hook event table (Section 2), feature flag table (Section 8), or GrowthBook table (Section 9) if the release notes confirm changes.

4. Update "Future Work" table (Section 10) — mark items DONE if the new version ships them natively.

Commit:

```bash
git add docs/harness-internals.md
git commit -m "docs(harness): update to v<NEW_VER> — <brief summary of key changes>"
```

**Priority 3 — Agent frontmatter and settings.json fixes:**

For each stale frontmatter field: Edit the relevant agent `.md` file using Write (full rewrite to avoid corruption). Commit per agent file.

For settings.json changes: Edit `.claude/settings.json`. Commit separately.

**Priority 4 — Hook event wiring:**

For new events worth wiring: note them but do NOT wire automatically. Add to the "Future Work" section of harness-internals.md and report to user for decision.

For retired events still wired: remove from `.claude/settings.json` hook bindings. Commit.

If `--dry-run` is set, skip all writes and commits. Report what would change.

---

## Phase 6: VERIFY

Re-run the smoke test suite from Phase 4:

```bash
npx tsc --noEmit 2>&1 | tail -5
npx vitest run 2>&1 | tail -10
node -e "const u = require('./.claude/hooks/hook-utils.cjs'); console.log('hook-utils OK');"
```

Compare against Phase 4 baseline:
- TypeScript errors: must be 0 (or same count if pre-existing and unrelated to upgrade)
- Test counts: must match or improve (no new failures introduced)
- hook-utils.cjs: must be OK

If any new failures appear → diagnose and fix before proceeding. Do not proceed to Phase 7 with new regressions.

---

## Phase 7: STORE

Store a version delta summary in memory:

```
memory_store content="CC upgraded from v<PREV_VER> to v<NEW_VER> on <TODAY_DATE>. Delta: <N> hook events, <N> frontmatter changes, <N> stale refs fixed. Notable: <top 2-3 changes from release notes>. harness-internals.md updated. Tests: <N> passing." importance=0.8 tags=["cc-version","harness","upgrade"]
```

Update the Settings line in `~/.claude/projects/O--Sand-Box-Dev/memory/MEMORY.md`:

Find the line starting with `- Model:` and update the CC version reference from `v<PREV_VER>` to `v<NEW_VER>` (the line currently reads `CC v<PREV_VER> (upgraded...)`).

Print the final audit summary:

```
## CC UPDATE AUDIT — v<PREV_VER> → v<NEW_VER> — <TODAY_DATE>

| Phase | Result |
|-------|--------|
| Detect | v<NEW_VER> confirmed |
| Research | <N> releases scanned, <N> relevant changes |
| Impact Scan | <N> stale refs, <N> sections to update |
| Smoke Test (before) | <tsc errors> errors, <N>T/<N>F |
| Fix | <N> commits, harness-internals updated |
| Smoke Test (after) | 0 errors, <N>T/<N>F |
| Store | memory stored, MEMORY.md updated |

### New capabilities to evaluate:
<list any NEW items from Delta Summary that we haven't wired yet — new events, new frontmatter fields, new hookSpecificOutput keys>

### Deferred (Future Work added to harness-internals.md):
<list items noted but not actioned>
```
