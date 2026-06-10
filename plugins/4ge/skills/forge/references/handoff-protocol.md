# Handoff Protocol

Teammates report their status using one of four states. The lead uses this to decide next actions.

## Teammate Status States

| State | Meaning | Lead Action |
|-------|---------|-------------|
| **DONE** | Task complete, all checks pass | Proceed to next dependent task |
| **DONE_WITH_CONCERNS** | Task complete but with caveats | Review concerns, decide if blocking |
| **BLOCKED** | Cannot proceed, needs intervention | Check auto-retry rules, then escalate |
| **NEEDS_CONTEXT** | Missing information from another teammate | Route the question, provide context |

## Handoff Message Format

Teammates send their status via the summary message (after writing full output to `_runs/`):

```
STATUS: [DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT]
TASK: [task ID and title]
FILES_CHANGED: [list of files created/modified]
CONCERNS: [if DONE_WITH_CONCERNS -- list concerns]
BLOCKED_REASON: [if BLOCKED -- exact error message]
NEEDS: [if NEEDS_CONTEXT -- what information is needed and from whom]
```

## Lead Decision Tree on BLOCKED

1. Check auto-retry rules (see integration-protocol.md)
2. If auto-retryable: retry once with fix context
3. If not retryable or retry failed: surface to human with both error messages
