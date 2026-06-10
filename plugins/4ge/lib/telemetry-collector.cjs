'use strict';

const fs = require('fs');
const path = require('path');

const TELEMETRY_FILE = '_runs/telemetry-sessions.jsonl';

/**
 * Creates a new session telemetry entry.
 *
 * @param {string} sessionId
 * @param {string} cwd
 * @returns {object}
 */
function createSessionEntry(sessionId, cwd) {
  return {
    session_id: sessionId,
    started_at: new Date().toISOString(),
    ended_at: null,
    cwd,
    tools_used: {},
    agents_spawned: [],
    total_tool_calls: 0,
    duration_seconds: 0,
    agent_count: 0,
  };
}

/**
 * Finalizes a session entry with computed fields and persists to JSONL.
 *
 * @param {object} entry - Session entry created by createSessionEntry
 * @returns {object} The finalized entry
 */
function finalizeSession(entry) {
  entry.ended_at = new Date().toISOString();
  entry.total_tool_calls = Object.values(entry.tools_used).reduce((a, b) => a + b, 0);
  entry.agent_count = entry.agents_spawned.length;
  entry.duration_seconds = Math.round(
    (new Date(entry.ended_at).getTime() - new Date(entry.started_at).getTime()) / 1000
  );

  try {
    const telPath = path.join(entry.cwd || process.cwd(), TELEMETRY_FILE);
    const dir = path.dirname(telPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(telPath, JSON.stringify(entry) + '\n');
  } catch {
    // best effort — do not throw from telemetry path
  }

  return entry;
}

/**
 * Reads all session entries from the telemetry JSONL file.
 *
 * @param {string} projectRoot
 * @returns {Array<object>}
 */
function readSessions(projectRoot) {
  const telPath = path.join(projectRoot, TELEMETRY_FILE);
  if (!fs.existsSync(telPath)) return [];

  try {
    const raw = fs.readFileSync(telPath, 'utf8').trim();
    if (!raw) return [];
    return raw
      .split('\n')
      .filter(Boolean)
      .map(line => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Computes usage trends from session history. Requires at least 10 sessions.
 *
 * @param {Array<object>} sessions
 * @returns {object|null} Trend summary, or null when fewer than 10 sessions
 */
function computeTrends(sessions) {
  if (sessions.length < 10) return null;

  const totalCalls = sessions.reduce((a, s) => a + (s.total_tool_calls || 0), 0);
  const totalDuration = sessions.reduce((a, s) => a + (s.duration_seconds || 0), 0);
  const totalAgents = sessions.reduce((a, s) => a + (s.agent_count || 0), 0);

  return {
    total_sessions: sessions.length,
    avg_tool_calls: Math.round(totalCalls / sessions.length),
    avg_duration_seconds: Math.round(totalDuration / sessions.length),
    avg_agents_per_session: Math.round((totalAgents / sessions.length) * 10) / 10,
    most_used_tools: computeToolRanking(sessions),
  };
}

/**
 * Ranks tools by total usage across sessions, returning the top 5.
 *
 * @param {Array<object>} sessions
 * @returns {Array<{tool: string, count: number}>}
 */
function computeToolRanking(sessions) {
  const toolCounts = {};
  for (const s of sessions) {
    for (const [tool, count] of Object.entries(s.tools_used || {})) {
      toolCounts[tool] = (toolCounts[tool] || 0) + count;
    }
  }
  return Object.entries(toolCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([tool, count]) => ({ tool, count }));
}

const OS_ACCOUNTING_FILE = '_runs/os/resource-ledger.jsonl';

function readJsonl(filePath) {
  if (!filePath || !filePath.endsWith('.jsonl')) return [];
  if (!fs.existsSync(filePath)) return [];
  try {
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (!raw) return [];
    return raw
      .split('\n')
      .filter(Boolean)
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function aggregateByField(entries, groupField, valueField) {
  const result = {};
  for (const entry of entries) {
    const key = String(entry[groupField] || 'unknown');
    result[key] = (result[key] || 0) + (entry[valueField] || 0);
  }
  return result;
}

function filterByDateRange(entries, startDate, endDate) {
  return entries.filter(e => {
    const d = (e.started_at || e.ts || '').slice(0, 10);
    return d >= startDate && d <= endDate;
  });
}

function topN(entries, field, n) {
  return [...entries].sort((a, b) => (b[field] || 0) - (a[field] || 0)).slice(0, n);
}

function mergeMultipleJsonl(filePaths) {
  const all = [];
  for (const fp of filePaths) {
    all.push(...readJsonl(fp));
  }
  return all;
}

function readToolUsageJsonl(projectRoot) {
  return readJsonl(path.join(projectRoot, OS_ACCOUNTING_FILE));
}

module.exports = {
  createSessionEntry, finalizeSession, computeTrends, readSessions, TELEMETRY_FILE,
  readJsonl, aggregateByField, filterByDateRange, topN, mergeMultipleJsonl, readToolUsageJsonl,
};
