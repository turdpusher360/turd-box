'use strict';

const fs = require('fs');
const path = require('path');

const MIN_DATA_POINTS = 5;
const DEMOTION_THRESHOLD = 0.2;

function appendRuleCompliance(entry, options = {}) {
  const filePath = options.filePath || path.join(process.cwd(), '_runs', 'rule-compliance.jsonl');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf8');
  return filePath;
}

function trackRuleCompliance(rule, followed, metadata = {}) {
  const entry = {
    rule,
    followed: Boolean(followed),
    timestamp: metadata.timestamp || new Date().toISOString(),
  };

  for (const [key, value] of Object.entries(metadata)) {
    if (['persist', 'filePath', 'timestamp'].includes(key) || value === undefined) continue;
    entry[key] = value;
  }

  if (metadata.persist) {
    appendRuleCompliance(entry, { filePath: metadata.filePath });
  }

  return entry;
}

function computeFollowThroughRate(history, rule) {
  const ruleEntries = history.filter(h => h.rule === rule && h.applicable !== false);
  if (ruleEntries.length === 0) return 0;
  const followed = ruleEntries.filter(h => h.followed).length;
  return followed / ruleEntries.length;
}

function suggestDemotions(history) {
  const ruleGroups = {};
  for (const entry of history) {
    if (entry.applicable === false) continue;
    if (!ruleGroups[entry.rule]) ruleGroups[entry.rule] = [];
    ruleGroups[entry.rule].push(entry);
  }

  const demotions = [];
  for (const [rule, entries] of Object.entries(ruleGroups)) {
    if (entries.length < MIN_DATA_POINTS) continue;
    const rate = entries.filter(e => e.followed).length / entries.length;
    if (rate < DEMOTION_THRESHOLD) {
      demotions.push({
        rule,
        rate: Math.round(rate * 100) / 100,
        total: entries.length,
        reason: `Rule "${rule}" followed ${Math.round(rate * 100)}% of the time (${entries.length} data points). Consider archiving.`,
      });
    }
  }

  return demotions.sort((a, b) => a.rate - b.rate);
}

module.exports = { appendRuleCompliance, trackRuleCompliance, computeFollowThroughRate, suggestDemotions };
