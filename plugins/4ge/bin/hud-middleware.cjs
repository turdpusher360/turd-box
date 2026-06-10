#!/usr/bin/env node
'use strict';

/**
 * hud-middleware.cjs — Output Middleware Prototype (Spike D)
 *
 * Three approaches tested for wrapping Claude Code output with HUD scenes:
 *
 * D1: PostToolUse hook with additionalContext (hookSpecificOutput)
 * D2: Pipe wrapper (stdin/stdout transform around `claude` CLI)
 * D3: PostToolUse hook with updatedMCPToolOutput
 *
 * This file contains working implementations for each approach plus
 * a demo harness that exercises them standalone (node hud-middleware.cjs --demo).
 *
 * @spike S244
 * @status prototype
 */

const path = require('node:path');
const fs = require('node:fs');

// --- Resolve engine paths relative to this file ---
const ENGINE_PATH = path.resolve(__dirname, 'hud-engine.cjs');
const DATA_LOADER_PATH = path.resolve(__dirname, 'hud-data-loader.cjs');
const PALETTE_PATH = path.resolve(__dirname, 'hud-palette.cjs');

let loadHudData, renderByMode, resolvePalette, colorize, stripAnsi;
try {
  loadHudData = require(DATA_LOADER_PATH).loadHudData;
  renderByMode = require(ENGINE_PATH).renderByMode;
  const pal = require(PALETTE_PATH);
  resolvePalette = pal.resolvePalette;
  colorize = pal.colorize;
  stripAnsi = pal.stripAnsi;
} catch (err) {
  // Engine not available — report and exit
  process.stderr.write(`[hud-middleware] Engine load failed: ${err.message}\n`);
  process.exit(0);
}

// ============================================================================
// APPROACH D1: PostToolUse additionalContext injection
// ============================================================================
// How it works:
//   PostToolUse hooks can output JSON with hookSpecificOutput.additionalContext.
//   The harness injects this string as an assistant-visible message in the
//   conversation context. The model sees it; the user sees it in transcript.
//
// This function generates the JSON a PostToolUse hook would write to stdout.
// The scene content goes into additionalContext as a string.
//
// Findings:
//   - additionalContext IS injected into the model's conversation context
//   - It appears as a system-injected note after the tool result
//   - ANSI codes survive in the context (model sees raw escape sequences)
//   - The terminal renders the ANSI when the model echoes it back
//   - 10K character cap on additionalContext (per S232-B DFE finding)
//   - Content is NOT rendered to the user's terminal directly — it goes
//     into the model context only. The model may or may not echo it.
//   - Key insight: this is a "suggestion to the model" not "output to user"
// ============================================================================

function buildD1Output(sceneType, hudState, eventName = 'PostToolUse') {
  const mode = sceneType === 'strip' ? 'strip' : 'compact';
  const rendered = renderByMode(hudState, mode);

  if (!rendered || !rendered.trim()) return null;

  // Strip ANSI for additionalContext — the model doesn't render ANSI,
  // but ANSI in context wastes tokens. Use plain text for the model,
  // let the model decide what to show the user.
  const plain = stripAnsi(rendered);

  // Build the scene frame
  const frame = [
    `[HUD:${sceneType}]`,
    plain,
    `[/HUD]`,
  ].join('\n');

  // Respect the ~10K cap
  const capped = frame.length > 9500 ? frame.slice(0, 9500) + '\n[truncated]' : frame;

  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext: capped,
    },
  });
}

