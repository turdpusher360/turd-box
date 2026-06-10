---
description: "Show recent release notes from shipped sessions"
argument-hint: "optional: session number (e.g. S186) or 'all' for full list"
paths: ["_runs/**"]
---

# /releases

Show release notes from shipped sessions.

## Parse Arguments

| Pattern | Action |
|---------|--------|
| (empty) | Show the most recent release notes file |
| `S<number>` or `<number>` | Show release notes for that session (e.g., `/releases S186`) |
| `all` or `list` | List all available release note files with dates and commit ranges |

## Implementation

1. Glob for `_runs/RELEASE-*.md` files
2. Sort by modification time (newest first)
3. For `all`/`list`: show a table of available releases with filename, date, and first line
4. For a specific session: Read that file and display
5. For empty args: Read the newest file and display

If no release notes found, display: "No release notes found. Use `/ship` or write `_runs/RELEASE-S<num>.md` after shipping commits."
