---
description: "Autoresearch measurement plane — read-only status and scans of the repo's measures. Use: /autoresearch status, /autoresearch scan, /autoresearch <domain>"
argument-hint: "'status' (default), 'scan', or a domain name"
paths: ["plugins/4ge/**", "scripts/autoresearch/**", "_runs/**"]
---

# /autoresearch

Autoresearch is the repo's measurement plane. Each config in `scripts/autoresearch/domains/` names a measure whose script prints one metric as JSON, graded against the config's `metric.threshold` in its `metric.direction` (`higher` or `lower`). This command reads measurements. It never edits files, commits or writes proposals; a red domain gets fixed in an ordinary session.

Check if `scripts/autoresearch/harness.cjs` exists. If not, report: "Autoresearch harness not found. Requires `scripts/autoresearch/` directory with domain configs and measures."

Parse $ARGUMENTS:

| Pattern | Action |
|---------|--------|
| `status` | Run `node scripts/autoresearch/harness.cjs --status`. It prints, per domain, the experiment count, the latest baseline metric, the last run and the graded status: `AT_THRESHOLD`, `ACTIVE` (measured, not yet at threshold), `NOT_STARTED` (never measured), `SUSPENDED`, `PROXY_PASS` or `DEEP_FAIL`. It only reads. |
| `scan` | Run `node scripts/autoresearch/harness.cjs --scan`. It measures every active domain, then writes `_runs/os/measure-status.json`, one baseline row per measured domain in `_runs/autoresearch/<domain>/experiments.jsonl`, and one line in `_runs/autoresearch/scan-log.jsonl` (all gitignored). It takes several minutes, the `dep-*` measures call `npm audit` over the network, and a second scan refuses while one holds `_runs/os/.measure-scan.lock`. It prints the totals and the red list. |
| `<domain>` | Read `scripts/autoresearch/domains/<domain>.json` and run its `metric.command` from the repo root (usually `node scripts/autoresearch/measures/<domain>.cjs`). It prints one JSON line: a `metric` to grade against `metric.threshold` and `metric.direction`, or `skip: true` or `error` with the reason. Nothing is written. |
| (empty) | Same as `status` |

Report the result as a table (domain, metric, threshold and direction, status) and name each domain that is not at threshold.

The harness still carries the old experiment phases (`measure`, `plan`, `remeasure`, `deep`, `commit`, `revert`, `abort`, `unlock`) and the V1 `--baseline` / `--hypothesis` loop. They are retired from this command, and their code leaves the harness in a later phase of the measurement-plane redesign. Do not run them from here. `heal` is retired too.
