# /4ge — Agentic OS for Claude Code

Ship safer code with fewer context switches. The production layer for Claude Code — memory, orchestration, review, and security in one plugin.

## Install

```bash
claude plugin install 4ge@turd-box
```

Or add the marketplace first, then install:

```bash
# Add the marketplace (one time)
claude plugin marketplace add turdpusher360/turd-box

# Install the plugin
claude plugin install 4ge@turd-box
```

---

## What It Does

**Your AI can review its own work.** When invoked, DFE runs 6 specialized review passes (5 domain passes + 1 adversarial pass). The edit hook prompts you to run it after sustained changes; it does not silently run the full panel on every edit. Single-pass reviewers do one pass. DFE does six, and the last one actively tries to break what the first five approved.

**Security posture where the agent works.** AISLE routes security posture, scans, and threat-management workflows inside Claude Code. The historical fail-closed 9-scanner gate is intentionally shelved until the ADR reactivation criteria are met; active protection currently comes from prompt, scope, file-integrity, and secret-handling guards.

**One plugin, four jobs in one place.** Many teams pay separately for code review, a security-posture tool, persistent dev memory, and multi-agent orchestration — comparable standalone tools commonly run $12–$25/mo each (illustrative list prices, not a guaranteed substitution). 4ge bundles all four into one Claude Code plugin. 4ge Pro: $19/mo. One install.

---

## Commands

| Command | Tier | Description |
|---------|------|-------------|
| `/help` | Free | Command index and usage guide |
| `/map` | Free | Redirect → `/recall --map` (repository map) |
| `/recall` | Free | Guided Knowledge hub — memory search, repo map, budget (or `/recall <query>` for dev-memory search) |
| `/debug` | Free | Systematic root-cause analysis |
| `/recon` | Free | Redirect → `/recall` (memory + repo mapping) |
| `/hud` | Free | Toggle the OS HUD status pane |
| `/fix` | Free | Capture maintenance issues without interrupting flow |
| `/tour` | Free | 5-step guided walkthrough for new users |
| `/4ge` | Pro | 4ge ecosystem command — Forge orchestration + OS operations |
| `/forge` | Pro | Multi-agent orchestrator: brainstorm → spec → plan → execute → ship |
| `/dfe` | Pro | 6-pass adversarial code review |
| `/ship` | Pro | Verify, commit, and push — full delivery pipeline |
| `/audit` | Pro | Code quality audit — 70 checks across 10 domains |
| `/aisle` | Pro | AI security posture, scanning, and threat management |
| `/blueprint` | Pro | Bootstrap or update a Claude Code environment |
| `/commit` | Pro | Redirects to `/ship`; use `/ship --no-push` to commit without pushing |
| `/pr` | Pro | Verify, commit, push, and open a PR |
| `/infra` | Pro | Docker container health monitoring |
| `/maintain` | Pro | Legacy redirect to `/outhouse` |
| `/outhouse` | Pro | Repository maintenance wizard |
| `/autoresearch` | Pro | Self-improving measurement loops |
| `/wizard` | Pro | Repository maintenance wizard |
| `/respawn` | Pro | Context Respawn — decision chain preservation |
| `/hitchhiker` | Pro | Redirect → `/recall` (knowledge search) |
| `/export` | Pro | Export session work as brief/deck/handoff |
| `/substrate` | Pro | Unicode composition engine |
| `/studio` | Pro | Full HUD engine + reactive hooks |
| `/evolve` | Pro | Analyze usage and suggest config improvements |
| `/signoff` | Pro | Enrich session cartridge before ending |
| `/releases` | Pro | Recent release notes |
| `/decide` | Pro | Log a decision to the DCD enrichment file |
| `/constraint` | Pro | Log a constraint/dead-end |
| `/lint` | Pro | Show rule follow-through rates and suggest demotions |
| `/lounge` | Pro | Legacy redirect; use `--lounge` on another command |
| `/resp4wn` | Pro | Legacy redirect to `/respawn` |

---

## Examples

### Start a feature with multi-agent orchestration

```
/forge add user authentication with JWT and refresh tokens
```

Forge runs a 7-phase pipeline: scope → brainstorm → spec → plan → execute → integrate → ship. Dispatches specialized agents in parallel. Returns a PR-ready branch.

### Run adversarial code review before pushing

```
/dfe --staged
```

Runs 5 domain passes (existence, security, logic, runtime, artifacts) plus 1 adversarial pass. Catches what a single-pass reviewer misses.

### Search your memory hub across sessions

```
/recall overlay WebSocket auth
```

`/recall` runs dev-memory search directly, retrieving stored context from your dev-memory hub. Persistent across sessions — Claude actually remembers your architecture decisions.

### Ship your current branch

```
/ship
```

Runs `tsc`, `eslint`, and `vitest`. Generates a commit message from the diff. Pushes. Creates a PR if you add `/pr` instead.

### Get your security posture

```
/aisle scan
```

AISLE reports current security posture and routes scans for supply chain integrity, credential exposure, privilege escalation paths, and prompt injection vectors. Scans and guards are advisory (warn-only) — nothing blocks; the fail-closed gate is shelved per ADR-SEC-001.

---

## Pricing

|  | Free | Pro | Team |
|--|------|-----|------|
| **Price** | $0 | $19/mo | $39/seat/mo |
| **Annual** | — | $190/yr | $390/seat/yr |
| **Commands** | Core | All Pro | All Pro + admin |
| **DFE Review** | — | 3-pass | Full 6-pass adversarial |
| **Forge Orchestration** | — | 7-phase pipeline | + shared context |
| **AISLE Security** | — | Posture + scans | Posture + policy roadmap |
| **Memory** | Local only | Local | Local + hosted (shared team namespace) |
| **Autoresearch** | — | Personal domains | Team-wide measurement |
| **Blueprint** | — | Single project | Fleet management |
| **Support** | Community | Email | Priority SLA |

**Install free. Upgrade when you ship.**

Upgrade: `https://4ge.dev/pro`

---

## Requirements

- Claude Code (Pro $20/mo or Max $100/mo, or API access)
- Git

Optional infrastructure (commands degrade gracefully when absent):

| Dependency | Commands |
|-----------|----------|
| Docker + GPU | `/recall`, `/hitchhiker` (local memory) |
| dev-memory MCP | Memory hub features |
| Agentic OS boot | `/infra`, `/autoresearch` |

---

## License

**FSL-1.1-MIT** — free to use, modify, and share for non-competing purposes. Automatically converts to MIT on April 10, 2028.

Files installed by Blueprint into your repositories are **MIT immediately** — the FSL applies to the plugin source, not its installed output.

See [LICENSE](./LICENSE) for full terms.

---

## Links

- [GitHub](https://github.com/Turdpusher360/turd-box)
- [Changelog](./CHANGELOG.md)
- [Issues](https://github.com/Turdpusher360/turd-box/issues)
