---
description: "Export session work as a business-ready deliverable (brief, deck, handoff)"
argument-hint: "[session-id] [--bizops] [--format brief|deck|all]"
paths: ["**"]
---

# /export

Export the current or specified session's work as a business-ready deliverable.

Parse $ARGUMENTS:
- If empty: export the current session
- If a session ID: export that specific session
- `--bizops`: also copy outputs to `H:/Dropbox/BizOps/`
- `--format brief`: Markdown brief only (default)
- `--format deck`: PPTX slide deck (requires PptxGenJS)
- `--format all`: brief + deck + structured handoff

## Pipeline

Run the export pipeline:

```javascript
const { runExport } = require('${CLAUDE_PLUGIN_ROOT}/lib/export-pipeline.cjs');
```

Parse `$ARGUMENTS` to extract `sessionId`, `--bizops` flag, and `--format <brief|deck|all>` (default: `brief`).

```javascript
const result = await runExport(sessionId, {
  bizops: hasBizopsFlag,
  format: parsedFormat,  // 'brief' | 'deck' | 'all'
});
```

1. **Find transcript**: Locate the session transcript in `~/.claude/projects/O--Sand-Box-Dev/sessions/`
2. **Parse**: Extract decisions, file changes, message count, artifacts, duration
3. **Build export data**: Structure into a template-ready JSON object
4. **Generate brief**: Write a Markdown executive brief to `_runs/{sessionId}-brief.md` (format: brief or all)
5. **Generate deck**: Write a PPTX slide deck to `_runs/{sessionId}-brief.pptx` (format: deck or all)
6. **Copy to BizOps**: If `--bizops` flag, copy brief to `H:/Dropbox/BizOps/`

## Output

Display a summary using output-format.md Component 7 (Confirmation Card):

```
  Session   {sessionId}
  Messages  {count}
  Decisions {count}
  Files     {count} changed
  Duration  {formatted}
  Brief     {path}
  BizOps    {copied or skipped}
```

## Error Handling

- If no transcript found: "No transcript found for session {id}. Check ~/.claude/projects/ for session directories."
- If export-pipeline.cjs not found: "Export pipeline not installed. Run zone build-out first."
- If BizOps drive not available: "BizOps drive not mounted (H:/Dropbox/BizOps/). Brief saved locally only."

## Badge Integration

After a successful export, check if the `export-ready` badge should be earned:

```javascript
const { checkBadges } = require('${CLAUDE_PLUGIN_ROOT}/lib/badge-tracker.cjs');
const result = checkBadges({}, { dryRun: false });
if (result.newlyEarned.includes('export-ready')) {
  // Display badge earned notification
}
```
