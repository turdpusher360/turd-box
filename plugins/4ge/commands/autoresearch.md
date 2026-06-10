---
description: "Run autoresearch — self-improving measurement loops. Use: /autoresearch <domain>, /autoresearch sweep, /autoresearch status, /autoresearch heal <domain>"
argument-hint: "domain name, 'sweep', 'status', or 'heal <domain>'"
paths: ["plugins/4ge/**", "scripts/autoresearch/**", "_runs/**"]
---

# /autoresearch

Check if `scripts/autoresearch/harness.cjs` exists. If not, report: "Autoresearch harness not found. Requires `scripts/autoresearch/` directory with domain configs and measures."

Parse $ARGUMENTS:

| Pattern | Action |
|---------|--------|
| `status` | List all domain configs from `scripts/autoresearch/domains/*.json`, count experiments in `_runs/autoresearch/*/experiments.jsonl`, show last run date and metric for each |
| `sweep` | Run `node scripts/autoresearch/measures/<domain>.cjs` for all domains in parallel, collect results, display as table |
| `heal <domain>` | Delete last discarded experiment from `_runs/autoresearch/<domain>/experiments.jsonl`, then run one iteration |
| `<domain>` | Run one autoresearch iteration: read domain config, load experiment history, measure current baseline, form hypothesis, edit targets, re-measure, keep or discard |
| (empty) | Same as `status` |
