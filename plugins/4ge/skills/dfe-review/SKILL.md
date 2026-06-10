---
name: dfe-review
description: "Heavyweight 6-pass adversarial review — fans out to 5 domain-minion subagents + 1 synthesis pass for deep/risky changes. For a quick single-pass review use review-adversarial."
tools: Agent, Bash, Read, Glob, Grep, Write
effort: high
paths: ["**"]
disable-model-invocation: true
---

# dfe-review — 6-Pass DFE Orchestrator

Before producing any output, read `${CLAUDE_PLUGIN_ROOT}/skills/wizard-engine/references/output-format.md` for formatting rules.

**Output components:** 3 (Finding Row), 5 (Progress Line), 8 (Status Table)

Orchestrates 5 DFE minion agents in parallel (Tier 1-2), then an adversarial agent (Tier 3), and presents a unified review report.

Claude 4ge `/dfe` is the disk-first multi-agent DFE runner. It is separate from Codex `forge-codex:dfe-review`, which is a Codex-native evidence review skill and must not be described as runtime parity with this Claude command.

**3-Tier Architecture:**
- **Tier 1-2:** 5 domain-specific minions run in parallel — each specialized in one pass (existence, security, logic, runtime, artifacts)
- **Tier 3:** Adversarial review via `DFE` — catches cross-cutting issues minions miss, corrects false positives, finds architectural smells

## Parse $ARGUMENTS

| Pattern | Action |
|---------|--------|
| `all` | Review all tracked reviewable project files (`git ls-files`) |
| `--staged` | Review staged files only (`git diff --cached --name-only`) |
| `--unstaged` | Review unstaged files only (`git diff --name-only`) |
| `<file path>` | Review the specified file(s) only |
| (empty) | Default to unstaged files (`git diff --name-only`) |

## Step 1: Resolve Target Files

Run the appropriate git command from the table above, then filter to reviewable files:

- Extensions: `.ts`, `.tsx`, `.js`, `.cjs`, `.mjs`, `.jsx`, `.py`, `.go`, `.rs`, `.md`
- Exclude: `node_modules/`, `_runs/`, generated build output, vendored third-party output

If no code files found, report: "No code files to review." and exit.

Format the file list as a space-separated string for the minion brief.

## Step 2: Write Lead Brief

Create a brief at `_runs/review/dfe-brief-$DATE.md` using the Write tool:

```
## DFE REVIEW BRIEF — [DATE]
### Target Files
[list files]
### Scope
[brief description of what changed, from git diff --stat]
### Instructions
- Write-first: create output file immediately with PENDING header
- Disk-first: write the full pass report to _runs/review/; inline output is a concise progress/status summary only
- Read minimal files needed (use Grep/Glob before Read)
- Review agents may write their assigned report files, but must not edit source files
- Complete within 150 turns
- Apply systematic debugging: trace data flow before flagging, verify evidence before claiming
```

## Step 3: Dispatch 5 Minions (Tier 1-2)

Use the Agent tool to spawn all 5 minions in parallel as background agents:

```
Agent(subagent_type: "dfe-existence", mode: "bypassPermissions", run_in_background: true, prompt: "Read _runs/review/dfe-brief-$DATE.md. Review the listed files. Write findings to _runs/review/dfe-existence-$DATE.md using the Write tool.")
Agent(subagent_type: "dfe-logic", mode: "bypassPermissions", run_in_background: true, prompt: "Read _runs/review/dfe-brief-$DATE.md. Review the listed files. Write findings to _runs/review/dfe-logic-$DATE.md using the Write tool.")
Agent(subagent_type: "dfe-security", mode: "bypassPermissions", run_in_background: true, prompt: "Read _runs/review/dfe-brief-$DATE.md. Review the listed files. Write findings to _runs/review/dfe-security-$DATE.md using the Write tool.")
Agent(subagent_type: "dfe-runtime", mode: "bypassPermissions", run_in_background: true, prompt: "Read _runs/review/dfe-brief-$DATE.md. Review the listed files. Write findings to _runs/review/dfe-runtime-$DATE.md using the Write tool.")
Agent(subagent_type: "dfe-artifacts", mode: "bypassPermissions", run_in_background: true, prompt: "Read _runs/review/dfe-brief-$DATE.md. Review the listed files. Write findings to _runs/review/dfe-artifacts-$DATE.md using the Write tool.")
```

Wait for all 5 to complete.

## Step 4: Collect Minion Reports

For each minion report at `_runs/review/dfe-{pass}-$DATE.md`:
- Read the file
- Extract verdict (CLEAN / SMELLS / FUCKED) and finding counts (P0/P1/P2/P3)
- Collect all P0 and P1 findings
- Note any findings that seem questionable or potentially false-positive

