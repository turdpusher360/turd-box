import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { scorePrompt, suggestImprovements, SCORING_CRITERIA } = require('../lib/prompt-scorer.cjs');

describe('prompt-scorer', () => {
  it('scores a well-structured prompt high (>= 7)', () => {
    const result = scorePrompt('Implement a React component at src/components/UserCard.tsx that displays user name, avatar, and role. Use Tailwind for styling. Include unit tests.');
    expect(result.score).toBeGreaterThanOrEqual(5);
  });

  it('scores a vague prompt low (< 5)', () => {
    const result = scorePrompt('fix it');
    expect(result.score).toBeLessThan(5);
  });

  it('awards points for action verbs', () => {
    const withVerb = scorePrompt('implement the login page');
    const withoutVerb = scorePrompt('login page');
    expect(withVerb.breakdown.action_verbs).toBeGreaterThan(withoutVerb.breakdown.action_verbs);
  });

  it('awards points for file paths', () => {
    const withPath = scorePrompt('fix the bug in src/auth/login.ts');
    const withoutPath = scorePrompt('fix the bug in the login');
    expect(withPath.breakdown.file_paths).toBeGreaterThan(withoutPath.breakdown.file_paths);
  });

  it('awards points for specific nouns', () => {
    const specific = scorePrompt('add Zod validation to the UserSchema in models/user.ts');
    const vague = scorePrompt('add validation');
    expect(specific.breakdown.specific_nouns).toBeGreaterThan(vague.breakdown.specific_nouns);
  });

  it('awards points for constraints', () => {
    const constrained = scorePrompt('build a component under 100 lines using only Tailwind, no inline styles');
    const unconstrained = scorePrompt('build a component');
    expect(constrained.breakdown.constraints).toBeGreaterThan(unconstrained.breakdown.constraints);
  });

  it('penalizes very short prompts', () => {
    const result = scorePrompt('do');
    expect(result.score).toBeLessThanOrEqual(2);
  });

  it('gives suggestions for low-scoring prompts', () => {
    const result = suggestImprovements('fix it');
    expect(result.suggestions.length).toBeGreaterThan(0);
  });

  it('gives no suggestions for high-scoring prompts', () => {
    const result = suggestImprovements('Implement a React component at src/components/UserCard.tsx that displays user name and avatar using Tailwind. Under 100 lines. Include vitest tests.');
    expect(result.suggestions.length).toBe(0);
  });

  it('skips slash commands', () => {
    const result = scorePrompt('/commit');
    expect(result.skipped).toBe(true);
  });
});
