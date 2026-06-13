---
description: "AI code review — 6-pass DFE analysis (5 domain minions + 1 adversarial pass). Use /dfe [file|all] to catch hallucinated APIs, logic bugs, security holes, and runtime failures."
argument-hint: "[file path | all | --staged | --unstaged]"
paths: ["**"]
---

Claude 4ge `/dfe` is the disk-first multi-agent DFE runner. It is separate from Codex `forge-codex:dfe-review`, which is a Codex-native evidence review skill and must not be described as runtime parity with this Claude command.

Parse $ARGUMENTS:

| Pattern | Target policy |
|---------|---------------|
| `all` | Review all tracked reviewable project files (`git ls-files`) |
| `--staged` | Review staged files only (`git diff --cached --name-only`) |
| `--unstaged` | Review unstaged files only (`git diff --name-only`) |
| `--base <ref>` | Review files changed since `<ref>` via `node lib/dfe/diff-scoper.cjs --base <ref>` |
| `--ref <ref>` | Review files changed relative to `<ref>` via `node lib/dfe/diff-scoper.cjs --ref <ref>` |
| `<file path>` | Review the specified file(s) only |
| (empty) | Default to unstaged files (`git diff --name-only`) |

Before producing any output, read `${CLAUDE_PLUGIN_ROOT}/skills/wizard-engine/references/output-format.md` for formatting rules.
**Output components:** 3 (Finding Row), 5 (Progress Line), 8 (Status Table)

## Pipeline

### Step 1: Determine file set

**For `--base <ref>` or `--ref <ref>` arguments:** run `node lib/dfe/diff-scoper.cjs --base <ref>` or `node lib/dfe/diff-scoper.cjs --ref <ref>`. Parse the JSON output (fields: `ref`, `files`, `new_deps`, `summary`). Extract `files[].path` for the reviewable file list and retain the full JSON result for use in Step 2.

**For all other arguments:** run the appropriate git command from the table above to obtain a flat list of file paths.

Then filter the file list to reviewable files:

- Extensions: `.ts`, `.tsx`, `.js`, `.cjs`, `.mjs`, `.jsx`, `.py`, `.go`, `.rs`, `.md`
- Exclude: `node_modules/`, `_runs/`, generated build output, vendored third-party output

If no reviewable files remain, report "No code files to review." and exit. Otherwise, show the file count and write the resolved list into the lead brief.

### Step 2: Write lead brief
Create `_runs/review/dfe-brief-$DATE.md` with the Write tool before dispatching minions:

```
## DFE REVIEW BRIEF - [DATE]
### Target Files
[list files]
### Scope
[argument mode; when --base/--ref was used, include diff-scoper summary: added/modified/deleted counts,
 total_changed_lines, and any new_deps detected; otherwise include git diff --stat summary when available]
### Artifact Policy
- Disk-first: every pass writes a report under _runs/review/.
- Inline output is a concise progress/status summary only.
- Review agents may write their assigned report files, but must not edit source files.
```

### Step 3: Dispatch 5 minions (parallel, background)
Spawn all 5 in a SINGLE Agent tool block using `run_in_background: true`. Some runtimes default to sequential dispatch unless instructed otherwise — all 5 must be in one message to get parallel fanout:

| Agent | subagent_type | Pass | Focus |
|-------|--------------|------|-------|
| dfe-pass1 | dfe-existence | 1: EXISTENCE | Imports resolve, packages exist, APIs not deprecated |
| dfe-pass2 | dfe-security | 2+7: SECURITY+PROVENANCE | Injection, taint, OWASP, secrets, slopsquatting |
| dfe-pass3 | dfe-logic | 3: LOGIC | Races, off-by-one, inverted booleans, async errors |
| dfe-pass4 | dfe-runtime | 4+5: RUNTIME+TRUST | Env mismatches, missing await, global state, types |
| dfe-pass5 | dfe-artifacts | 6: ARTIFACTS | Dead exports, orphaned vars, copy-paste drift, TODOs |

Each minion prompt MUST include: "Read `_runs/review/dfe-brief-$DATE.md`. Review only the listed target files. Write findings to `_runs/review/dfe-{pass}-$DATE.md` using the Write tool. Do not edit source files. Return only a concise completion summary inline."

Minions are source-read-only scanners. They may use Write only for their assigned `_runs/review/` report. No Edit, no source fixes.

### Step 4: Collect minion reports
As each minion completes, read its report from `_runs/review/dfe-{pass}-$DATE.md`. If a report is missing, record that pass as "DID NOT PRODUCE OUTPUT" in the final table. Show progress:
```
  Scanning [3/5] dfe-pass3 complete ...
```

### Step 5: Dispatch DFE adversarial
After all 5 minions complete, spawn `DFE` with the lead brief and ALL 5 minion report paths in the prompt:

```
Agent(subagent_type: "DFE", mode: "auto", run_in_background: false)
```

Prompt must include:
1. `_runs/review/dfe-brief-$DATE.md`
2. All 5 minion report paths
3. Instruction to verify each finding against actual source code
4. Instruction to add own adversarial findings
5. Instruction to write the consolidated report to `_runs/review/dfe-adversarial-$DATE.md` using Write tool
6. Instruction to return executive summary inline

### Step 6: Display results
Read `_runs/review/dfe-adversarial-$DATE.md`, then show the DFE adversarial executive summary using output format components:
- Component 8 (Status Table) for per-pass verdict
- Component 3 (Finding Row) for top findings
- Component 1 (Score Bar) for overall confidence

List the full report paths under `_runs/review/`. If the adversarial pass found P0s, flag them prominently. If all findings are P2+, report clean.
