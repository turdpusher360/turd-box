---
description: "Log a constraint/dead-end to the DCD enrichment file. Feeds into /respawn context extraction."
argument-hint: "<what blocked you> -- tried <X>, failed because <Y>, workaround <Z>"
paths: ["_runs/**"]
---

# /constraint

Append a structured constraint entry to `_runs/.constraints.jsonl`.

## Parse Arguments

Extract from $ARGUMENTS:
- **constraint**: What limitation or dead-end was hit
- **tried**: The approach attempted
- **failed**: Why it didn't work
- **workaround**: How you got around it (or "none" if still blocked)

The user may write naturally. Parse flexibly:
- `/constraint template contamination blocks git commit -- tried edit guard, failed because templates propagate via blueprint update, workaround pre-commit hook + quarantine`
- `/constraint tried MCP for localhost health checks -- failed because WebFetch can't reach localhost, workaround curl via Bash`
- `/constraint Agent tool drops writes 4/5 times -- tried background agents, workaround TeamCreate for all write tasks`

If $ARGUMENTS is empty or fields can't be inferred, ask the user to clarify. Do not guess.

## Append Entry

Run via Bash:

```bash
echo '{"ts":"<ISO timestamp>","constraint":"<what>","tried":"<X>","failed":"<Y>","workaround":"<Z>"}' >> _runs/.constraints.jsonl
```

Use `new Date().toISOString()` for the timestamp. Escape any quotes in field values.

## Confirm

Print a one-line confirmation:

```
[DCD] Constraint logged: <constraint> (workaround: <Z>)
```

Do not print the full JSON.
