# Deterministic Command Renderers — canonical example inputs

Three standalone renderers make the `/forge`, `/dfe`, and `/4ge:audit` command
surfaces capture-true: each is a pure function of a JSON state document on
stdin, emitting byte-identical output for identical input (no wall clock, no
randomness, no env-dependent branches). Same doctrine as the statusline's
real-ANSI xterm capture (screenshot-truth doctrine) — screenshots
render REAL output, not hand-built mockups.

| Renderer | Surface | Example input |
|----------|---------|---------------|
| `bin/forge-status.cjs` | `/forge` session status board (Components 5, 10) | `forge-status.example.json` |
| `bin/dfe-verdict.cjs` | `/dfe` 6-pass verdict block (Components 8, 3, 1) | `dfe-verdict.example.json` |
| `bin/audit-render.cjs` | `/4ge:audit` dashboard (Components 1, 2) | `audit-render.example.json` |

## Usage

```bash
node plugins/4ge/bin/forge-status.cjs --mode=plain \
  < plugins/4ge/bin/examples/forge-status.example.json

node plugins/4ge/bin/dfe-verdict.cjs --schema   # prints the input JSON schema
```

Flags (uniform across all three):

- `--mode=ansi` (default) | `--mode=plain` — these command surfaces are
  governed by `plugins/4ge/skills/wizard-engine/references/output-format.md`
  (plain monospace text, NO ANSI — anti-patterns 6-8), so both modes emit
  byte-identical output. The flag exists for CLI uniformity with
  `hud-engine.cjs` and as a defensive strip in plain mode.
- `--schema` — print the input JSON schema and exit 0.

Malformed input exits 1 with named errors on stderr. Grades, PASS/WARN/FAIL
status, and `=`/`-` score bars are DERIVED from scores via the output-format.md
formulas — the render can never contradict its own numbers. All rendered lines
are ≤ 79 chars (oversized free text is truncated).

## Screenshot capture wiring (next step, not done here)

Each canonical example renders byte-identical to the shipped marketplace
shot content (`.claude-plugin/screenshots/*-shot.html`). To regenerate
screenshots from real renderer output, the screenshots `capture.cjs` pipeline pipes the example through the renderer and feeds
stdout to the xterm canvas frame instead of hand-maintaining `<pre>` blocks:

```bash
node plugins/4ge/bin/forge-status.cjs < examples/forge-status.example.json > forge-session.txt
```

Golden-output vitest suites (`bin/__tests__/{forge-status,dfe-verdict,audit-render}.test.js`)
pin the renderer output to the shot content, so screenshot drift is now a
test failure, not a silent divergence.
