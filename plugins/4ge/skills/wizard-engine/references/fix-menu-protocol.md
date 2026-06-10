# Fix Menu Protocol

UX protocol for Stage 4 (FIX MENU) and Stage 5 (EXECUTE).

## Risk Tiers

| Tier | Description | Execution Mode | Examples |
|------|-------------|----------------|----------|
| **Safe** | No code changes; file deletions, config additions, semver-patch | Auto-executable after batch confirmation | Delete merged branches, remove .bak files |
| **Medium** | Likely safe but verify; semver-minor, config migrations | Batch confirmation with per-fix detail | Update eslint minor, pin Node version |
| **Risky** | May break builds; semver-major, structural changes | Individual confirmation per fix | Major dep bumps, strict mode |
| **Informational** | No automated fix; manual action needed | Display only | Architecture observations |
| **Inbox-sourced** | User-submitted via `/fix` | Risk tier assigned by research | Varies |

## Menu Layout

```
=== FIX MENU ===

  SAFE (auto-executable, no risk):
    1. [recommended] <description>
    2. [suggested]   <description>

  MEDIUM (likely safe, verify after):
    3. [recommended] <description>

  RISKY (may break builds, needs review):
    4. [detected]    <description>

  INFORMATIONAL (manual action needed):
    5. [suggested]   <description>

  INBOX (from /fix collector):
    6. [suggested]   "<user description>" (mapped: <category>)

  ---
  Shortcuts:
    (a) all safe
    (f) all safe + recommended medium
    (r) all recommended (any tier)
    (n) pick by number -- e.g., "1,3,5-7"
    (i) inspect -- e.g., "i4" for details on item 4
    (s) skip -- proceed without fixes
    (d) export -- write fix list to _runs/ and exit
    (S) Show suppressed items
    (u<N>) Un-suppress -- restore a suppressed item

  Select: a/f/r/n/i<N>/s/d/S/u<N> | Help: ?
> _
```

## Inspect View

```
=== INSPECT: Item N ===

  Category:     <name>
  Risk tier:    <tier>
  Confidence:   X.XX [tag]
  Sources:      <list>

  What it does:
    <description of the fix action>

  Affected files:
    - <file1>
    - <file2>

  Rollback:
    <rollback command>

  Evidence:
    - <source 1>
    - <source 2>

  (b) Back to menu | (a) Apply this fix | Help: ?
> _
```

## Suppress Behavior

- Items skipped 3+ times across runs are offered "suppress this?"
- Suppressed items are excluded from both menus and scoring
- Each suppress entry requires `expires_at` (ISO date or null for permanent)
- Critical-severity security findings cannot be suppressed
- `--show-suppressed` reveals all suppressed items
- Security category cannot have pattern ".*" suppress (wildcard blocked)

## Execution Protocol (Stage 5)

1. **Create git stash rollback point:**
   - Name: `wizard-outhouse-${session_id}-$(date +%Y%m%d-%H%M%S)`
   - Capture stash ref: `git stash list --format="%gd %s" | grep "wizard-outhouse-${session_id}" | head -1 | awk '{print $1}' | tr -d '\r'`
   - Store both name and ref in session state
   - Check for existing session from different session_id -- abort if found

2. **Build dependency graph:**
   - Each fix declares `depends_on` and `conflicts_with`
   - Topological sort; detect cycles (break at lowest-priority edge)
   - If two fixes touch the same file, prompt for ordering

3. **Execute in order:**
   - Each fix attempted exactly once (no retry loop)
   - Before applying: snapshot affected file contents to temp structure
   - Apply fix
   - Verify: `npx tsc --noEmit && npx eslint <affected-files>`
   - On pass: mark applied, continue
   - On fail: restore from per-fix snapshot (not git checkout HEAD), log, continue

4. **Dependency updates are standalone commits** (per CLAUDE.md non-negotiable)

5. **Post-execute menu:**
   ```
   (a) Accept all applied fixes [default]
   (r) Review diffs
   (u) Undo specific -- e.g., "u3"
   (U) Undo all -- git stash apply ${safety_stash.ref}
   (?) Help
   ```

6. **Emergency rollback (! hotkey):**
   - `git stash apply ${safety_stash.ref}` (apply not pop, preserves for retry)
   - Verify stash exists first; warn if not found
