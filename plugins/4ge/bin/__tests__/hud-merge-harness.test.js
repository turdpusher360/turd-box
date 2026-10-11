import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const _require = createRequire(import.meta.url);
const { mergeHarnessStdin } = _require('../hud-data-loader.cjs');
const { buildCanonicalState } = _require('../hud-state.cjs');

function freshState() { return buildCanonicalState({}); }

describe('mergeHarnessStdin — worktree and workspace', () => {
  it('maps worktree.branch to session.branch', () => {
    const state = freshState();
    mergeHarnessStdin(state, { worktree: { branch: 'feature-x' } });
    expect(state.session.branch).toBe('feature-x');
  });

  it('maps worktree.path to session.worktreePath', () => {
    const state = freshState();
    mergeHarnessStdin(state, { worktree: { path: '/opt/worktrees/feature-x' } });
    expect(state.session.worktreePath).toBe('/opt/worktrees/feature-x');
  });

  it('maps workspace.name to session.workspace', () => {
    const state = freshState();
    mergeHarnessStdin(state, { workspace: { name: 'my-workspace' } });
    expect(state.session.workspace).toBe('my-workspace');
  });
});

describe('mergeHarnessStdin — harness metadata', () => {
  it('maps version to session.harnessVersion', () => {
    const state = freshState();
    mergeHarnessStdin(state, { version: '2.1.98' });
    expect(state.session.harnessVersion).toBe('2.1.98');
  });

  it('maps output_style to session.outputStyle', () => {
    const state = freshState();
    mergeHarnessStdin(state, { output_style: 'explanatory' });
    expect(state.session.outputStyle).toBe('explanatory');
  });

  it('maps vim to session.vimMode', () => {
    const state = freshState();
    mergeHarnessStdin(state, { vim: true });
    expect(state.session.vimMode).toBe(true);
  });
});

describe('mergeHarnessStdin — cost breakdown', () => {
  it('maps cost.total_duration_ms to session.durationMs', () => {
    const state = freshState();
    mergeHarnessStdin(state, { cost: { total_duration_ms: 45000 } });
    expect(state.session.durationMs).toBe(45000);
  });

  it('maps cost.input_tokens to session.inputTokens', () => {
    const state = freshState();
    mergeHarnessStdin(state, { cost: { input_tokens: 12000 } });
    expect(state.session.inputTokens).toBe(12000);
  });

  it('maps cost.output_tokens to session.outputTokens', () => {
    const state = freshState();
    mergeHarnessStdin(state, { cost: { output_tokens: 5000 } });
    expect(state.session.outputTokens).toBe(5000);
  });

  it('maps cost.cache_read_tokens to session.cacheReadTokens', () => {
    const state = freshState();
    mergeHarnessStdin(state, { cost: { cache_read_tokens: 8000 } });
    expect(state.session.cacheReadTokens).toBe(8000);
  });

  it('maps cost.cache_creation_tokens to session.cacheCreationTokens', () => {
    const state = freshState();
    mergeHarnessStdin(state, { cost: { cache_creation_tokens: 3000 } });
    expect(state.session.cacheCreationTokens).toBe(3000);
  });
});

