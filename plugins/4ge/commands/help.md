---
description: "4ge plugin glossary, command index, and usage guide. Use: /help for full index, /help <command> for command details, /help hooks, /help skills. Use when asking 'what commands are available', 'how do I use forge', 'what does this plugin do', or 'show me the 4ge commands'."
argument-hint: "[command-name | hooks | skills] or empty for full index"
paths: ["plugins/4ge/**"]
---

# /help

Display the 4ge plugin reference guide.

Parse $ARGUMENTS to determine what to show:

| Pattern | Action |
|---------|--------|
| (empty) | Show the Guided Help Hub menu (see "Empty Args" below); the Glossary leaf builds the full index |
| `hooks` | List the plugin hooks and what they do (see Hooks section) |
| `skills` | List all plugin skills with descriptions (read `${CLAUDE_PLUGIN_ROOT}/skills/` directory) |
| `<command-name>` | Read `${CLAUDE_PLUGIN_ROOT}/commands/<command-name>.md` and display its description, arguments, and usage |

For the `<command-name>` pattern: if the file does not exist, report: "Unknown command '`<command-name>`'. Run `/help` to see all available commands."

---

## Empty Args: Guided Help Hub

When `$ARGUMENTS` is empty, show the Learn hub menu instead of dumping the index unprompted. Render a cheap status strip, then use `AskUserQuestion` as the native menu shell. The menu routes into existing learn surfaces; Glossary is the full command index.

### HUD strip

1. If `_runs/os/boot-status.json` exists, read it and `_runs/os/health.json`, merge into `{ ...bootStatus, health: healthJson }`, then pipe to `node plugins/4ge/bin/hud-engine.cjs --mode=strip`.
2. If the OS files are missing, print `4ge plugin help` and continue to the menu.

### Menu round 1

Call `AskUserQuestion` with one question:

```text
question: "What do you want to learn?"
header: "Help"
options:
- Glossary (Recommended): show the full command index (Glossary section below).
- 5-step tour: route to /tour.
- Recent releases: route to /releases.
```

After a selection, dispatch exactly as if the operator had typed the direct command. For "Glossary", build the full index below. Preserve direct-command semantics.

## Glossary: Full Index

When the Glossary leaf is selected (or `/help` is invoked with no menu available), build the index dynamically:

1. Read all `.md` files in `${CLAUDE_PLUGIN_ROOT}/commands/` using Glob
2. For each file, extract the `description` and `argument-hint` from YAML frontmatter
3. Format as the reference below, replacing the Commands table with live data

Display this structure:

### What is 4ge?

4ge is a unified CLI plugin for Claude Code that provides forge orchestration, OS operations, and capability routing. It ships as an installable plugin — all commands below become available via `/command-name` after install.

### Commands

Render a table from the discovered commands:

| Command | Description | Args |
|---------|-------------|------|
| `/command` | (from frontmatter `description`) | (from frontmatter `argument-hint`) |

Sort alphabetically by command name. Include all commands found in the directory.

### Delivery Workflow

The typical development flow using 4ge commands:

```
/forge <task>          Build with multi-teammate orchestration
  |
/commit <msg>          Commit with pre-flight checks (tsc + eslint + vitest)
  |
/ship <msg>            ...or commit + push in one step
  |
/pr <title>            ...or commit + push + open PR in one step
  |
/releases              See what shipped (release notes from recent sessions)
```

### Forge Phases

`/forge` runs a 7-phase workflow:

1. **Scope** — Define boundaries, acceptance criteria
2. **Brainstorm** — Explore approaches, evaluate tradeoffs
3. **Spec** — Write a design document
4. **Plan** — Break into phased tasks with dependencies
5. **Execute** — Dispatch teammates (agents) for parallel implementation
6. **Integrate** — Merge worktrees, resolve conflicts, verify
7. **Ship** — Final verification, commit, push/PR

### Hooks

The plugin ships these hooks:

| Hook | Event | Purpose |
|------|-------|---------|
| `forge-prompt-lint` | PreToolUse (Agent) | Validates agent prompts during forge sessions |
| `forge-scope-check` | PreToolUse (Write/Edit) | Warns on file writes outside the forge session's declared scope |
| `forge-heartbeat` | PostToolUse (all) | Tracks forge session progress and phase transitions |
| `file-integrity-guard` | SessionStart + PostToolUse (Write/Edit/Bash) | Boots file integrity baseline, tracks changes, verifies on git operations |
| `dfe-post-edit` | PostToolUse (Write/Edit) | Suggests `/dfe` review after 10+ code edits in a session |
| `hud-reactive` | PostToolUse (broad) | Companion activity signaling — face reacts to tool usage |
| `whats-new` | SessionStart | Shows changelog highlights after version updates |
| `telemetry-session` | SessionStart + Stop | Tracks session duration and tool usage metrics |
| `checkpoint-buddy` | Stop | Trust score progression — increments on successful sessions |

Forge hooks fast-exit (no-op) when no `.forge-session.json` exists. `file-integrity-guard` and `dfe-post-edit` are always active.

### Tips

- **First time?** Start with `/blueprint setup` to bootstrap your project, then `/forge <task>` to build something.
- **Memory available?** `/recall` searches the dev-memory hub. Use 2-4 word queries for best results.
- **Need a deep audit?** `/audit full` runs all 10 domains. `/audit quick` does a fast pass.
- **Autoresearch** runs measurement loops that improve over time — start with `/autoresearch status` to see active domains.
- **Command details:** Run `/help <command>` to see the full spec for any command.

---

## Skills (for /help skills)

Read the `${CLAUDE_PLUGIN_ROOT}/skills/` directory. For each subdirectory containing a `SKILL.md`, extract the `name` and `description` from YAML frontmatter. Display as a table:

| Skill | Description |
|-------|-------------|
| (from frontmatter `name`) | (from frontmatter `description`) |

If the `skills/` directory does not exist or is empty, report: "No skills are currently bundled with this plugin. Skills provide specialized workflows — they'll appear here as the plugin grows."
