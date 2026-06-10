---
name: repo-hygiene
description: "Repository cleanup scan with 100-point scoring — branches, orphans, config drift, dead code"
tools: Bash, Read, Glob, Grep
disable-model-invocation: true
---

# repo-hygiene — Repository Hygiene Scorer

Scans 5 categories of maintenance debt, scores each 0-20 points, outputs a 100-point hygiene report.

## Parse $ARGUMENTS

| Pattern | Action |
|---------|--------|
| `--fix` | After scoring, offer specific fix commands for each deduction |
| `--category <name>` | Run only the named category (branches/orphans/config/deadcode/debt) |
| (empty) | Full scan, all 5 categories |

## Category 1: Stale Branches (20 pts)

Check local and remote branches for staleness:

```bash
# Merged local branches (safe to delete)
git branch --merged main 2>/dev/null | grep -v "^\*\|main\|master\|develop"

# Gone remote tracking branches
git branch -vv | grep ': gone]'

# Branches with no commits in 30+ days
git for-each-ref --sort=committerdate refs/heads/ --format='%(refname:short) %(committerdate:relative)' | grep -E 'months|year'
```

Score deductions:
- Merged branches not deleted: -2 pts each (max -10)
- Gone remote branches: -2 pts each (max -6)
- Branches older than 30 days with no recent commits: -2 pts each (max -4)

## Category 2: Orphaned Files (20 pts)

Scan for files that shouldn't exist or are forgotten:

```bash
# Empty files (excluding intentional ones like .gitkeep)
find . -empty -type f -not -path '*/.git/*' -not -name '.gitkeep' -not -name '.keep' 2>/dev/null | head -20

# Temp/backup files
find . -type f \( -name '*.tmp' -o -name '*.bak' -o -name '*.orig' -o -name '*.log' \) -not -path '*/.git/*' 2>/dev/null | head -20

# Files larger than 1MB that are tracked (potential accidents)
find . -type f -size +1M -not -path '*/.git/*' -not -path '*/node_modules/*' -not -path '*/.next/*' 2>/dev/null | head -10
```

Score deductions:
- Empty files (non-intentional): -1 pt each (max -5)
- Temp/backup files checked in: -2 pts each (max -8)
- Large tracked files (>1MB, non-asset): -3 pts each (max -7)

## Category 3: Config Drift (20 pts)

Check for inconsistency between config files:

```bash
# Tracked environment templates only. Do not read .env or .env.* secret files.
git ls-files --error-unmatch .env >/dev/null 2>&1 && echo ".env is tracked"
find . -maxdepth 2 -type f \( -name '.env.example' -o -name '.env.tpl' -o -name '.env.template' \) \
  -not -path '*/node_modules/*' -print 2>/dev/null

# package.json engines vs .nvmrc/.node-version
node_req=$(node -e "const p=require('./package.json'); console.log(p.engines?.node||'')" 2>/dev/null)
nvmrc=$(cat .nvmrc 2>/dev/null || cat .node-version 2>/dev/null || echo "")
echo "engines.node: $node_req | .nvmrc: $nvmrc"

# tsconfig strict flags (detect if strictness was silently disabled)
grep -E '"strict"|"noImplicitAny"|"strictNullChecks"' tsconfig.json 2>/dev/null
```

Score deductions:
- .env tracked by git: -15 pts
- Missing tracked env template for an app that documents required env: -3 pts each (max -6)
- Node version mismatch (engines vs .nvmrc): -3 pts
- TypeScript strictness disabled without comment: -2 pts

## Category 4: Dead Code (20 pts)

Scan for code that is no longer needed:

