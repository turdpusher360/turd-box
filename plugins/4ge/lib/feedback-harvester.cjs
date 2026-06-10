'use strict';

function detectRevertAfterWarning(events, windowMs) {
  const warnings = events.filter(e => e.type === 'warning');
  const reverts = events.filter(e => e.type === 'revert');
  const signals = [];

  for (const warning of warnings) {
    const warningTime = new Date(warning.timestamp).getTime();
    for (const revert of reverts) {
      const revertTime = new Date(revert.timestamp).getTime();
      if (
        revert.file === warning.file &&
        revertTime > warningTime &&
        revertTime - warningTime <= windowMs
      ) {
        signals.push({
          hook: warning.hook,
          file: warning.file,
          warning_time: warning.timestamp,
          revert_time: revert.timestamp,
          positive: true,
        });
      }
    }
  }

  return signals;
}

function computeHookEffectiveness(signals) {
  const result = {};
  for (const s of signals) {
    if (!result[s.hook]) result[s.hook] = { positive: 0, total: 0 };
    result[s.hook].total++;
    if (s.positive) result[s.hook].positive++;
  }
  return result;
}

function formatEffectivenessReport(effectiveness) {
  const entries = Object.entries(effectiveness);
  if (entries.length === 0) return 'No effectiveness data available.';

  const lines = ['| Hook | Positive | Total | Effectiveness |', '|------|----------|-------|-------------|'];
  for (const [hook, data] of entries) {
    const rate = data.total > 0 ? Math.round((data.positive / data.total) * 100) : 0;
    lines.push(`| ${hook} | ${data.positive} | ${data.total} | ${rate}% |`);
  }
  return lines.join('\n');
}

module.exports = { detectRevertAfterWarning, computeHookEffectiveness, formatEffectivenessReport };
