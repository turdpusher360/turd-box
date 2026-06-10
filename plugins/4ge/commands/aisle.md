---
description: "[AISLE] AI Security Learning Environment -- security posture, scanning, and threat management"
argument-hint: "'scan', 'report', 'health', 'quarantine', 'config', 'learn', or empty for posture summary"
paths: ["plugins/4ge/**", "lib/aisle/**", "lib/os/**", ".claude/**", "_runs/**"]
---

## [AISLE] Security Command

Before producing any output, read `${CLAUDE_PLUGIN_ROOT}/skills/wizard-engine/references/output-format.md` for formatting rules.

**Output components:** 8 (Status Table)

Routes to the `aisle` OS capability. Check `_runs/os/boot-status.json` before invoking --
if OS is not booted, suggest running a session with os-boot enabled.

### Arguments

| Pattern | Action |
|---------|--------|
| (empty) | `os.invoke('aisle', 'health')` -- posture summary |
| scan | `os.invoke('aisle', 'scan', { target: 'all' })` |
| scan \<A-I\> | `os.invoke('aisle', 'scan', { target: '<class>' })` |
| report | `os.invoke('aisle', 'report')` |
| health | `os.invoke('aisle', 'health')` |
| quarantine list | `os.invoke('aisle', 'quarantine', { subcommand: 'list' })` |
| quarantine release \<id\> | `os.invoke('aisle', 'quarantine', { subcommand: 'release', id: '<id>' })` |
| quarantine undo-all | `os.invoke('aisle', 'quarantine', { subcommand: 'undo-all' })` |
| config | Show current aisle-config.json contents |
| config set \<key\> \<value\> | Update config (validates against schema) |
| learn \<id\> fp | `os.invoke('aisle', 'learn', { findingId: '<id>', feedback: 'fp' })` |
| learn \<id\> tp | `os.invoke('aisle', 'learn', { findingId: '<id>', feedback: 'tp' })` |
| relocate | Interactive wizard to move state directory |

### Implementation Notes

These `os.invoke()` calls are pseudocode directives for the LLM interpreter.
The LLM translates these to concrete Bash subprocess calls or Agent spawns at runtime.
There is no `os` object in scope -- this is an instruction file, not executable code.

### First Boot

If AISLE state is `setup-required` (no aisle-config.json exists):
1. Present the setup wizard with 3 stateDir options:
   - **Out-of-repo** (recommended): `~/.claude/projects/<project>/aisle/`
   - **In-repo**: `.aisle/` (gitignored) -- WARNING: vulnerable to state poisoning
   - **Custom**: user-specified path (boundary-validated)
2. Generate initial config with default tiers (all WARN for Phase 0)
3. Create state directory with required subdirectories
4. Generate HMAC secret for integrity verification
5. Transition to operational state

### Fallback

If the AISLE capability is not registered (OS not booted or aisle.cjs not discovered),
spawn `@opus-audit` with the `audit-security` skill for manual security review instead.
