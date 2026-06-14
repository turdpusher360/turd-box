#!/usr/bin/env node
'use strict';

/**
 * hud-gemini-adapter.cjs
 *
 * Antigravity CLI (`agy`) statusLine adapter for the 4ge HUD engine.
 * Wire in ~/.gemini/antigravity-cli/settings.json:
 *   "statusLine": { "command": "node /mnt/o/Sand_Box_Dev/plugins/4ge/bin/hud-gemini-adapter.cjs", "enabled": true }
 *
 * Antigravity pipes a JSON payload to stdin on every agent state change.
 * This adapter translates that payload into a hud-engine rawState and emits
 * a single-line ANSI strip to stdout. Full 24-bit truecolor supported.
 *
 * Fail-safe: any error → minimal plain line → exit 0 (never breaks statusline).
 */

const fs = require('node:fs');
const { loadSurfaceState, renderSurface, defaultProjectRoot } = require('./hud-surface-host.cjs');

const PROJECT_ROOT = defaultProjectRoot();

// ── stdin read (Windows-safe synchronous) ────────────────────────────────────
function readStdinSync() {
  try {
    if (process.stdin.isTTY) return {};
    const buf = fs.readFileSync(0); // fd 0 = stdin
    if (!buf || !buf.length) return {};
    return JSON.parse(buf.toString('utf8').trim());
  } catch {
    return {};
  }
}

// ── Antigravity payload → hud-engine rawState ────────────────────────────────
//
// Antigravity stdin fields (per research):
//   model           string  — e.g. "gemini-3-pro"
//   agent_state     string  — "idle" | "thinking" | "running"
//   workspace       string  — absolute path to workspace dir (flat string variant)
//                             OR { current_dir: string } (object variant per docs)
//   git_branch      string  — active branch
//   context_usage   number  — fraction 0–1 (e.g. 0.42 = 42%)
//   terminal_width  number  — terminal columns
//
function buildRawState(payload) {
  // Resolve workspace directory — handle both flat string and object form.
  let workspaceDir = PROJECT_ROOT;
  if (typeof payload.workspace === 'string' && payload.workspace.trim()) {
    workspaceDir = payload.workspace.trim();
  } else if (payload.workspace && typeof payload.workspace.current_dir === 'string' && payload.workspace.current_dir.trim()) {
    workspaceDir = payload.workspace.current_dir.trim();
  }

  // context_usage is a fraction (0.42 → 42%). Guard against already-percent values.
  const rawUsage = typeof payload.context_usage === 'number' ? payload.context_usage : 0;
  const contextPct = Math.round(rawUsage <= 1 ? rawUsage * 100 : rawUsage);

  const rawState = loadSurfaceState({
    projectRoot: workspaceDir,
    context: { trigger: 'gemini', event: null, zone: null },
  });

  // ── Apply Antigravity-sourced overrides ──────────────────────────────────

  // Terminal width (clamped inside buildCanonicalState to MAX_BASH_COLS=79).
  if (typeof payload.terminal_width === 'number' && payload.terminal_width > 0) {
    rawState.terminal = Object.assign({}, rawState.terminal, { cols: payload.terminal_width });
  }

  // Session: context % (authoritative from Antigravity).
  rawState.session = Object.assign({}, rawState.session, {
    contextPct,
    // model: Antigravity model label — renderStrip prefix-matches against 'claude-*'
    // so gemini-* won't produce a colored model chip; harmless, shows blank.
    // modelId left as disk-derived (SBD session model) unless overridden below.
  });

  // Expose the Gemini model name as a session marker (informational for disk logs).
  if (typeof payload.model === 'string' && payload.model) {
    rawState.session.agentCli = 'gemini';
    rawState.session.agentModel = payload.model;
  }

  // Git branch: renderStrip reads state.git.branch (not session.branch).
  if (typeof payload.git_branch === 'string' && payload.git_branch) {
    rawState.git = Object.assign({}, rawState.git || {}, { branch: payload.git_branch });
    rawState.session.branch = payload.git_branch; // belt-and-suspenders
  }

  // Context trigger label for the HUD context zone.
  rawState.context = Object.assign({}, rawState.context, {
    trigger: 'gemini-statusline',
    event: payload.agent_state === 'thinking' || payload.agent_state === 'running'
      ? null  // no special forge event; companion face handles expression
      : null,
  });

  return rawState;
}

// ── Main render ───────────────────────────────────────────────────────────────
function adaptAndRender(payload) {
  const rawState = buildRawState(payload);
  return renderSurface({ rawState, mode: 'strip' }).output;
}

// ── Entry point ───────────────────────────────────────────────────────────────
if (require.main === module) {
  try {
    const payload = readStdinSync();
    const line = adaptAndRender(payload);
    process.stdout.write(line + '\n');
    process.exit(0);
  } catch {
    // Fail-safe: never break the operator's statusline.
    const ts = new Date().toISOString().slice(11, 19);
    process.stdout.write(`[▅ ▄] gemini · hud err ${ts}\n`);
    process.exit(0);
  }
}

module.exports = { adaptAndRender, buildRawState, readStdinSync, usesSurfaceHost: true };
