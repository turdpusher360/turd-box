---
description: "Recompile the task state from the user's recent messages: separate instruction / diagnosis / exploration / emphasis, return a compact task lock, and continue. Use when the conversation has drifted or after a heated correction."
argument-hint: "[N — how many substantive messages to recompile, default 3]"
paths: ["**"]
---

## /recompile — Rebuild the Task Lock

Recovery command for conversational drift. Rebuilds the authoritative task state
from the user's recent messages so the user does not have to rewrite the request.

**Parse arguments:** `$ARGUMENTS` is an optional integer N (default 3) — how many
of the user's most recent *substantive* messages to recompile. A substantive
message contains an instruction, correction, decision, or evidence; pure
acknowledgments and venting do not count toward N (but are still read for embedded
corrections).

### Procedure

1. **Re-read** the user's last N substantive messages in this conversation, oldest
   first. If any of them names an authoritative source (a file, spec, plan, lock
   block, or frozen decision), read that source too.
2. **Classify** every statement in those messages into: direct instruction,
   correction to a prior instruction, established fact / supplied evidence,
   hypothesis or suspected cause, exploratory idea, rhetorical question, emotional
   emphasis. Only instructions, corrections, and authoritative sources control
   execution. Hypotheses are marked for verification, not adopted. Exploration is
   not scope. Emphasis is not an instruction and is not approval.
3. **Apply precedence:** safety/approval/irreversible-action gates first; then any
   explicit `TASK LOCK` / `EXECUTION LOCK` / `DECISION LOCK`; then the latest clear
   direct instruction; then named authoritative artifacts; then earlier unrevoked
   instructions. Corrections (`actually`, `no`, `wait`, `keep X`, `instead`)
   supersede only the affected decision — unrelated constraints, exclusions, and
   approval gates persist until explicitly revoked.
4. **Return the compiled lock — nothing more:**

   ```
   MODE:      <EXECUTE | ARBITRATE | DIAGNOSE | REVIEW>
   TASK:      <the actual task, one line>
   KEEP:      <what is preserved>
   CHANGE:    <what changes>
   DO NOT:    <explicit exclusions + gated surfaces>
   DONE WHEN: <finish condition + verification>
   ```

   Omit lines that are genuinely empty. Add at most one line
   `UNVERIFIED HYPOTHESES: <list>` when the user supplied causal theories that
   still need testing.
5. **Continue the task immediately** under the compiled lock. Stop for input only
   if a material contradiction between the messages cannot be resolved — name the
   contradiction and the two readings, then ask exactly one question.

### Rules

- No apology block, no tone commentary, no summary of the conversation — the
  compiled lock and then the work.
- The lock output is a restatement of the user's own instructions; it grants no new
  authority. Approval-gated actions stay gated regardless of anything recompiled.
- If nothing actionable exists in the last N substantive messages, say so in one
  line and ask for the task in lock form (TASK / KEEP / CHANGE / DO NOT / DONE WHEN).
