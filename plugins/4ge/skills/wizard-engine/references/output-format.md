# Output Format Reference

All 4ge output is plain monospace text. No ANSI. No color. Left-aligned. 2-space indent
increments. See Anti-Patterns section for explicit prohibitions.

---

## Components

### 1. Score Bar

Single-line health indicator with a 20-character visual bar.

**Format:**
```
Health: {score}  {grade}  [{bar}]  ({delta})
```

- `score`: bare integer, no denominator
- `grade`: single char `A`-`F`
- `bar`: 20 chars — `=` filled, `-` empty; fill = `round(score / 100 * 20)`
- `delta`: `(+N)` or `(-N)` — omit entirely when no prior run exists

**Grade thresholds:** A=90-100, B=75-89, C=55-74, D=35-54, F=0-34
**Status thresholds:** PASS >= 80%, WARN = 50-79%, FAIL < 50%

**Golden mockup:**
```
Health: 72  C  [==============------]  (+8)
Health: 45  D  [=========-----------]
Health: 0   F  [--------------------]
```

---

### 2. Category Row

Space-aligned columns used in dashboard views. 2-space indent.

**Format:**
```
  {name:15}  {score:5}  {grade}  {status:4}  [{bar:20}]  {count} findings
```

- `name`: 15-char left-justified category name
- `score`: `NN/20` — denominator provides context at category level
- `grade`: single char `A`-`F`
- `status`: `PASS`, `WARN`, or `FAIL` (4 chars)
- `bar`: 20-char fill bar (same formula as Score Bar, scaled to /20)
- `count`: integer finding count
- Sorted by display order (stable, not by score)

**Golden mockup:**
```
  Dependencies     14/20  B  WARN  [==============------]   3 findings
  Security         06/20  D  FAIL  [======--------------]   5 findings
  Branches         20/20  A  PASS  [====================]   0 findings
```

---

### 3. Finding Row

Individual finding with stable item number, confidence tag, and execution tier badge.

**Format:**
```
  {num:>3}. {tag:15}  {description} ({tier})  {confidence:>4}
```

Note: The tier badge `({tier})` is appended after the description, separated by a space. Example: "Delete 4 merged branches (auto)" not "Delete 4 merged branches  (auto)  0.92".

- `num`: globally unique, stable within session, right-justified in 3 chars
- `tag`: confidence label — `[recommended]`, `[suggested]`, `[detected]`; 15-char field
- `description`: finding text with execution tier badge in parentheses at end
- `confidence`: right-justified float (0.00-1.00)
- No blank lines between finding rows in the same tier (see Anti-Patterns)

**Golden mockup:**
```
  3. [recommended]  Delete 4 merged branches (auto)           0.92
  4. [suggested]    Update eslint 8.x -> 9.x (manual)          0.71
  5. [detected]     Stale TODO in lib/os/ipc.cjs (noted)       0.38
```

---

### 4. Execution Tier Badges

Inline markers embedded in Finding Rows classifying how a fix is applied.

| Badge | Meaning | Locked |
|-------|---------|--------|
| `(auto)` | Fully automated, no confirmation | Label only |
| `(guided)` | Automated with confirmation prompt | Label only |
| `(manual)` | Requires human execution | Base set + user additions |
| `(noted)` | Logged for awareness, no action | Label only |
| `(queued)` | Deferred to future run | Label only |

**Manual tier locked base set** (items in this set cannot be removed via config):
- Major version bumps
- Structural deletions (directories, capabilities, agents)
- Capability removal
- Security-sensitive config changes

Users may add items to `(manual)` via `.4ge-wizard.json` `execution_tiers.manual_additions`.

**Prior-design mapping:** safe -> auto, medium -> guided, risky -> manual, info -> noted, inbox -> queued

---

### 5. Progress Line

Inline scan, research, or execute progress indicator.

**Format (scan/research):**
```
  {verb} [{current}/{total}] {name} ({detail}) ...
```

**Format (execute — with dot-leader):**
```
  {verb} [{current}/{total}] {description} .......... {status}
```

- 2-space indent
- `detail` in parentheses is optional (e.g., `deep, ~20s`)
- Execute variant pads to fixed-width status column with dot-leader

**Golden mockup:**
```
  Scanning [4/9] hooks ...
  Researching [2/3] dependencies (deep, ~20s) ...
  Applying [7/9] Set maxTurns on 3 agents .......... applied
```

---

### 6. Action Menu

Compact hotkey block shown at the bottom of interactive screens. Two-column layout.

**Format:**
```
  ({key}) {label}          ({key}) {label}
  ...

> _
```

- 2-space indent on each hotkey line
- Default option appended with `[default]`
- Prompt line `> _` preceded by one blank line
- Universal hotkeys (`?`, `q`, `!`, `v`, `h`, `e`) shown only when user presses `?`

**Golden mockup:**
```
  (a) all safe          (f) all safe + recommended
  (r) all recommended   (n) pick by number: 1,3,5-7
  (i) inspect: i4       (s) skip
  (d) export to _runs/  (S) show suppressed

> _
```

---

### 7. Confirmation Card

Field-value pairs for `/fix` capture and post-execute acceptance.

**Format:**
```
  {label:10}  {value}
```

- 2-space indent, 10-char left-justified label, rest-of-line value
- No borders or separators between fields

**Golden mockup:**
```
  Captured  "hook-perf: pre-write-check.cjs taking >200ms"
  Tagged    hooks
  Status    open -- appears in next /outhouse run
  Inbox     3 items (1 branches, 1 hooks, 1 tests)
```

