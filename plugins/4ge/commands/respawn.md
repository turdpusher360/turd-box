---
description: "Extract decision chain and prepare a fresh Claude instance with full context"
argument-hint: "optional: 'dry-run' to preview DCD without writing"
paths: ["**"]
---

# /respawn

Extract the Decision Chain Document (DCD) from the current session and prepare instructions for spawning a fresh Claude Code instance with full context continuity.

## Step 1: Extract DCD

Run a Bash command to invoke the dcd-extract module:

```bash
node -e "
const { extractDCD, writeDCD } = require('./.claude/hooks/checks/dcd-extract.cjs');
const result = extractDCD({ cwd: process.cwd(), trigger: 'respawn' });
writeDCD(process.cwd(), result.content);
console.log(JSON.stringify(result.metadata));
"
```

## Step 2: Report Results

Display:
- Token count estimate of the DCD
- Number of decisions and constraints captured
- File paths written

## Step 3: Provide Respawn Command

If $ARGUMENTS is NOT "dry-run":

```
[Context Respawn] Decision chain extracted ({decisionCount} decisions, {constraintCount} constraints)
[Context Respawn] Saved to: _runs/decision-chain-latest.md

To continue in a fresh instance, run:

  claude --append-system-prompt-file _runs/decision-chain-latest.md

Or with cswap:

  cswap respawn

After the new session starts, run /reload-plugins to ensure all plugin commands are available
(custom marketplace plugins may not load on sessions started via --append-system-prompt-file).
```

If $ARGUMENTS is "dry-run":

Display the DCD content without writing and do not print the respawn command.
