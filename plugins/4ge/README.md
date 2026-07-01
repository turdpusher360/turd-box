# /4ge — Agentic OS for Claude Code

Ship safer code with fewer context switches. The production layer for Claude Code — memory support, orchestration, review, and security in one plugin.

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

**One plugin, four jobs in one place.** Many teams pay separately for code review, a security-posture tool, persistent dev-memory infrastructure, and multi-agent orchestration — comparable standalone tools commonly run $12-$25/mo each (illustrative list prices, not a guaranteed substitution). 4ge bundles those workflows into one Claude Code plugin. 4ge Pro: $19/mo. One install.

### Forge 3 board compatibility (Anvil)

`/4ge` now emits Forge 3-compatible board state at:

- `_runs/forge-board/latest.json`
- `_runs/forge-board/current/<session-id>.json`
- `_runs/forge-board/history/index.json`

Compatibility commands:

- `/4ge mode code|review|ship|maintain` — write operating intent into the shared board
- `/4ge board` / `/4ge board history` / `/4ge board refresh`
- `/4ge projections advisory|auto-at-stop-lines`

This is state-compatibility scaffolding for Anvil and does **not** replace existing CLI workflows.

---

## Commands

| Command | Tier | Description |
|---------|------|-------------|
| `/4ge` | Free | 4ge ecosystem command — Forge orchestration + OS operations |
| `/help` | Free | Command index and usage guide |
| `/map` | Free | Redirect → `/recall --map` (repository map) |
| `/recall` | Free | Guided Knowledge hub — memory search, repo map, budget (or `/recall <query>` for dev-memory search) |
| `/debug` | Free | Systematic root-cause analysis |
| `/recon` | Free | Redirect → `/recall` (memory + repo mapping) |
| `/hud` | Free | Toggle the OS HUD status pane |
| `/fix` | Free | Capture maintenance issues without interrupting flow |
| `/tour` | Free | 5-step guided walkthrough for new users |
| `/ship` | Free | Verify, commit, and push — full delivery pipeline |
| `/commit` | Free | Redirects to `/ship`; use `/ship --no-push` to commit without pushing |
| `/pr` | Free | Verify, commit, push, and open a PR |
| `/blueprint` | Free | Bootstrap or update a Claude Code environment |
| `/infra` | Free | Docker container health monitoring |
| `/studio` | Free | Full HUD engine + reactive hooks |
| `/substrate` | Free | Unicode composition engine |
| `/decide` | Free | Log a decision to the DCD enrichment file |
| `/constraint` | Free | Log a constraint/dead-end |
| `/signoff` | Free | Enrich session cartridge before ending |
| `/releases` | Free | Recent release notes |
| `/lint` | Free | Show rule follow-through rates and suggest demotions |
| `/lounge` | Free | Legacy redirect; use `--lounge` on another command |
| `/hitchhiker` | Free | Redirect → `/recall` (knowledge search) |
| `/secret` | Free | Capture a secret without exposing its value to model context |
| `/superdupersecret` | Free | Alias of `/secret` |
| `/design` | Free | Contextual design assistant — Visual/API/Data/System modes |
| `/onboard` | Free | First-time repository onboarding scanner |
| `/ps` | Free | Read-only process dashboard for agents, zombies, and OS health |
| `/forge` | Pro | Multi-agent orchestrator: brainstorm → spec → plan → execute → ship |
| `/dfe` | Pro | 6-pass adversarial code review |
| `/audit` | Pro | Code quality audit — 70 checks across 10 domains |
| `/aisle` | Pro | AI security posture, scanning, and threat management |
| `/outhouse` | Pro | Repository maintenance wizard |
| `/wizard` | Pro | Repository maintenance wizard |
| `/maintain` | Pro | Legacy redirect to `/outhouse` |
| `/autoresearch` | Pro | Self-improving measurement loops |
| `/evolve` | Pro | Analyze usage and suggest config improvements |
| `/export` | Pro | Export session work as brief/deck/handoff |
| `/respawn` | Pro | Context Respawn — decision chain preservation |
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

`/recall` runs dev-memory search directly when a dev-memory hub is connected, retrieving stored context across sessions without putting the hub inside the plugin package.

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
| **Commands** | 28 free commands | + Pro machinery | Everything in Pro |
| **DFE Review** | — | Full 6-pass adversarial | Full 6-pass adversarial |
| **Forge Orchestration** | — | 7-phase pipeline | 7-phase pipeline |
| **AISLE Security** | — | Posture + scans | Posture + scans |
| **Blueprint** | Single project | Single project | Single project |
| **Memory** | Local-memory support | Local-memory support | Local + hosted (shared team namespace) |
| **Support** | Community | Email | Priority SLA |

**Launch window:** install free. All commands are available while checkout is closed; pricing is forward guidance for when paid checkout opens.

Upgrade: `https://3sixtyco.dev/4ge`

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

- [GitHub](https://github.com/turdpusher360/turd-box)
- [Changelog](./CHANGELOG.md)
- [Issues](https://github.com/turdpusher360/turd-box/issues)