---

### 8. Status Table

Space-aligned name/status/detail for system views (`/4ge os`, `/infra`).

**Format:**
```
  {name:13}  {status:11}  {detail}
```

- 2-space indent, 13-char name, 11-char status, rest-of-line detail
- Status values: `ready`, `degraded`, `disabled`, `error`
- When all capabilities are ready: show `(all 13 ready)` instead of listing each

**Golden mockup:**
```
  memory       ready      hub:8091 latency:12ms
  git          ready      main, 3 remotes
  aisle        degraded   gate disabled (bridge hooks active)
  llm          degraded   Ollama unreachable
```

---

### 9. Delta Card

Changed-only category rows with grade transition and fix outcome summary.

**Format:**
```
  Category         Before  After  Delta
  {name:16}  {before:5}  {after:5}   {delta:+d}
  ...
  ({N} unchanged categories omitted)

  Overall  {before} -> {after}  ({delta:+d})  Grade {from} -> {to}
  Fixes: {applied} applied | {rolled-back} rolled back | {failed} failed | {skipped} skipped
```

- Only rows with non-zero delta are shown
- Category scores use `NN/20` (denominator at category level); overall uses bare numbers
- Fix outcome states (canonical): `applied`, `rolled-back`, `failed`, `skipped`

**Golden mockup:**
```
  Category         Before  After  Delta
  Branches         18/20   20/20   +2
  Dependencies     11/20   14/20   +3
  Security         04/20   06/20   +2
  (5 unchanged categories omitted)

  Overall  64 -> 72  (+8)  Grade D -> C
  Fixes: 8 applied | 1 rolled back | 1 failed | 15 skipped
```

---

### 10. Teammate Row

Agent activity tracking for `/forge` and Agent Teams views.

**Format:**
```
  {name:16}  {phase:13}  {scope:20}  {status}
```

- 2-space indent, 16-char agent name, 13-char phase, 20-char file scope, status
- Idle agents show `--` for scope and status
- When no teammates are active: show `(no active teammates)` instead of an empty section

**Golden mockup:**
```
  impl-expert     P5:execute   lib/os/scheduler/   [3/5] applied
  sonnet-execute  P5:verify    lib/os/scheduler/   tsc PASS
  security-rev    idle         --                   --
```

---

## Anti-Patterns (Prohibitions)

1. Do not use GFM pipe tables for category dashboards — use space-aligned fixed-width columns (Component 2).
2. Do not wrap findings in code blocks — findings are conversational output, not code.
3. Do not add blank lines between finding rows within the same tier.
4. Do not repeat the risk tier label on each finding row — the section header covers it.
5. Do not show universal hotkeys in every menu — show only on `?` press.
6. Do not use "OK", "GOOD", "BAD", "CRITICAL", or traffic-light metaphors — use `A`-`F` grades and `PASS`/`WARN`/`FAIL` status.
7. Do not center or right-align any content block.
8. Do not use box-drawing characters or decorative borders.

---

## Statusline Exception

These formatting rules apply to 4ge command output (wizard dashboards, forge status, OS views). The native Claude Code statusline (`hud-statusline.cjs`) is terminal chrome and may use ANSI colors, Unicode block characters, emoji themes, and sparkline glyphs that would otherwise violate anti-patterns 6-8.

**Boot Screen Exception:** The OS boot screen (`boot-screen.cjs`) is a visual status display invoked by `/4ge os`. It may use ANSI colors for readability, following the same exception as the statusline.

**Conversation Canvas Exception:** The HUD engine (`hud-engine.cjs`) outputs rich ANSI visuals into the conversation area via Bash tool results. This output follows the Statusline Exception rules: ANSI colors, Unicode block characters, and wider layouts are permitted. The output-format.md component templates (Status Table, Score Bar, etc.) do not apply to engine output -- the engine owns its own visual vocabulary.

---

## Edge Cases

| Condition | Behavior |
|-----------|----------|
| Zero findings in a tier | Omit that tier's section entirely |
| No prior run data | Omit delta portion of Score Bar |
| Empty inbox | Show `INBOX (from /fix collector):` then `(none -- inbox empty)` |
| Single category scan (`--category`) | Show only that category row, omit full dashboard |
| All categories PASS | Skip triage menu; show `All categories PASS -- no deep dive needed` |
| Description exceeds 45 chars | Wraps naturally in terminal (acceptable) |
| Score is exactly 0 | Show `Health: 0  F  [--------------------]` (bare number, no denominator) |
| No categories scanned | Show error: `No scannable categories found. Check .4ge-wizard.json scan_exclude.` |

---

## Execution Tiers

Configured in `.4ge-wizard.json` under `execution_tiers`.

| Badge | Trigger condition |
|-------|-----------------|
| `(auto)` | Safe, fully reversible, no confirmation needed |
| `(guided)` | Automated but pauses for confirmation |
| `(manual)` | Human execution required (locked base set + additions) |
| `(noted)` | Awareness only, no action taken |
| `(queued)` | Deferred to a future run |

**`manual_base_set` (immutable — validated at config load, additions/removals rejected):**
- Major version bumps
- Structural deletions (removing directories, capabilities, or agents)
- Capability removal
- Security-sensitive config changes

Users add items via `execution_tiers.manual_additions` in `.4ge-wizard.json`. Items in `manual_base_set` cannot be removed.