## Step 5: Dispatch Adversarial Pass (Tier 3)

Dispatch a single `DFE` agent. This agent gets the minion findings as context and reviews with fresh eyes. Its job is to:

1. Find cross-cutting issues that domain-specific passes miss
2. Correct false positives (verify claims against actual code)
3. Identify architectural smells, hallucinated patterns, and AI generation artifacts
4. Check integration points between files that individual passes reviewed in isolation

```
Agent(
  subagent_type: "DFE",
  mode: "bypassPermissions",
  run_in_background: true,
  prompt: "## Adversarial DFE — Tier 3

You are the adversarial DFE reviewer. 5 DFE minions have already reviewed these files.

Read the brief: _runs/review/dfe-brief-$DATE.md
Read the 5 minion reports: _runs/review/dfe-{existence,logic,security,runtime,artifacts}-$DATE.md

Your job:
1. Find cross-cutting issues the minions missed (integration failures, architectural smells, hallucinated patterns)
2. Verify each P0/P1 finding — flag any false positives with evidence
3. Check AI generation artifacts: identical boilerplate that should be abstracted, suspicious variable names, unreachable code
4. Trace data flow across file boundaries that individual passes reviewed in isolation

Apply systematic debugging: trace before flagging, verify before claiming, no guessing.

Write report to: _runs/review/dfe-adversarial-$DATE.md
Format: ## ADVERSARIAL DFE — [VERDICT]
Include: false-positive corrections first, then cross-cutting findings, then per-file findings.
Rate: P0 (blocks correctness), P1 (will cause bugs), P2 (code smell), P3 (nit).
Verdict: CLEAN / SMELLS / FUCKED with confidence percentage."
)
```

Wait for the adversarial pass to complete.

## Step 6: Present Unified Summary

Read the adversarial report at `_runs/review/dfe-adversarial-$DATE.md`, then output a concise consolidated summary inline. The full reports remain on disk under `_runs/review/`:

```
## DFE REVIEW — [OVERALL VERDICT]

### Tier 1-2: Domain Minions
| Pass | Verdict | P0 | P1 | P2 | P3 |
|------|---------|----|----|----|----|
| EXISTENCE  | [verdict] | [n] | [n] | [n] | [n] |
| LOGIC      | [verdict] | [n] | [n] | [n] | [n] |
| SECURITY   | [verdict] | [n] | [n] | [n] | [n] |
| RUNTIME    | [verdict] | [n] | [n] | [n] | [n] |
| ARTIFACTS  | [verdict] | [n] | [n] | [n] | [n] |

### Tier 3: Adversarial
| Pass | Verdict | P0 | P1 | P2 | P3 | FP Corrections |
|------|---------|----|----|----|----|----------------|
| ADVERSARIAL | [verdict] | [n] | [n] | [n] | [n] | [n] |

### False Positives Corrected by Adversarial Pass
[list any minion findings that the adversarial pass determined were false positives, with evidence]

### Action Required (P0 + P1 Findings, deduplicated)
[list P0 and P1 findings with file, title, and fix — deduplicate across all 6 passes]

### Full Reports
- _runs/review/dfe-existence-$DATE.md
- _runs/review/dfe-logic-$DATE.md
- _runs/review/dfe-security-$DATE.md
- _runs/review/dfe-runtime-$DATE.md
- _runs/review/dfe-artifacts-$DATE.md
- _runs/review/dfe-adversarial-$DATE.md
```

**Overall verdict rules:**
- Any P0 finding in any pass (after adversarial FP correction) → FUCKED
- Any P1 finding (after adversarial FP correction) → SMELLS
- All clean → CLEAN
- If the adversarial pass corrects a minion P0 as false positive, downgrade the overall verdict accordingly

## Step 7: Memory Store

After completing the review:

```
memory_store content="DFE review [DATE]: [N] files, overall [VERDICT]. 5 minions + 1 adversarial pass. P0: [n], P1: [n] (after dedup + FP correction). Top finding: [top P0/P1 title if any]." importance=0.6 tags=["dfe","review","quality"]
```

## Known Limitations

1. Minion agents ship with the 4ge plugin in `agents/`. If not found, the plugin may need reinstalling (`/plugin update`).
2. Report collection assumes minions write to `_runs/review/dfe-{pass}-$DATE.md` — check file existence before reading.
3. If a minion's report file is missing after completion, note it as "DID NOT PRODUCE OUTPUT" in the table.
4. The adversarial pass adds ~100-200K tokens. For quick checks on small diffs, consider dispatching only the 5 minions by passing `--quick` as an argument hint (skip Tier 3).
5. The adversarial pass can correct minion false positives but can also introduce its own — the consolidated report should note confidence levels.
