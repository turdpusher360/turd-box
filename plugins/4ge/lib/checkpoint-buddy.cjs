'use strict';

const fs = require('fs');
const path = require('path');

const WINS_FILE = '_runs/session-wins.jsonl';

/**
 * Extracts win metrics from git diff --stat summary line.
 */
function extractWins(diffStat) {
  if (!diffStat) return { files_changed: 0, insertions: 0, deletions: 0 };

  const filesMatch = diffStat.match(/(\d+) files? changed/);
  const insertMatch = diffStat.match(/(\d+) insertions?\(\+\)/);
  const deleteMatch = diffStat.match(/(\d+) deletions?\(-\)/);

  return {
    files_changed: filesMatch ? parseInt(filesMatch[1], 10) : 0,
    insertions: insertMatch ? parseInt(insertMatch[1], 10) : 0,
    deletions: deleteMatch ? parseInt(deleteMatch[1], 10) : 0,
  };
}

/**
 * Formats a single session's wins as a summary string.
 */
function formatSessionSummary(entry) {
  const agents = (entry.agents_used || []).join(', ') || 'none';
  return [
    `Session ${entry.session_id || 'unknown'}:`,
    `  ${entry.files_changed} files changed, ${entry.insertions} insertions(+), ${entry.deletions} deletions(-)`,
    `  Agents: ${agents}`,
  ].join('\n');
}

/**
 * Formats all-time report from session history.
 */
function formatAllTimeReport(sessions) {
  if (!sessions || sessions.length === 0) return 'No sessions recorded yet.';

  const totals = sessions.reduce((acc, s) => ({
    files: acc.files + (s.files_changed || 0),
    ins: acc.ins + (s.insertions || 0),
    del: acc.del + (s.deletions || 0),
  }), { files: 0, ins: 0, del: 0 });

  return [
    `All-time stats (${sessions.length} sessions):`,
    `  ${totals.files} files changed`,
    `  ${totals.ins} insertions(+)`,
    `  ${totals.del} deletions(-)`,
    `  Avg per session: ${Math.round(totals.files / sessions.length)} files, ${Math.round(totals.ins / sessions.length)} insertions`,
  ].join('\n');
}

/**
 * Persists a session win entry to JSONL.
 */
function saveWin(projectRoot, entry) {
  try {
    const filePath = path.join(projectRoot, WINS_FILE);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(filePath, JSON.stringify({ ...entry, timestamp: new Date().toISOString() }) + '\n');
  } catch { /* best effort */ }
}

module.exports = { extractWins, formatSessionSummary, formatAllTimeReport, saveWin, WINS_FILE };
