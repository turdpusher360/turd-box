'use strict';

function findStaleDomains(domains, staleDays, now) {
  const threshold = new Date(now);
  threshold.setDate(threshold.getDate() - staleDays);
  const thresholdStr = threshold.toISOString().slice(0, 10);

  return domains.filter(d => {
    if (!d.last_measured) return true;
    return d.last_measured < thresholdStr;
  });
}

function buildCronSchedule(staleDomains) {
  return staleDomains
    .map(d => ({
      domain: d.name,
      last_measured: d.last_measured || 'never',
      current_score: d.score || 0,
      priority: 100 - (d.score || 0),
    }))
    .sort((a, b) => b.priority - a.priority);
}

function formatStaleReport(staleDomains) {
  if (staleDomains.length === 0) return 'All domains are up to date.';

  const lines = [
    '| Domain | Last Measured | Score | Days Stale |',
    '|--------|--------------|-------|-----------|',
  ];
  const now = new Date();
  for (const d of staleDomains) {
    const lastDate = d.last_measured ? new Date(d.last_measured) : null;
    const daysStale = lastDate ? Math.round((now - lastDate) / 86400000) : 'never';
    lines.push(`| ${d.name} | ${d.last_measured || 'never'} | ${d.score || 0} | ${daysStale} |`);
  }
  return lines.join('\n');
}

module.exports = { findStaleDomains, buildCronSchedule, formatStaleReport };
