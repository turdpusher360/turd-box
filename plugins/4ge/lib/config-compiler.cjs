'use strict';

function analyzeUsage(usageMap, category) {
  const entries = Object.entries(usageMap);
  const unused = entries.filter(([, count]) => count === 0).map(([name]) => name);
  const sorted = [...entries].sort((a, b) => b[1] - a[1]);
  const heavy_hitters = sorted
    .slice(0, 5)
    .filter(([, count]) => count > 0)
    .map(([name]) => name);

  return { category, unused, heavy_hitters, total_items: entries.length };
}

function generateSuggestions(hookTriggers, protectedHooks) {
  const suggestions = [];
  const protectedSet = new Set(protectedHooks);

  for (const [hook, count] of Object.entries(hookTriggers)) {
    if (protectedSet.has(hook)) continue;

    if (count === 0) {
      suggestions.push({
        action: 'remove',
        target: hook,
        reason: `"${hook}" has never triggered. Consider removing to reduce hook overhead.`,
        confidence: 0.8,
      });
    }
  }

  return suggestions.sort((a, b) => b.confidence - a.confidence);
}

module.exports = { analyzeUsage, generateSuggestions };
