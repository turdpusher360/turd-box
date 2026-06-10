'use strict';

const DEFAULT_MAX_OPTIONS = 4;

/**
 * Formats an array of options as a numbered list [1] [2] [3] [4].
 */
function formatOptions(options, maxOptions) {
  const limit = maxOptions || DEFAULT_MAX_OPTIONS;
  const capped = options.slice(0, limit);
  return capped.map((opt, i) => `[${i + 1}] ${opt}`).join('\n');
}

/**
 * Parses user input to resolve which option was selected.
 * Accepts: numeric (1-4) or text match (case-insensitive).
 *
 * @returns {string|null} Selected option text, or null if invalid
 */
function parseChoice(input, options) {
  if (!input || !options || options.length === 0) return null;

  const trimmed = input.trim();

  // Numeric match
  const num = parseInt(trimmed, 10);
  if (!isNaN(num) && num >= 1 && num <= options.length) {
    return options[num - 1];
  }

  // Text match (case-insensitive)
  const lower = trimmed.toLowerCase();
  const match = options.find(opt => opt.toLowerCase() === lower);
  return match || null;
}

/**
 * Creates a decision point for lounge mode.
 */
function createDecisionPoint(question, options, maxOptions) {
  const limit = maxOptions || DEFAULT_MAX_OPTIONS;
  const capped = options.slice(0, limit);
  return {
    question,
    options: capped,
    formatted: `${question}\n\n${formatOptions(capped, limit)}`,
  };
}

module.exports = { formatOptions, parseChoice, createDecisionPoint, DEFAULT_MAX_OPTIONS };
