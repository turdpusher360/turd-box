import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);

function requireFresh() {
  for (const key of Object.keys(_require.cache)) {
    if (key.includes('hud-engine') || key.includes('hud-palette') || key.includes('hud-state') ||
        key.includes('hud-canvas') || key.includes('hud-zone') || key.includes('hud-expressions')) {
      delete _require.cache[key];
    }
  }
  return _require(path.resolve(__dirname, '../hud-engine.cjs'));
}

const { stripAnsi } = _require(path.resolve(__dirname, '../hud-palette.cjs'));

function makeCompactState(agentType, agentName) {
  return {
    terminal: { cols: 79, rows: 24 },
    session: {
      id: 'test',
      model: 'opus',
      contextPct: 20,
      rateLimits: { fiveHour: 10, sevenDay: 5 },
      uptime: 3600000,
      modelId: 'claude-opus-4-6',
    },
    os: {
      overallHealth: 'ready',
      bootTime: 100,
      capabilities: {
        memory: { ok: true, status: 'ready' },
        git: { ok: true, status: 'ready' },
      },
    },
    forge: { active: false, phase: null, teammates: [], scope: null },
    context: {
      trigger: 'command',
      event: null,
      zone: null,
      agentType: agentType || '',
      agentName: agentName || '',
    },
    theme: { name: 'plain' },
  };
}

describe('renderCompact agent-type emphasis', () => {
  it('includes agent name in output when present', () => {
    const { renderCompact } = requireFresh();
    const output = renderCompact(makeCompactState('', 'security-auditor'));
    const plain = stripAnsi(output);
    expect(plain).toContain('security-auditor');
  });

  it('includes agent type in output when no name', () => {
    const { renderCompact } = requireFresh();
    const output = renderCompact(makeCompactState('implementation', ''));
    const plain = stripAnsi(output);
    expect(plain).toContain('implementation');
  });

  it('omits agent label when both type and name are empty', () => {
    const { renderCompact } = requireFresh();
    const output = renderCompact(makeCompactState('', ''));
    const plain = stripAnsi(output);
    // Should just show health info, no trailing agent name
    expect(plain).toContain('Health');
    // The output should end with the health bar, not an agent label
    expect(plain).not.toContain('audit');
    expect(plain).not.toContain('implementation');
  });

  it('produces valid output for audit agent context', () => {
    const { renderCompact } = requireFresh();
    const output = renderCompact(makeCompactState('audit', 'master-auditor'));
    expect(typeof output).toBe('string');
    expect(output.length).toBeGreaterThan(0);
    const plain = stripAnsi(output);
    expect(plain).toContain('master-auditor');
  });

  it('produces valid output for implementation agent context', () => {
    const { renderCompact } = requireFresh();
    const output = renderCompact(makeCompactState('implementation', 'sonnet-execute'));
    expect(typeof output).toBe('string');
    const plain = stripAnsi(output);
    expect(plain).toContain('sonnet-execute');
  });

  it('does not crash with event and agent context combined', () => {
    const { renderCompact } = requireFresh();
    const state = makeCompactState('audit', 'security-auditor');
    state.context.event = 'test-pass';
    const output = renderCompact(state);
    expect(typeof output).toBe('string');
    const plain = stripAnsi(output);
    expect(plain).toContain('all tests green');
    expect(plain).toContain('security-auditor');
  });
});

describe('renderCompact AGENT_EMPHASIS named-agent map (W5 T5.2 expansion)', () => {
  // Audit agents should be in output and produce non-muted coloring (health color)
  const AUDIT_AGENTS = [
    'master-auditor', 'opus-audit', 'opus-review',
    'dfe-security', 'dfe-existence', 'dfe-logic',
    'dfe-runtime', 'dfe-artifacts', 'DFE',
  ];

  // Implementation agents should appear with accent coloring
  const IMPL_AGENTS = [
    'sonnet-execute', 'sonnet-research', 'opus-planner',
    'forge-brainstorm', 'forge-planner', 'forge-shipper',
  ];

  for (const agentName of AUDIT_AGENTS) {
    it(`includes ${agentName} in compact output`, () => {
      const { renderCompact } = requireFresh();
      const output = renderCompact(makeCompactState('', agentName));
      const plain = stripAnsi(output);
      expect(plain).toContain(agentName);
    });
  }

  for (const agentName of IMPL_AGENTS) {
    it(`includes ${agentName} in compact output`, () => {
      const { renderCompact } = requireFresh();
      const output = renderCompact(makeCompactState('', agentName));
      const plain = stripAnsi(output);
      expect(plain).toContain(agentName);
    });
  }

  it('shows sonnet-research with muted emphasis (present in output)', () => {
    const { renderCompact } = requireFresh();
    const output = renderCompact(makeCompactState('', 'sonnet-research'));
    const plain = stripAnsi(output);
    expect(plain).toContain('sonnet-research');
  });

  it('shows general-purpose with muted emphasis (present in output)', () => {
    const { renderCompact } = requireFresh();
    const output = renderCompact(makeCompactState('', 'general-purpose'));
    const plain = stripAnsi(output);
    expect(plain).toContain('general-purpose');
  });

  it('named-agent lookup takes precedence over agentType substring match', () => {
    // Pass agentName=security-auditor with agentType=generic — named map should win
    const { renderCompact } = requireFresh();
    const output = renderCompact(makeCompactState('generic', 'security-auditor'));
    expect(typeof output).toBe('string');
    const plain = stripAnsi(output);
    expect(plain).toContain('security-auditor');
  });
});
