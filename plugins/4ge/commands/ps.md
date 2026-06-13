---
description: "Agent process dashboard — running agents, zombie candidates, reaper log, and session uptime"
argument-hint: "[--zombies] — show only zombie/stale candidates"
paths: ["**"]
---

# /ps

Read-only agent process dashboard. Surfaces the data that `process-health` already tracks — no new process instrumentation.

## Step 1: Load state files

Read the following files in parallel (skip gracefully if missing):

- `_runs/os/session-processes.json` — session identity, tracked PIDs, MCP PIDs, last heartbeat
- `_runs/os/health.json` — overall OS health, capability states
- `_runs/os/boot-status.json` — session boot time (for uptime calculation)

Read the last 5 lines of `_runs/os/reaper-log.jsonl` for recent reap events:

```bash
tail -5 _runs/os/reaper-log.jsonl 2>/dev/null
```

## Step 2: Compute uptime

If `boot-status.json` has a `boot_ts` or `started_at` field, compute uptime as `now - boot_ts`.
Fall back to `session-processes.json` `started_at` if boot-status lacks a timestamp.
Format: `1h 23m` or `45m` or `< 1m`.

## Step 3: Classify processes

From `session-processes.json`:

- `tracked_pids` — actively tracked agent subprocesses
- `mcp_pids` — MCP server processes

A PID entry is a **zombie candidate** if it appears in `tracked_pids` AND the most recent reaper log entry for that PID shows `killed: 0` with a `last_heartbeat` older than 10 minutes. If `tracked_pids` is empty, show "no tracked agents".

## Step 4: Render dashboard

Output a plain monospace table (NO ANSI — this surface follows the output-format.md plain-terminal rule):

```
/ps — Agent Process Dashboard
──────────────────────────────────────────
  Session     {session_id_short (first 8 chars)}
  Uptime      {uptime}
  Last beat   {last_heartbeat relative: "Xs ago" or "Xm ago"}

  Tracked agents    {count or "none"}
  MCP processes     {count or "none"}
  Zombie candidates {count or "none"}

Recent reaper events ({N} shown):
  {ts}  procs={total_procs}  killed={killed}
  ...

{if zombie candidates > 0}
Zombie candidates:
  PID {pid}  last-seen {relative age}
{/if}
```

If `$ARGUMENTS` is `--zombies`, render only the zombie candidates section (skip session/reaper sections).

If `_runs/os/session-processes.json` is missing, output:

```
/ps: OS state not found. Is the OS booted? Check the SessionStart hook.
```