// ============================================================================
// APPROACH D2: Pipe wrapper / stream transformer
// ============================================================================
// How it works:
//   A wrapper script that sits between the claude CLI and the terminal.
//   Reads claude's stdout, detects scene markers like [SCENE:boot],
//   replaces them with rendered ANSI scenes from the engine.
//
// Findings:
//   - Claude Code uses Ink (React for CLI) which renders via a custom
//     terminal output protocol. It does NOT use simple line-by-line stdout.
//   - Ink uses raw mode, cursor positioning, alternate screen buffer, etc.
//   - Piping claude's stdout through a transformer BREAKS the Ink UI
//     because Ink detects non-TTY stdout and switches to a degraded mode
//     (no colors, no cursor movement, no incremental updates)
//   - Even if we use a PTY (pseudo-terminal) wrapper, the Ink rendering
//     tree uses absolute cursor positions that our transformer can't
//     safely modify without understanding the full rendering state
//   - VERDICT: D2 is not viable for wrapping the interactive claude CLI
//
//   However, D2 IS viable for wrapping claude's non-interactive mode:
//     claude --print "prompt" | node hud-middleware.cjs --pipe
//   In --print mode, claude outputs plain text (no Ink), so pipe works.
// ============================================================================

function createPipeTransformer() {
  const { Transform } = require('node:stream');

  // Scene marker regex: [SCENE:name] or [SCENE:name:variant]
  const SCENE_RE = /\[SCENE:(\w+)(?::(\w+))?\]/g;

  return new Transform({
    transform(chunk, encoding, callback) {
      let text = chunk.toString('utf8');
      let modified = false;

      text = text.replace(SCENE_RE, (match, sceneName, variant) => {
        modified = true;
        try {
          const raw = loadHudData({ cwd: process.cwd(), runExpensiveProbes: false });
          // Inject scene context
          raw.context = raw.context || {};
          raw.context.event = sceneName;
          if (variant) raw.context.zone = variant;

          const mode = variant === 'strip' ? 'strip' : 'compact';
          const rendered = renderByMode(raw, mode);
          return rendered || match;
        } catch (err) {
          process.stderr.write(`[hud-middleware:pipe] render error: ${err.message}\n`);
          return match;
        }
      });

      callback(null, text);
    },
  });
}

// ============================================================================
// APPROACH D3: PostToolUse updatedMCPToolOutput
// ============================================================================
// How it works:
//   PostToolUse hooks can return hookSpecificOutput.updatedMCPToolOutput
//   which REPLACES the tool result that the model sees.
//
// Findings:
//   - updatedMCPToolOutput works ONLY for MCP tool results (not built-in tools)
//   - It replaces the tool_result content entirely — not append, not wrap
//   - We cannot use it to "wrap" Read/Write/Bash results with scene frames
//     because it's MCP-only
//   - We COULD create a custom MCP tool (e.g., mcp__hud__scene) that returns
//     scene content, then use updatedMCPToolOutput to modify that result
//   - But that adds a tool call round-trip just to render a scene
//   - The model would have to explicitly call mcp__hud__scene, which defeats
//     the "automatic scene injection" goal
//   - VERDICT: D3 is not viable for automatic scene wrapping.
//     It's viable only for enriching MCP results with visual context
//     (which mcp-output-enrich.cjs already does for memory_search).
//
//   Possible hybrid: use D3 to inject scene frames into memory_search results
//   so the model sees "here's your memory results, rendered in a scene frame."
//   Novelty factor but no real utility.
// ============================================================================

function buildD3Output(mcpToolResult, sceneType, hudState, eventName = 'PostToolUse') {
  // This wraps an MCP tool result with scene framing
  const mode = sceneType === 'strip' ? 'strip' : 'compact';
  const rendered = renderByMode(hudState, mode);
  if (!rendered) return null;

  const plain = stripAnsi(rendered);

  // Prepend scene frame to the tool result
  const framed = `[HUD:${sceneType}]\n${plain}\n[/HUD]\n\n${mcpToolResult}`;

  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: eventName,
      updatedMCPToolOutput: framed,
    },
  });
}

