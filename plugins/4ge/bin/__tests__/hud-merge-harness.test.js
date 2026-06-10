import { describe, it, expect } from 'vitest';
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
    const state = freshState();
    mergeHarnessStdin(state, { model: { id: 'claude-opus-4-6' } });
    expect(state.session.modelId).toBe('claude-opus-4-6');
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
