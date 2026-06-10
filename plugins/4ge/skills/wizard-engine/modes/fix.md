---
name: fix
description: "Inline issue collector -- capture issues for the next maintenance wizard run without interrupting workflow"
execution-model: capture
pipeline-stages: []
---

# Fix Mode (Issue Collector)

Before producing any output, read `${CLAUDE_PLUGIN_ROOT}/skills/wizard-engine/references/output-format.md` for formatting rules.

**Primary output component:** 7 (Confirmation Card) — use this format for the fix capture confirmation.

Lightweight inline capture. No wizard flow, no menus, no interruption. The issue is tagged and stored immediately.

## Behavior

Parse `$ARGUMENTS` as a free-text issue description.

If empty: display usage help and exit.

```
Usage: /fix <description>

Examples:
  /fix agent-staleness check missed 3 agents
  /fix hook-perf: pre-write-check.cjs taking >200ms
  /fix missing test for os-boot happy path
```

## Auto-Tagging

Match the description against keyword rows (first-row-wins):

| Keywords | Category |
|----------|----------|
| branch, stale, merge, worktree | branches |
| dep, dependency, vuln, npm, package | dependencies |
| agent, staleness, frontmatter, maxTurns | agents |
| hook, perf, performance, wiring, stdin | hooks |
| test, vitest, coverage, baseline, flaky | tests |
| config, settings, schema, version, sync | config |
| dead, unused, orphan, ghost, todo | dead_code |
| doc, docs, README, CLAUDE.md, handoff | docs |
| security, pin, sentinel, AISLE, secret | security |

If no keywords match, tag as `uncategorized`.

## Storage

Append one JSON line to `.4ge-wizard-inbox.jsonl` at project root:

```json
{"ts":"<ISO-8601>","description":"<user description>","category":"<auto-tagged>","source":"manual","status":"open"}
```

This file should be in `.gitignore` (session-scoped transient data).

## Confirmation

After storing:

Display the capture confirmation using Component 7 (Confirmation Card) format from output-format.md:

```
  Captured  "<description>"
  Tagged    <category>
  Status    open -- appears in next /outhouse run
  Inbox     N items (M open)
```

**Follow-up suggestion:** After the confirmation card, display a contextual suggestion based on inbox state:

- If inbox has 5+ open items in the same category: `"Inbox has N items in <category>. Run /outhouse --category <category> to address."`
- If inbox has 3+ total open items but no category has 5+: `"Inbox has N open items. Run /outhouse to address."`
- Otherwise: no suggestion (avoid noise for low item counts).

## Auto-Capture

Beyond manual `/fix` submissions, issues can be auto-captured from:
- Hook failures (PostToolUseFailure event, if wired)
- Verification failures (Stage 6 verify step)
- Session-audit findings (session end)

Auto-captured items have `"source": "auto"` and descriptions truncated to 200 characters (to limit error message leakage).

## Inbox Management

The inbox is consumed at Stage 1 (SCAN) of the maintenance wizard. Items are:
- Mapped to their tagged category
- Factored into category scores (-1 deduction per open item)
- Displayed in the fix menu under the "INBOX" section
- Marked as `"status": "applied"` or `"status": "dismissed"` after the wizard run

Items older than `max_age_days` (default 30) are auto-purged.

## Auto-Promote

Recurring issues (same category + similar description 3+ times) are auto-promoted to `[suggested]` in the fix menu. Auto-promote can never elevate to `[recommended]` -- that tier requires research-grounded confidence.