// ============================================================================
// APPROACH D4 (DISCOVERED): PostToolUse stdout as conversation injection
// ============================================================================
// How it works:
//   PostToolUse hooks that write plain text to stdout have that text
//   injected into the model's conversation context as a system message.
//   The scene-spike.cjs hook already proves this works.
//
// Key observations from scene-spike.cjs behavior:
//   - Stdout text appears as a hook warning/note in the conversation
//   - The model receives it and can reference it
//   - ANSI escape codes in stdout DO reach the conversation context
//   - The harness shows hook stdout to the user in a collapsed "hook output"
//     section (visible in the terminal UI)
//   - Content is NOT streamed to the user as if Claude typed it
//   - Content IS visible to the model for its next response
//
// This is actually the MOST VIABLE approach for scene injection:
//   1. Fires automatically on every Nth tool call (frequency control)
//   2. Content goes to both model context AND user terminal (hook output)
//   3. No 10K cap (unlike additionalContext)
//   4. Already proven by scene-spike.cjs
//
// The difference from D1:
//   D1 (additionalContext): model sees it, user sees it only if model echoes
//   D4 (raw stdout): model sees it, user sees it in hook output section
//   Both are "persistent" in the sense of being in conversation context.
//   Neither is "persistent" in the terminal viewport (both scroll away).
// ============================================================================

function buildD4Output(sceneType, hudState) {
  const mode = sceneType === 'full' ? 'full' : sceneType === 'strip' ? 'strip' : 'compact';
  const rendered = renderByMode(hudState, mode);
  if (!rendered || !rendered.trim()) return null;

  // Raw stdout — ANSI included. The terminal will render it in the
  // hook output section.
  const lineCount = rendered.split('\n').length;
  const label = mode === 'strip' ? 'STRIP' : mode === 'full' ? `SCENE (${lineCount} lines)` : 'CARD';

  return [
    `\n--- HUD ${label} ---`,
    rendered,
    `--- /HUD ---\n`,
  ].join('\n');
}

// ============================================================================
// APPROACH D5 (DISCOVERED): Hybrid D1 + D4 for dual-channel
// ============================================================================
// The most promising approach: combine additionalContext (D1) for the model
// with raw stdout (D4) for the terminal display.
//
// additionalContext: plain-text scene description for the model to use
//   in its responses (e.g., "Forge is in Phase 3, health 85%, 2 degraded caps")
// stdout: full ANSI-rendered scene for the terminal hook output section
//
// This gives us:
//   - Model awareness of HUD state (via additionalContext, compact)
//   - Visual terminal output (via stdout, full ANSI)
//   - The model can REFERENCE the HUD state without having to parse ANSI
// ============================================================================

function buildD5Output(sceneType, hudState, eventName = 'PostToolUse') {
  // Channel 1: Model context (plain text, compact)
  const compactRendered = renderByMode(hudState, 'compact');
  const plainCompact = compactRendered ? stripAnsi(compactRendered) : '';

  // Channel 2: Terminal display (full ANSI)
  const mode = sceneType === 'full' ? 'full' : 'compact';
  const terminalRendered = renderByMode(hudState, mode);

  if (!terminalRendered || !terminalRendered.trim()) return null;

  // Build stdout (terminal channel)
  const lineCount = terminalRendered.split('\n').length;
  const terminalOutput = [
    `\n--- HUD SCENE (${lineCount} lines) ---`,
    terminalRendered,
    `--- /HUD ---\n`,
  ].join('\n');

  // Build hookSpecificOutput (model channel)
  const modelContext = plainCompact
    ? `[HUD-STATE] ${plainCompact.replace(/\n/g, ' | ')} [/HUD-STATE]`
    : null;

  // Return both channels
  return {
    stdout: terminalOutput,
    json: modelContext ? JSON.stringify({
      hookSpecificOutput: {
        hookEventName: eventName,
        additionalContext: modelContext,
      },
    }) : null,
  };
}

// ============================================================================
// DEMO HARNESS
// ============================================================================