```bash
# TODO/FIXME/HACK/XXX comments with counts
grep -rn --include='*.ts' --include='*.tsx' --include='*.js' --include='*.cjs' \
  -E 'TODO|FIXME|HACK|XXX' . \
  --exclude-dir=node_modules --exclude-dir=.git 2>/dev/null | wc -l

# Files that export nothing and are not test files
# (heuristic: check for files with no export keyword)
grep -rL 'export' src/ lib/ plugins/ 2>/dev/null | grep -v test | grep -v spec | head -10

# Console.log in production code (non-test files)
grep -rn 'console\.log' --include='*.ts' --include='*.tsx' --include='*.cjs' \
  --exclude='*.test.*' --exclude='*.spec.*' \
  --exclude-dir=node_modules . 2>/dev/null | wc -l
```

Score deductions:
- TODO/FIXME count: -1 pt per 5 items (max -8)
- Files with no exports (dead modules): -2 pts each (max -6)
- console.log in production code: -1 pt per 3 instances (max -6)

## Category 5: Dependency Debt (20 pts)

Check for dependency maintenance debt:

```bash
# Major version outdated packages
npm outdated --depth=0 --json 2>/dev/null | node -e "
  let data = '';
  process.stdin.on('data', d => data += d);
  process.stdin.on('end', () => {
    try {
      const obj = JSON.parse(data);
      const majors = Object.entries(obj).filter(([,v]) => {
        const cur = parseInt(v.current); const want = parseInt(v.latest);
        return want > cur;
      });
      console.log('major-outdated: ' + majors.length);
    } catch(e) { console.log('parse error'); }
  });
" 2>/dev/null

# High/critical audit findings
npm audit --audit-level=high --json 2>/dev/null | node -e "
  let data = '';
  process.stdin.on('data', d => data += d);
  process.stdin.on('end', () => {
    try {
      const r = JSON.parse(data);
      const high = (r.metadata?.vulnerabilities?.high||0) + (r.metadata?.vulnerabilities?.critical||0);
      console.log('high-critical-vulns: ' + high);
    } catch(e) { console.log('parse error'); }
  });
" 2>/dev/null

# Duplicate dependencies (multiple versions of same package)
npm ls --depth=1 2>/dev/null | grep -c 'deduped' || echo "0"
```

Score deductions:
- Major version outdated: -2 pts each (max -10)
- High severity vulnerabilities: -3 pts each (max -9)
- Critical vulnerabilities: -5 pts each (max -15, floor at 0)
- (Critical vulns can sink this category below 0, floor at 0)

## Output Hygiene Report

Write full report to `_runs/repo-hygiene-[DATE].md`, then print summary inline.

```
# REPO HYGIENE REPORT — [DATE]

## Score: [TOTAL]/100 — [GRADE]

| Category          | Score | Max | Deductions                          |
|-------------------|-------|-----|-------------------------------------|
| Stale Branches    | [N]   | 20  | [list what cost points]             |
| Orphaned Files    | [N]   | 20  | [list what cost points]             |
| Config Drift      | [N]   | 20  | [list what cost points]             |
| Dead Code         | [N]   | 20  | [list what cost points]             |
| Dependency Debt   | [N]   | 20  | [list what cost points]             |

## Grade: [A/B/C/D/F]
## Trend: [first run — no prior baseline / improved from X / declined from X]

## Fix Recommendations (highest impact first)

### Critical (fix before release)
[list items causing -3 or more pts]

### Standard (fix this sprint)
[list items causing -1 to -2 pts]

### Optional (nice to have)
[list cosmetic or low-impact items]
```

**Grade scale:**
- A: 90-100 pts
- B: 75-89 pts
- C: 55-74 pts
- D: 35-54 pts
- F: below 35 pts

If `--fix` flag provided, append concrete fix commands for each deduction:
- Stale branches: `git branch -d <name>` commands
- Temp files: `rm` commands
- Config drift: specific env key additions
- TODOs: file locations with line numbers

## Memory Store

```
memory_store content="Repo hygiene scan [DATE]: [TOTAL]/100 ([GRADE]). Top deductions: [top 3 issues]. Prior: [prior score if known]." importance=0.5 tags=["hygiene","maintenance","quality"]
```
