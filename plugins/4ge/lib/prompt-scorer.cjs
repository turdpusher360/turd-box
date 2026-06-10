'use strict';

const ACTION_VERBS = [
  'implement', 'create', 'build', 'add', 'fix', 'refactor', 'update', 'remove',
  'delete', 'move', 'rename', 'extract', 'test', 'debug', 'deploy', 'configure',
  'integrate', 'migrate', 'optimize', 'review',
];

const CONSTRAINT_WORDS = [
  'under', 'limit', 'only', 'without', 'no more than', 'at most', 'must',
  'should', 'ensure', 'require', 'constraint', 'maximum', 'minimum',
];

const FILE_PATH_REGEX = /(?:[\w.-]+\/)+[\w.-]+\.\w+/g;
const SPECIFIC_NOUN_REGEX = /[A-Z][a-z]+(?:[A-Z][a-z]+)+/g; // PascalCase words

const SCORING_CRITERIA = {
  action_verbs: { max: 2, description: 'Clear action verb (implement, fix, create, etc.)' },
  file_paths: { max: 2, description: 'Specific file paths referenced' },
  specific_nouns: { max: 2, description: 'Specific identifiers (component names, functions, etc.)' },
  constraints: { max: 2, description: 'Constraints or requirements specified' },
  length: { max: 2, description: 'Sufficient detail (not too short, not too long)' },
};

/**
 * Scores a user prompt on a 0-10 scale.
 * @param {string} prompt
 * @returns {{ score: number, skipped: boolean, breakdown: Record<string, number> }}
 */
function scorePrompt(prompt) {
  if (prompt.startsWith('/')) return { score: 0, skipped: true, breakdown: {} };

  const words = prompt.toLowerCase().split(/\s+/);
  const breakdown = {
    action_verbs: 0,
    file_paths: 0,
    specific_nouns: 0,
    constraints: 0,
    length: 0,
  };

  // Action verbs (0-2)
  const verbCount = words.filter(w => ACTION_VERBS.includes(w)).length;
  breakdown.action_verbs = Math.min(verbCount, 2);

  // File paths (0-2)
  const paths = prompt.match(FILE_PATH_REGEX) || [];
  breakdown.file_paths = Math.min(paths.length, 2);

  // Specific nouns — PascalCase identifiers (0-2)
  const nouns = prompt.match(SPECIFIC_NOUN_REGEX) || [];
  breakdown.specific_nouns = Math.min(nouns.length, 2);

  // Constraints (0-2)
  const lowerPrompt = prompt.toLowerCase();
  const constraintCount = CONSTRAINT_WORDS.filter(c => lowerPrompt.includes(c)).length;
  breakdown.constraints = Math.min(constraintCount, 2);

  // Length (0-2): good prompts are 10-100 words
  if (words.length >= 10 && words.length <= 100) breakdown.length = 2;
  else if (words.length >= 5) breakdown.length = 1;
  else breakdown.length = 0;

  const score = Object.values(breakdown).reduce((a, b) => a + b, 0);
  return { score, skipped: false, breakdown };
}

/**
 * Suggests improvements for low-scoring prompts.
 * Returns an empty suggestions array when score >= 7.
 * @param {string} prompt
 * @returns {{ score: number, suggestions: string[] }}
 */
function suggestImprovements(prompt) {
  const { score, skipped, breakdown } = scorePrompt(prompt);
  if (skipped || score >= 7) return { score, suggestions: [] };

  const suggestions = [];
  if (breakdown.action_verbs === 0) {
    suggestions.push('Start with an action verb: implement, fix, create, refactor, test');
  }
  if (breakdown.file_paths === 0) {
    suggestions.push('Reference specific files: src/components/UserCard.tsx');
  }
  if (breakdown.specific_nouns === 0) {
    suggestions.push('Name specific identifiers: UserCard, validateSchema, handleAuth');
  }
  if (breakdown.constraints === 0) {
    suggestions.push('Add constraints: "under 100 lines", "using Tailwind only", "must handle errors"');
  }
  if (breakdown.length < 2) {
    suggestions.push('Add more detail about what you want and where');
  }

  return { score, suggestions };
}

module.exports = { scorePrompt, suggestImprovements, SCORING_CRITERIA, ACTION_VERBS };