function runDemo() {
  const raw = loadHudData({ cwd: process.cwd(), runExpensiveProbes: false });
  const palette = resolvePalette();

  console.log('='.repeat(72));
  console.log('  HUD MIDDLEWARE SPIKE D — APPROACH DEMONSTRATIONS');
  console.log('='.repeat(72));

  // D1: additionalContext
  console.log('\n--- APPROACH D1: additionalContext (model-only, plain text) ---\n');
  const d1 = buildD1Output('commit', raw);
  if (d1) {
    const parsed = JSON.parse(d1);
    console.log('hookSpecificOutput.additionalContext:');
    console.log(parsed.hookSpecificOutput.additionalContext);
  }

  // D4: raw stdout (terminal + model)
  console.log('\n--- APPROACH D4: raw stdout (terminal ANSI + model context) ---\n');
  const d4compact = buildD4Output('compact', raw);
  if (d4compact) process.stdout.write(d4compact);
  console.log('');
  const d4full = buildD4Output('full', raw);
  if (d4full) process.stdout.write(d4full);

  // D5: hybrid dual-channel
  console.log('\n--- APPROACH D5: hybrid (model=plain, terminal=ANSI) ---\n');
  const d5 = buildD5Output('full', raw);
  if (d5) {
    console.log('Terminal channel:');
    process.stdout.write(d5.stdout);
    console.log('\nModel channel (additionalContext):');
    console.log(d5.json ? JSON.parse(d5.json).hookSpecificOutput.additionalContext : '(none)');
  }

  // D2: pipe demo
  console.log('\n--- APPROACH D2: pipe transformer (demo with sample text) ---\n');
  const sample = 'Starting work... [SCENE:boot] Loading system... [SCENE:forge:strip] Done.';
  console.log('Input:  ' + sample);
  const transformer = createPipeTransformer();
  let pipeOutput = '';
  transformer.on('data', (chunk) => { pipeOutput += chunk.toString(); });
  transformer.write(sample);
  transformer.end();
  // Sync drain for demo
  setTimeout(() => {
    console.log('Output: ' + (pipeOutput || '(transformer produced no output — engine may need stdin data)'));
  }, 50);

  // Findings summary
  setTimeout(() => {
    console.log('\n' + '='.repeat(72));
    console.log('  VIABILITY MATRIX');
    console.log('='.repeat(72));
    console.log('');
    console.log('  Approach  | Viable | Model sees | User sees      | Auto  | Notes');
    console.log('  ---------|--------|------------|----------------|-------|------');
    console.log('  D1 ctxAdd | YES    | YES        | Only if echoed | YES   | 10K cap, plain text');
    console.log('  D2 pipe   | NO*    | N/A        | YES            | YES   | Breaks Ink UI (*ok for --print)');
    console.log('  D3 mcpOut | NO     | YES        | No             | NO    | MCP tools only, replaces result');
    console.log('  D4 stdout | YES    | YES        | Hook output    | YES   | scene-spike proves it, ANSI ok');
    console.log('  D5 hybrid | BEST   | YES(plain) | YES(ANSI)      | YES   | Two channels, best of both');
    console.log('');
    console.log('  RECOMMENDATION: D5 hybrid (additionalContext + stdout)');
    console.log('  FALLBACK:       D4 stdout-only (simpler, already proven)');
    console.log('');
  }, 100);
}

// ============================================================================
// EXPORTS (for use by hooks and other modules)
// ============================================================================

module.exports = {
  // D1
  buildD1Output,
  // D2
  createPipeTransformer,
  // D3
  buildD3Output,
  // D4
  buildD4Output,
  // D5 (recommended)
  buildD5Output,
};

// ============================================================================
// CLI ENTRY
// ============================================================================

if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.includes('--demo')) {
    runDemo();
  } else if (args.includes('--pipe')) {
    // Pipe mode: act as stdin->stdout transformer for claude --print
    const transformer = createPipeTransformer();
    process.stdin.pipe(transformer).pipe(process.stdout);
  } else {
    console.log('Usage:');
    console.log('  node hud-middleware.cjs --demo     Run approach demonstrations');
    console.log('  node hud-middleware.cjs --pipe     Pipe transformer (for claude --print)');
    console.log('  claude --print "prompt" | node hud-middleware.cjs --pipe');
  }
}
