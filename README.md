# turd-box — the 4ge plugin for Claude Code

**4ge** is the production layer for Claude Code: multi-agent orchestration, 6-pass
adversarial code review, an advisory security posture (AISLE), persistent
cross-session memory, and a live HUD — delivered as one Claude Code plugin.

This repository is the public marketplace for the 4ge plugin. It contains the
marketplace manifest and the full plugin source under [`plugins/4ge/`](./plugins/4ge/).

---

## Install

```bash
# Add the marketplace (one time)
claude plugin marketplace add turdpusher360/turd-box

# Install the plugin
claude plugin install 4ge@turd-box
```

That's it — `/help` will show the full command index once the plugin loads.

---

## What 4ge is

- **Multi-agent orchestration** — `/forge` runs a 7-phase pipeline (scope →
  brainstorm → spec → plan → execute → integrate → ship) and dispatches
  specialized agents to do the work.
- **Adversarial code review** — `/dfe` runs 6 review passes (5 domain passes +
  1 adversarial pass that actively tries to break what the first five approved).
- **Security posture (advisory)** — `/aisle` reports security posture and routes
  scans for supply-chain integrity, credential exposure, privilege-escalation
  paths, and prompt injection. Scans and guards are **advisory (warn-only)** —
  nothing blocks. The historical fail-closed 9-scanner gate is intentionally
  shelved until its ADR reactivation criteria are met.
- **Agentic OS** — 9 OS capabilities (aisle, audit, autoresearch, file-integrity,
  forge, forge-session, git, infra, process-health) ship vendored inside the
  plugin and boot on session start; the live HUD renders their state.
- **Persistent memory** — `/recall` searches a dev-memory hub across sessions.
  Local memory is available on the Free and Pro tiers; **hosted (shared team
  namespace) memory is a Team-tier feature.**

---

## Tiers

| | Free | Pro ($19/mo) | Team ($39/seat/mo) |
|--|------|--------------|--------------------|
| Commands | Core | All Pro | All Pro + admin |
| DFE Review | — | 3-pass | Full 6-pass adversarial |
| Forge orchestration | — | 7-phase pipeline | + shared context |
| AISLE security | — | Posture + scans | Posture + policy roadmap |
| Memory | Local only | Local | Local + **hosted** (shared team namespace) |
| Blueprint | — | Single project | Fleet management |
| Support | Community | Email | Priority SLA |

Install free; upgrade when you ship → `https://4ge.dev/pro`

---

## Requirements

- Claude Code (Pro, Max, or API access)
- Git

Optional infrastructure (commands degrade gracefully when absent):

| Dependency | Used by |
|-----------|---------|
| Docker + GPU | local memory features |
| dev-memory MCP hub | hosted/shared memory (Team tier) |

---

## License

**FSL-1.1-MIT** — the Functional Source License. Free to use, modify, and share
for non-competing purposes; converts automatically to MIT on the Change Date.
This is **source-available**, not open source. See
[`plugins/4ge/LICENSE`](./plugins/4ge/LICENSE) for full terms. Files installed by
Blueprint into your own repositories are MIT immediately.

## Security & contributing

- Report vulnerabilities privately — see
  [`plugins/4ge/SECURITY.md`](./plugins/4ge/SECURITY.md).
- Contributions are currently closed (CLA-gated) — see
  [`plugins/4ge/CONTRIBUTING.md`](./plugins/4ge/CONTRIBUTING.md).

---

- [Plugin README](./plugins/4ge/README.md)
- [Changelog](./plugins/4ge/CHANGELOG.md)
- [Issues](https://github.com/turdpusher360/turd-box/issues)
