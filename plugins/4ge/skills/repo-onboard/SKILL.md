---
name: repo-onboard
description: "First-time onboarding of an unfamiliar repository — map the stack, flag missing CI/test/lint config, generate a setup checklist. For cleanup scoring of a repo you already work in, use repo-hygiene."
tools: Bash, Read, Glob, Grep
disable-model-invocation: true
---

# repo-intake — Repository Onboarding Scanner

Produces a structured intake report with health grade and action items for a repository.

## Parse $ARGUMENTS

| Pattern | Action |
|---------|--------|
| `<path>` | Run intake on specified directory |
| (empty) | Run intake on current working directory |

Set `TARGET_DIR` to the argument or `.` if empty.

## Step 1: Project Identity

Read these files if they exist:
- `CLAUDE.md` or `README.md` — project name, purpose, tech stack
- `package.json` — name, version, scripts, dependencies count
- `tsconfig.json` or `jsconfig.json` — TypeScript strictness settings

Extract:
- Project name and purpose (1 sentence)
- Primary language/runtime
- Framework(s)
- Monorepo or single package

## Step 2: Directory Structure Map

Use Glob to map key patterns:
```
**/*.json (root level only — package.json, tsconfig, etc.)
src/**/*  or  lib/**/*  (source structure)
**/*.test.ts  or  **/*.spec.ts  (test coverage signal)
.claude/**  (Claude Code configuration)
```

Identify:
- Source directories
- Test directories
- Config files present
- Approximate file count per major area (use `find` or `ls -R | wc -l` estimate)

## Step 3: Missing Essentials Check

Check for each item and mark PRESENT / MISSING:

| File/Config | Check |
|-------------|-------|
| `.gitignore` | `ls .gitignore` |
| `.env.example` | `ls .env.example` |
| `README.md` | `ls README.md` |
| CI config | `ls .github/workflows/ 2>/dev/null \|\| ls .gitlab-ci.yml 2>/dev/null` |
| Lint config | `ls .eslintrc* .eslintrc.json eslint.config.* 2>/dev/null` |
| Type config | `ls tsconfig.json 2>/dev/null` |
| Test config | `ls vitest.config.* jest.config.* 2>/dev/null` |
| Docker config | `ls Dockerfile docker-compose.yml 2>/dev/null` |

## Step 4: Test Framework and Health

Identify the test runner from package.json devDependencies:
- vitest, jest, mocha, etc.

Run the test suite (non-interactive, short timeout):
```bash
npx vitest run --reporter=verbose 2>&1 | tail -20
# or
npx jest --passWithNoTests 2>&1 | tail -20
```

Record: total tests, passing, failing, skipped.

If tests fail to run entirely → flag as BLOCKED.

## Step 5: Dependency Health

Check for outdated or vulnerable packages:
```bash
npm outdated --depth=0 2>/dev/null | head -20
npm audit --audit-level=high 2>/dev/null | tail -10
```

Count:
- Outdated packages (major / minor / patch separately)
- High/critical vulnerabilities

## Step 6: Output Intake Report

Write the full report to `_runs/repo-intake-[DATE].md` first, then print summary inline.

Report structure:
```
# REPO INTAKE REPORT — [PROJECT_NAME] — [DATE]

## Identity
- Name: [name]
- Purpose: [1 sentence]
- Runtime: [node/deno/bun/etc]
- Framework: [list]
- Structure: [monorepo/single]

## Health Grade: [A/B/C/D/F]

| Category           | Grade | Notes                          |
|--------------------|-------|--------------------------------|
| Config Completeness| [A-F] | [N/8 essentials present]       |
| Test Health        | [A-F] | [N passing, N failing]         |
| Dependency Health  | [A-F] | [N outdated, N vulns]          |
| Documentation      | [A-F] | [README present / missing]     |

## Missing Essentials
[list with remediation commands]

## Setup Checklist
- [ ] [action 1]
- [ ] [action 2]
...

## Quick Start Commands
[derived from package.json scripts]
```

**Grade scale:**
- A: 0-1 issues, tests green, no high vulns
- B: 2-3 minor issues, tests mostly green
- C: 4-5 issues or test failures present
- D: multiple missing essentials or high vulns
- F: no tests, missing CI, critical vulns

## Step 7: Memory Store

```
memory_store content="Repo intake [PROJECT_NAME] [DATE]: grade [GRADE]. Key gaps: [list top 3 issues]." importance=0.6 tags=["intake","onboarding","[project-name]"]
```