describe('mergeHarnessStdin — model breakdown', () => {
  it('maps model.id to session.modelId', () => {
    // model.id triggers the session-meta write-back (root = state.projectRoot ||
    // CLAUDE_PROJECT_DIR || cwd). Pin it to a temp root so a hook-spawned run
    // can never rewrite the live checkout's _runs/os/session-meta.json.
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hmh-model-root-'));
    try {
      const metaPath = path.join(tmpRoot, '_runs', 'os', 'session-meta.json');
      fs.mkdirSync(path.dirname(metaPath), { recursive: true });
      fs.writeFileSync(metaPath, JSON.stringify({ model: 'seed-model' }));
      const state = freshState();
      state.projectRoot = tmpRoot;

      mergeHarnessStdin(state, { model: { id: 'claude-opus-4-6' } });

      expect(state.session.modelId).toBe('claude-opus-4-6');
      // The write-back landed in the temp root, not the live checkout.
      expect(JSON.parse(fs.readFileSync(metaPath, 'utf8')).model).toBe('claude-opus-4-6');
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('maps model.provider to session.modelProvider', () => {
    const state = freshState();
    mergeHarnessStdin(state, { model: { provider: 'anthropic' } });
    expect(state.session.modelProvider).toBe('anthropic');
  });
});

describe('mergeHarnessStdin — context window', () => {
  it('maps context_window.remaining_tokens to session.remainingTokens', () => {
    const state = freshState();
    mergeHarnessStdin(state, { context_window: { remaining_tokens: 500000 } });
    expect(state.session.remainingTokens).toBe(500000);
  });
});

// Field shapes CC 2.1.280 actually sends on statusline stdin (binary-extracted,
// docs/hud/HUD-STANDARDS.md §3.5).
describe('mergeHarnessStdin — CC 2.1.280 stdin shape', () => {
  const cw280 = () => ({
    total_input_tokens: 118000,
    total_output_tokens: 9400,
    context_window_size: 1000000,
    current_usage: {
      input_tokens: 12,
      output_tokens: 9400,
      cache_creation_input_tokens: 3000,
      cache_read_input_tokens: 114988,
    },
    used_percentage: 12,
    remaining_percentage: 88,
  });

  it('labels the window from context_window_size', () => {
    const state = freshState();
    mergeHarnessStdin(state, { context_window: cw280() });
    expect(state.session.contextLabel).toBe('of 1M');
  });

  it('labels a 200K window', () => {
    const state = freshState();
    mergeHarnessStdin(state, { context_window: { ...cw280(), context_window_size: 200000 } });
    expect(state.session.contextLabel).toBe('of 200K');
  });

  it('derives remainingTokens from window size minus total_input_tokens', () => {
    const state = freshState();
    mergeHarnessStdin(state, { context_window: cw280() });
    expect(state.session.remainingTokens).toBe(1000000 - 118000);
  });

  it('falls back to remaining_percentage when total_input_tokens is absent', () => {
    const state = freshState();
    const cw = cw280();
    delete cw.total_input_tokens;
    mergeHarnessStdin(state, { context_window: cw });
    expect(state.session.remainingTokens).toBe(880000);
  });

  // Row 3 of the statusline shows the last response's output tokens only; the
  // context size is read once, as row 1's percentage (operator report
  // 2026-09-28). The current-context split is therefore not mapped.
  it('maps total_output_tokens and leaves the current_usage split unmapped', () => {
    const state = freshState();
    const cw = cw280();
    mergeHarnessStdin(state, { context_window: cw });
    expect(state.session.outputTokens).toBe(cw.total_output_tokens);
    expect(state.session.inputTokens).toBe(0);
    expect(state.session.cacheReadTokens).toBe(0);
    expect(state.session.cacheCreationTokens).toBe(0);
  });

  it('does not map total_input_tokens to input when current_usage is absent', () => {
    const state = freshState();
    const cw = cw280();
    delete cw.current_usage;
    mergeHarnessStdin(state, { context_window: cw });
    expect(state.session.inputTokens).toBe(0);
    expect(state.session.cacheReadTokens).toBe(0);
    // total_input_tokens still drives the remaining-token figure.
    expect(state.session.remainingTokens).toBe(cw.context_window_size - cw.total_input_tokens);
  });

  it('maps output_style.name to session.outputStyle', () => {
    const state = freshState();
    mergeHarnessStdin(state, { output_style: { name: 'Proactive' } });
    expect(state.session.outputStyle).toBe('Proactive');
  });

  it('maps a present vim object to session.vimMode', () => {
    const state = freshState();
    mergeHarnessStdin(state, { vim: { mode: 'NORMAL' } });
    expect(state.session.vimMode).toBe(true);
  });

  it('leaves vimMode off when the vim key is absent', () => {
    const state = freshState();
    mergeHarnessStdin(state, { output_style: { name: 'default' } });
    expect(state.session.vimMode).toBe(false);
  });
});

describe('mergeHarnessStdin — agent context', () => {
  it('maps agent.id to context.agentId', () => {
    const state = freshState();
    mergeHarnessStdin(state, { agent: { id: 'abc123' } });
    expect(state.context.agentId).toBe('abc123');
  });

  it('maps agent.type to context.agentType', () => {
    const state = freshState();
    mergeHarnessStdin(state, { agent: { type: 'hud-expert' } });
    expect(state.context.agentType).toBe('hud-expert');
  });

  it('maps agent.name to context.agentName', () => {
    const state = freshState();
    mergeHarnessStdin(state, { agent: { name: 'my-agent' } });
    expect(state.context.agentName).toBe('my-agent');
  });
});

describe('mergeHarnessStdin — defensive behavior', () => {
  it('ignores empty harness without throwing', () => {
    const state = freshState();
    expect(() => mergeHarnessStdin(state, {})).not.toThrow();
    expect(state.session.branch).toBe('');
  });

  it('ignores null harness', () => {
    const state = freshState();
    const result = mergeHarnessStdin(state, null);
    expect(result).toBe(state);
  });

  it('ignores wrong-type values', () => {
    const state = freshState();
    mergeHarnessStdin(state, { cost: { input_tokens: 'not a number' } });
    expect(state.session.inputTokens).toBe(0);
  });

  it('ignores non-boolean vim', () => {
    const state = freshState();
    mergeHarnessStdin(state, { vim: 1 });
    expect(state.session.vimMode).toBe(false);
  });

  it('ignores non-string branch', () => {
    const state = freshState();
    mergeHarnessStdin(state, { worktree: { branch: 42 } });
    expect(state.session.branch).toBe('');
  });
});

// Row 1's `◈` reads against the rig's manual compact line, so the loader keeps
// the used-token figure (current_usage's input + cache creation + cache read,
// the resident context scripts/context-now.cjs measures) next to the window size.
describe('mergeHarnessStdin — context tokens', () => {
  it('sums current_usage input, cache creation and cache read as the used tokens', () => {
    const state = freshState();
    mergeHarnessStdin(state, {
      context_window: {
        context_window_size: 1000000,
        current_usage: {
          input_tokens: 5,
          output_tokens: 800,
          cache_creation_input_tokens: 100,
          cache_read_input_tokens: 200,
        },
      },
    });
    expect(state.session.contextTokens).toBe(305);
    expect(state.session.contextTokensApprox).toBe(false);
    expect(state.session.contextWindowSize).toBe(1000000);
  });

  it('derives an approximate figure from used_percentage x window size without current_usage', () => {
    const state = freshState();
    mergeHarnessStdin(state, { context_window: { used_percentage: 33.5, context_window_size: 1000000 } });
    expect(state.session.contextTokens).toBe(335000);
    expect(state.session.contextTokensApprox).toBe(true);
  });

  it('does not treat total_input_tokens as the used tokens', () => {
    const state = freshState();
    mergeHarnessStdin(state, { context_window: { total_input_tokens: 999999, context_window_size: 1000000 } });
    expect(state.session.contextTokens).toBeUndefined();
  });

  it.each([
    ['no context_window', {}],
    ['null context_window', { context_window: null }],
    ['empty context_window', { context_window: {} }],
    ['null current_usage and no percent', { context_window: { current_usage: null, context_window_size: 1000000 } }],
    ['wrong-type usage fields', { context_window: { current_usage: { input_tokens: 'x', cache_read_input_tokens: -5 } } }],
    ['percent without a window size', { context_window: { used_percentage: 33 } }],
  ])('leaves the token figure unset for %s', (_name, harness) => {
    const state = freshState();
    expect(() => mergeHarnessStdin(state, harness)).not.toThrow();
    expect(state.session.contextTokens).toBeUndefined();
  });
});
