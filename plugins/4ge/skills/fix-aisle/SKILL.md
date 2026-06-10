---
name: fix-aisle
description: "AISLE security posture fixes — prompt guard, scanner-cache readiness, shelved gate docs, and threat-management workflows"
model_tier: inherit
tools_needed: Bash, Grep, Glob, Read, Edit, Write, mcp__dev-memory__memory_search, mcp__dev-memory__memory_store
preconditions:
  - docs/reference/aisle-vocabulary.md
memory_tags:
  - aisle
  - security
output_file: _runs/{task-name}.md
---

# fix-aisle

Dispatch on `sonnet-execute` for AISLE posture work. Security judgment calls escalate to the lead.

The historical fail-closed AISLE gate and 9-scanner enforcement path are shelved until the ADR reactivation criteria are met. Do not describe the shelved gate as currently enforcing policy, and do not re-enable fail-closed behavior from this skill alone.

## Workflow

1. `memory_search` for AISLE context and prior scanner changes
2. Vocabulary doc is pre-loaded via CONTEXT_MAP injection
3. Confirm whether the target is plugin-local posture text, active prompt/secret guards, or repo-specific AISLE internals
4. For plugin-local work, update posture docs, command text, HUD/readiness wording, or scanner-cache references without touching host repo internals
5. For repo-specific AISLE internals, inspect the actual current paths before editing; `lib/aisle/` may not exist in every checkout or plugin install
6. Run the narrowest available validation for touched files, such as targeted tests, `node --check`, or scanner self-tests only when the scanner module exists
7. Write report to `_runs/<task-name>.md`

## Constraints

- Scanners must use only Node.js built-ins (zero npm deps in per-tool path)
- Scanner D findings are exception-immune
- Security floor changes require lead review
- Do not claim active fail-closed enforcement while the gate is shelved
- CJS only (.cjs)

## Handoff

- Hook wiring/protocol: dispatch with fix-hook skill on sonnet-execute
- PR-level security review: escalate to lead for review dispatch
- OS capability registration: dispatch with fix-kernel skill on sonnet-execute
