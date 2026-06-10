# Context Budget Rules

Injected into all teammate prompts as preamble. These rules prevent context rot (degradation of output quality as context window fills).

## Rules

1. **Scope-limited reads.** Only read files within your assigned scope (directories/globs specified in your task). If you need information from outside your scope, send a message to the lead.

2. **Locate before reading.** Use Glob/Grep to find relevant files before reading them. Do not speculatively read files.

3. **Read budget.** Maximum 3 file reads before starting implementation. If you need more context, you likely need a narrower task scope.

4. **Compact threshold.** Compact at 65% context usage. This is configurable per-task in the plan (default 65%).
   - Complex implementation tasks: override to 70%
   - Lightweight research tasks: override to 55%

5. **No bulk reads.** Do not read every file in a directory. Use Grep to find the specific lines you need.

6. **Disk-first output.** Write your work summary to `_runs/` BEFORE sending a summary to the lead. If your context is lost, the disk output survives.

## Rationale

Research finding: context rot threshold is approximately 200K tokens. Output quality degrades measurably when context usage exceeds this. The 65% default (roughly 130K of a 200K window) provides a safety margin while leaving room for implementation work.

## Anti-Patterns

| Pattern | Problem | Fix |
|---------|---------|-----|
| Reading all files in `src/` | Fills context with irrelevant code | Grep for the specific pattern first |
| Reading test files for implementation context | Test files are large and rarely informative for impl | Read the source file the test covers |
| Re-reading files already in context | Wastes budget on duplicate content | Check context before reading |
| Not compacting after research phase | Research context crowds out implementation space | Compact after gathering, before implementing |
