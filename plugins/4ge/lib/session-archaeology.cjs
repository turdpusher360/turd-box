'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Indexes forge-state-*.json files from the plugin data directory.
 */
function indexSessions(dataDir) {
  if (!fs.existsSync(dataDir)) return [];

  const files = fs.readdirSync(dataDir).filter(f => f.startsWith('forge-state-') && f.endsWith('.json'));
  const sessions = [];

  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dataDir, file), 'utf8'));
      sessions.push({
        id: data.session_id || file.replace('forge-state-', '').replace('.json', ''),
        date: (data.started || '').slice(0, 10),
        topic: data.topic || data.title || 'untitled',
        branch: data.branch || '',
        state: data.state || 'parked',
        files: data.files_changed || 0,
        file_path: path.join(dataDir, file),
      });
    } catch { /* skip malformed */ }
  }

  return sessions.sort((a, b) => b.date.localeCompare(a.date));
}

/**
 * Filters sessions by state value (staged/executing/parked/shipped).
 */
function filterByState(sessions, state) {
  if (!state) return sessions;
  return sessions.filter(s => s.state === state);
}

/**
 * Filters sessions by date string (YYYY-MM-DD).
 */
function searchByDate(sessions, date) {
  return sessions.filter(s => s.date === date);
}

/**
 * Filters sessions by topic substring match (case-insensitive).
 */
function searchByTopic(sessions, query) {
  const q = query.toLowerCase();
  return sessions.filter(s => (s.topic || '').toLowerCase().includes(q) || (s.branch || '').toLowerCase().includes(q));
}

/**
 * Formats a session list as human-readable text.
 */
function formatSessionList(sessions) {
  if (sessions.length === 0) return 'No sessions found.';

  const lines = ['| Date | Topic | Branch | State | Files |', '|------|-------|--------|-------|-------|'];
  for (const s of sessions) {
    lines.push(`| ${s.date} | ${s.topic} | ${s.branch} | ${s.state || 'parked'} | ${s.files} |`);
  }
  return lines.join('\n');
}

module.exports = { indexSessions, filterByState, searchByDate, searchByTopic, formatSessionList };
