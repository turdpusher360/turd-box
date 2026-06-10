'use strict';

/**
 * Shared question definitions for progressive disclosure.
 * Each question defines: id, prompt, options, skipCondition.
 */
const SHARED_QUESTIONS = {
  scope: {
    id: 'scope',
    prompt: 'Scope?',
    options: [
      'Full sweep (all categories)',
      'Quick check (score only)',
      'Specific area (choose category)',
      'Changed files only (dirty worktree)',
    ],
  },
  depth: {
    id: 'depth',
    prompt: 'Research depth?',
    options: [
      'Quick (memory + codebase, ~15min)',
      'Standard (+ web search, ~30min)',
      'Deep (+ context7 + OSV, ~60min)',
    ],
  },
  output: {
    id: 'output',
    prompt: 'Output destination?',
    options: [
      'Inline (show here)',
      '_runs/ report (save to file)',
      'Both',
    ],
  },
};

/**
 * Workflow-specific menu trees (Guided mode).
 * Each workflow defines an array of question steps with skip conditions.
 */
const WORKFLOW_MENUS = {
  build: [
    {
      id: 'what',
      prompt: 'What are we building?',
      options: ['New feature', 'Enhancement to existing feature', 'Refactor / restructure', '(describe in your own words)'],
      skipIf: (flags, args) => args.description && args.description.length > 0,
    },
    {
      id: 'team_size',
      prompt: 'Team size?',
      options: ['Solo (just me, <50 LOC)', 'Small team (2-3 agents)', 'Full team (4+ agents, parallel)', 'Auto (let forge decide)'],
      skipIf: (flags) => flags.solo || flags.team || flags.auto,
    },
    {
      id: 'resume',
      prompt: 'Starting fresh or resuming?',
      options: ['New session', 'Resume previous (shows recent sessions)'],
      skipIf: (flags, args, context) => !context.hasParkedSessions || flags.resume,
    },
  ],
  fix: [
    {
      id: 'what_broken',
      prompt: "What's broken?",
      options: ['Tests failing', 'Runtime error', 'Build/type error', '(describe the problem)'],
      skipIf: (flags, args) => args.description && args.description.length > 0,
    },
    {
      id: 'when',
      prompt: 'When did it start?',
      options: ['This session (recent change)', 'After a specific commit', 'Unknown / gradual', "It's always been broken"],
      skipIf: (flags, args) => args.hasStackTrace,
    },
    {
      id: 'evidence',
      prompt: 'Evidence available?',
      options: ['Stack trace / error output', 'Failing test name', 'Reproduction steps', 'No evidence, just vibes'],
      skipIf: (flags, args) => args.hasErrorOutput,
    },
  ],
  improve: [
    {
      id: 'scope',
      prompt: 'Scope?',
      options: ['Full sweep (all 9 categories)', 'Quick check (score only)', 'Specific category', 'Changed files only'],
      skipIf: (flags) => flags.quick || flags.category || flags['auto-safe'],
    },
    {
      id: 'category',
      prompt: 'Category focus?',
      options: [], // populated dynamically from config
      skipIf: (flags, args, context) => context.lastAnswer?.scope !== 2, // only if Q1 = [3]
    },
    {
      id: 'fix_approach',
      prompt: 'Fix approach?',
      options: ['Auto-fix safe items, ask for the rest', 'Show me everything, I\'ll pick', 'Report only (no fixes)', 'Dry run (show fixes, don\'t apply)'],
      skipIf: (flags) => flags['auto-safe'] || flags.report || flags['dry-run'],
    },
  ],
  review: [
    {
      ...SHARED_QUESTIONS.scope,
      options: ['Full audit (all domains)', 'Security only', 'Specific domain', 'Quick pre-commit check'],
      skipIf: (flags, args) => args.domain && args.domain.length > 0,
    },
    {
      ...SHARED_QUESTIONS.depth,
      skipIf: (flags) => flags.quick || flags.deep,
    },
  ],
  explore: [
    {
      id: 'what_understand',
      prompt: 'What do you want to understand?',
      options: ['How does [X] work? (architecture)', 'Search for [query] (memory + codebase)', 'Map the repo (onboarding)', '(describe what you\'re looking for)'],
      skipIf: (flags, args) => args.query && args.query.length > 0,
    },
    {
      id: 'query',
      prompt: 'Search query?',
      options: [], // free text
      skipIf: (flags, args, context) => context.lastAnswer?.what_understand !== 1 || (args.query && args.query.length > 0),
    },
    {
      ...SHARED_QUESTIONS.scope,
      options: ['This repo only', 'Include web search', 'Include memory hub', 'All sources'],
      skipIf: (flags) => flags.local || flags.deep,
    },
  ],
  plan: [
    {
      id: 'what_planning',
      prompt: 'What are we planning?',
      options: [], // always free text
      skipIf: (flags, args) => args.description && args.description.length > 0,
    },
    {
      ...SHARED_QUESTIONS.depth,
      options: ['Quick sketch (outline only)', 'Full spec + plan (brainstorm -> spec -> plan)', 'Deep spec (with DFE review passes)'],
      skipIf: (flags, args) => args.description && args.description.length > 200,
    },
    {
      id: 'constraints',
      prompt: 'Constraints?',
      options: ['No constraints', 'Must not touch [files/dirs]', 'Must complete in [N] hours', '(describe constraints)'],
      skipIf: (flags, args) => args.hasConstraints,
    },
  ],
};

const CREATIVE_TRIGGERS = ['brainstorm', 'vision', 'explore ideas', 'design thinking', 'ideate'];

/**
 * Detect interaction mode from flags, args, and context.
 * @param {Object} flags - parsed CLI flags
 * @param {Object} args - parsed arguments
 * @param {Object} context - runtime context (hasParkedSessions, etc.)
 * @returns {{ mode: 'quick'|'guided'|'creative', skip: string[] }}
 */
function detectMode(flags, args, context) {
  // Explicit mode flags take priority
  if (flags.quick || flags.ci || flags.preflight) {
    return { mode: 'quick', skip: [] };
  }
  if (flags.guided) {
    return { mode: 'guided', skip: [] };
  }
  if (flags.creative) {
    return { mode: 'creative', skip: [] };
  }

  // Check for creative triggers in description
  const desc = (args.description || '').toLowerCase();
  if (CREATIVE_TRIGGERS.some(trigger => desc.includes(trigger))) {
    return { mode: 'creative', skip: [] };
  }

  // Default to guided
  return { mode: 'guided', skip: [] };
}

/**
 * Get the menu tree for a workflow.
 * @param {string} workflowName
 * @returns {Array|null}
 */
function getMenuTree(workflowName) {
  return WORKFLOW_MENUS[workflowName] || null;
}

/**
 * Get a shared question definition.
 * @param {string} questionId
 * @returns {Object|null}
 */
function getSharedQuestion(questionId) {
  return SHARED_QUESTIONS[questionId] || null;
}

module.exports = {
  SHARED_QUESTIONS,
  WORKFLOW_MENUS,
  CREATIVE_TRIGGERS,
  detectMode,
  getMenuTree,
  getSharedQuestion,
};
