# turd-box — the 4ge plugin for Claude Code

4ge turns a Claude Code session into a production shop: multi-agent orchestration, six-pass adversarial review, an advisory security layer, persistent cross-session memory, and a live HUD — one plugin, nothing extra to run.

This repository is the public marketplace. The manifest lives at the root; the installable plugin is [`plugins/4ge/`](./plugins/4ge/).

---

## Install

```bash
# Add the marketplace (one time)
claude plugin marketplace add turdpusher360/turd-box

# Install the plugin
claude plugin install 4ge@turd-box
```

If your Claude Code build can't add a remote marketplace directly, clone first:

```bash
git clone https://github.com/turdpusher360/turd-box.git
claude plugin marketplace add ./turd-box
claude plugin install 4ge@turd-box
```

`/help` shows the full command index once the plugin loads.

---

## What you get

**`/forge`** runs the whole arc — scope, brainstorm, spec, plan, execute, integrate, ship — and dispatches specialized agents at each phase instead of asking one context window to hold everything.

**`/dfe`** is the reviewer you'd hire if you could: five domain passes over your changes, then a sixth adversarial pass whose only job is to break what the first five approved. Built for AI-generated code, which fails in ways human review was never calibrated for.

**`/aisle`** reports security posture — supply-chain integrity, credential exposure, privilege-escalation paths, prompt injection. It is advisory by design: it warns, it does not block. A fail-closed nine-scanner gate exists in the codebase and stays shelved until its ADR reactivation criteria are met. We'd rather tell you that than pretend.

**The Agentic OS** boots nine capabilities on session start — aisle, audit, autoresearch, file-integrity, forge, forge-session, git, infra, process-health — vendored inside the plugin, no external services. The HUD renders their live state.

**`/recall`** searches persistent memory across sessions. Local memory ships on every tier; hosted shared-namespace memory is a Team-tier feature.

---

## Tiers

| | Free | Pro ($19/mo) | Team ($39/seat/mo) |
|--|------|--------------|--------------------|
| Commands | 28 free commands | + Pro machinery | Everything in Pro |
| DFE Review | — | Full 6-pass adversarial | Full 6-pass adversarial |
| Forge orchestration | — | 7-phase pipeline | 7-phase pipeline |
| AISLE security | — | Posture + scans | Posture + scans |
| Memory | Local | Local | Local + **hosted** (shared team namespace) |
| Blueprint | Single project | Single project | Single project |
| Support | Community | Email | Priority SLA |

Install free today; Pro pricing applies when checkout opens → `https://3sixtyco.dev/4ge`

---

## Requirements

- Claude Code (Pro, Max, or API access)
- Git

Optional infrastructure — commands degrade gracefully when it's absent:

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
