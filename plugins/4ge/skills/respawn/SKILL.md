---
name: respawn
description: "Context Respawn — extract decision chain, write DCD, prepare fresh instance with continuity"
tools: Bash, Read, Write
effort: low
paths: ["**"]
disable-model-invocation: true
---

# respawn -- Context Respawn Workflow

Extract the Decision Chain Document (DCD) from the current session and prepare a fresh Claude Code instance.

## When to Use

- Context at 70%+ utilization (warned by context-usage-warn check module)
- After auto-compact fires and you notice degraded reasoning
- At natural breakpoints in long implementation sessions
- When the session has accumulated >5 decisions worth preserving

## Step 1: Extract DCD

Run the extraction module to capture the current decision chain:

```bash
node -e "
const { extractDCD, writeDCD } = require('./.claude/hooks/checks/dcd-extract.cjs');
const result = extractDCD({ cwd: process.cwd(), trigger: 'respawn' });
writeDCD(process.cwd(), result.content);
const meta = result.metadata;
console.log('[Context Respawn] DCD extracted:');
console.log('  Branch: ' + meta.branch);
console.log('  Phase: ' + (meta.phase || '(none)'));
console.log('  Decisions: ' + meta.decisionCount);
console.log('  Constraints: ' + meta.constraintCount);
console.log('  Active files: ' + meta.fileCount);
"
```

## Step 2: Verify DCD Content

Read the generated DCD to verify quality:

```bash
cat _runs/decision-chain-latest.md
```

Verify it contains:
- YAML frontmatter with `description`, `type: session`, `paths: ["**"]`
- Active files section
- Decisions section with rationale
- Next action

## Step 3: Present Respawn Options

Print the following to the user:

```
=== Context Respawn: Respawn Ready ===

DCD saved to: _runs/decision-chain-latest.md

Option A (manual):
  claude --append-system-prompt-file _runs/decision-chain-latest.md

Option B (cswap):
  cswap respawn

Option C (continue here):
  The DCD is also at .claude/rules/_decision-chain.md and will
  survive the next auto-compact event automatically.

NOTE: After the new session starts, run /reload-plugins to ensure
all plugin commands load (custom marketplace plugins may not resolve
on sessions started via --append-system-prompt-file).
===
```

## Step 4: Commit Checkpoint (Optional)

If there are uncommitted changes, suggest committing before respawning:

```bash
git status --short
```

If changes exist, suggest: "Consider committing before respawn to ensure no work is lost."
