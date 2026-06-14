'use strict';

// Name-only expression resolver for HUD surfaces.
// Rendering lives in companion-face/companion-state; this module only maps
// state/event inputs to the expression names those renderers consume.

// Priority-ordered rules. First match wins.
const EXPRESSION_RULES = [
  // Forge-related
  { match: (s) => s.context.event === 'forge-start',      expr: 'determined' },
  { match: (s) => s.context.event === 'forge-complete',   expr: 'excited' },
  { match: (s) => s.forge.active && s.forge.phase,        expr: 'focused' },

  // Test results
  { match: (s) => s.context.event === 'test-pass',        expr: 'happy' },
  { match: (s) => s.context.event === 'test-fail',        expr: 'sad' },

  // Capability degradation
  { match: (s) => countDegraded(s) >= 4,                  expr: 'angry' },
  { match: (s) => countDegraded(s) >= 2,                  expr: 'suspicious' },
  { match: (s) => countDegraded(s) === 1,                 expr: 'curious' },

  // Context window pressure
  { match: (s) => s.session.contextPct >= 80,             expr: 'sleepy' },
  { match: (s) => s.session.contextPct >= 60,             expr: 'thinking' },

  // Export
  { match: (s) => s.context.event === 'export',           expr: 'winking' },

  // Badge earned
  { match: (s) => s.context.event === 'badge-earned',     expr: 'excited' },

  // Boot sequence
  { match: (s) => s.context.event === 'boot',             expr: 'surprised' },

  // Session end
  { match: (s) => s.context.event === 'session-end',      expr: 'sleepy' },

  // Blink
  { match: (s) => s.context.event === 'blink',            expr: 'blinking' },

  // Default idle identity. Plain symmetric neutral is reserved for explicit
  // resets; default idle stays aligned with companion-state.
  { match: () => true,                                    expr: 'neutral alive' },
];

function countDegraded(state) {
  // Skip shelved capabilities (intentionally degraded, not actionable).
  const caps = (state.os && state.os.capabilities) || {};
  let count = 0;
  for (const c of Object.values(caps)) {
    if (c && c.ok === false && c.shelved !== true) count++;
  }
  return count;
}

function getExpressionName(state) {
  for (const rule of EXPRESSION_RULES) {
    try {
      if (rule.match(state || {})) return rule.expr;
    } catch {
      continue;
    }
  }
  return 'neutral alive';
}

module.exports = {
  EXPRESSION_RULES,
  getExpressionName,
};
