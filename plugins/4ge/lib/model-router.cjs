'use strict';

const MODELS = ['sonnet', 'opus'];
const MIN_DATA_POINTS = 5;
const SUCCESS_THRESHOLD = 0.9;

function trackAgentResult(agent, model, success) {
  return { agent, model, success, timestamp: new Date().toISOString() };
}

function computeSuccessRate(history, agent, model) {
  const matches = history.filter(h => h.agent === agent && h.model === model);
  if (matches.length === 0) return 0;
  return matches.filter(h => h.success).length / matches.length;
}

function recommendModel(history, agent) {
  for (const model of MODELS) {
    const matches = history.filter(h => h.agent === agent && h.model === model);
    if (matches.length < MIN_DATA_POINTS) continue;

    const rate = matches.filter(h => h.success).length / matches.length;
    if (rate >= SUCCESS_THRESHOLD) {
      return {
        model,
        rate: Math.round(rate * 100) / 100,
        data_points: matches.length,
        reason: `${model} has ${Math.round(rate * 100)}% success rate for agent "${agent}" (${matches.length} samples)`,
      };
    }
  }

  return {
    model: 'opus',
    rate: null,
    data_points: history.filter(h => h.agent === agent).length,
    reason: `Default to opus — insufficient data for agent "${agent}"`,
  };
}

module.exports = { trackAgentResult, computeSuccessRate, recommendModel, MODELS };
