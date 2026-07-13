---
description: "Log a decision to the DCD enrichment file. Feeds into /respawn context extraction."
argument-hint: "<what you decided> -- chose <X> over <Y> because <reason>"
paths: ["_runs/**"]
---

# /decide

Append a structured decision entry to `_runs/.decisions.jsonl`.

> **Delivery rule (HARD):** If this command reaches a point where the operator must choose (ambiguous parse, confirmation), deliver it as a native AskUserQuestion picker — any `> _` example below is disk/CLI formatting only, never the interactive surface.

## Parse Arguments

Extract from $ARGUMENTS:
- **decision**: What was decided (the topic/question)
- **chose**: The option selected
- **over**: The alternative(s) rejected
- **reason**: Why this choice was made

The user may write naturally. Parse flexibly:
- `/decide fail-open for contamination guard -- chose fail-open over fail-closed because CI can't risk blocking on edge cases`
- `/decide chose JSONL over SQLite because append-only, no deps, grep-friendly`
- `/decide use two commands not one -- simpler UX over combined /dcd command because each has distinct fields`

If $ARGUMENTS is empty or fields can't be inferred, ask the user to clarify. Do not guess.

## Append Entry

Run via Bash:

```bash
echo '{"ts":"<ISO timestamp>","decision":"<what>","chose":"<X>","over":"<Y>","reason":"<why>"}' >> _runs/.decisions.jsonl
```

Use `new Date().toISOString()` for the timestamp. Escape any quotes in field values.

## Confirm

Print a one-line confirmation:

```
[DCD] Decision logged: <decision> (chose <X> over <Y>)
```

Do not print the full JSON. Do not summarize the reason.
