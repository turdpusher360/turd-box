'use strict';

const MAX_PER_CATEGORY = 20;

/**
 * Score a single category.
 * @param {string} categoryName
 * @param {Object} findings - { [thresholdId]: count }
 * @param {Array} thresholds - from threshold-defaults.json, merged with project overrides
 * @param {Object} categoryConfig - { weight, enabled, ... }
 * @returns {{ raw: number, deductions: Array<{ id: string, count: number, deduction: number }>, weight: number }}
 */
function scoreCategory(categoryName, findings, thresholds, categoryConfig) {
  if (!categoryConfig || categoryConfig.enabled === false) {
    return { raw: 0, deductions: [], weight: 0, skipped: true };
  }

  let score = MAX_PER_CATEGORY;
  const deductions = [];

  for (const threshold of thresholds) {
    const count = findings[threshold.id] || 0;
    if (count === 0) continue;

    let deduction;
    if (threshold.per) {
      deduction = Math.floor(count / threshold.per) * threshold.points;
    } else {
      deduction = count * threshold.points;
    }
    // Clamp to max deduction for this threshold (max is negative)
    if (threshold.max !== undefined) {
      deduction = Math.max(deduction, threshold.max);
    }
    score += deduction; // deduction is negative
    deductions.push({ id: threshold.id, count, deduction });
  }

  score = Math.max(0, Math.min(MAX_PER_CATEGORY, score));

  return {
    raw: score,
    deductions,
    weight: categoryConfig.weight || 1.0,
  };
}

/**
 * Compute weighted overall score from category results.
 * @param {Object} categoryResults - { [name]: { raw, weight, skipped? } }
 * @returns {{ weighted: number, total: number, maxTotal: number, grade: string }}
 */
function computeOverall(categoryResults) {
  let weightedSum = 0;
  let maxWeightedSum = 0;
  let total = 0;
  let maxTotal = 0;

  for (const [name, result] of Object.entries(categoryResults)) {
    if (result.skipped) continue;
    weightedSum += result.raw * result.weight;
    maxWeightedSum += MAX_PER_CATEGORY * result.weight;
    total += result.raw;
    maxTotal += MAX_PER_CATEGORY;
  }

  const weighted = maxWeightedSum > 0
    ? Math.round(weightedSum / maxWeightedSum * 100)
    : 0;

  return {
    weighted,
    total,
    maxTotal,
    grade: assignGrade(weighted),
  };
}

/**
 * Assign letter grade from weighted score.
 * @param {number} weightedScore - 0-100
 * @returns {string}
 */
function assignGrade(weightedScore) {
  if (typeof weightedScore !== 'number' || Number.isNaN(weightedScore)) return 'F';
  if (weightedScore >= 90) return 'A';
  if (weightedScore >= 75) return 'B';
  if (weightedScore >= 55) return 'C';
  if (weightedScore >= 35) return 'D';
  return 'F';
}

/**
 * Classify category as PASS/WARN/FAIL.
 * @param {number} rawScore - 0-20
 * @returns {string}
 */
function classifyCategory(rawScore) {
  if (typeof rawScore !== 'number' || Number.isNaN(rawScore)) return 'FAIL';
  const pct = (rawScore / MAX_PER_CATEGORY) * 100;
  if (pct >= 80) return 'PASS';
  if (pct >= 50) return 'WARN';
  return 'FAIL';
}

/**
 * Tag confidence level.
 * @param {number} confidence - 0-1
 * @param {number} threshold - default 0.80
 * @returns {string}
 */
function tagConfidence(confidence, threshold = 0.80) {
  if (typeof confidence !== 'number' || Number.isNaN(confidence)) return 'detected';
  if (confidence >= threshold) return 'recommended';
  if (confidence >= threshold * 0.6) return 'suggested';
  return 'detected';
}

/**
 * Compute score delta between before and after results.
 * @param {Object} before - { [categoryName]: CategoryResult }
 * @param {Object} after - { [categoryName]: CategoryResult }
 * @returns {{ categories: Object, overallBefore: number, overallAfter: number, delta: number, gradeBefore: string, gradeAfter: string }}
 */
function computeDelta(before, after) {
  const overallBefore = computeOverall(before);
  const overallAfter = computeOverall(after);
  const categories = {};

  const allNames = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const name of allNames) {
    const b = before[name]?.raw ?? 0;
    const a = after[name]?.raw ?? 0;
    if (b !== a) {
      categories[name] = { before: b, after: a, delta: a - b };
    }
  }

  return {
    categories,
    overallBefore: overallBefore.weighted,
    overallAfter: overallAfter.weighted,
    delta: overallAfter.weighted - overallBefore.weighted,
    gradeBefore: overallBefore.grade,
    gradeAfter: overallAfter.grade,
  };
}

/**
 * Whether category requires deep dive research.
 * @param {string} classification - PASS/WARN/FAIL
 * @param {Array} findings - deduction entries
 * @returns {boolean}
 */
function needsDeepDive(classification, findings) {
  if (classification === 'FAIL') return true;
  // Critical-Finding Override
  if (Array.isArray(findings)) {
    for (const f of findings) {
      if (f.severity === 'critical') return true;
    }
  }
  return false;
}

module.exports = {
  scoreCategory,
  computeOverall,
  assignGrade,
  classifyCategory,
  tagConfidence,
  computeDelta,
  needsDeepDive,
  MAX_PER_CATEGORY,
};
