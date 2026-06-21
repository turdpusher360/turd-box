'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  summarizeRigContext,
  isRigContextStale,
} = require('./rig-context.cjs');

const DEFAULT_MAX_ISSUES = 4;
const DEFAULT_STALE_AFTER_MS = 60 * 60 * 1000;

function toDate(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function ageMinutes(context, now) {
  if (!context || !context.generated_at) return null;
  const generatedAt = Date.parse(context.generated_at);
  if (!Number.isFinite(generatedAt)) return null;
  return Math.max(0, Math.round((toDate(now).getTime() - generatedAt) / 60000));
}

function staleAfterMs(context, fallback = DEFAULT_STALE_AFTER_MS) {
  const ttlSeconds = Number(context && context.ttl_seconds);
  return Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? ttlSeconds * 1000 : fallback;
}

function clip(value, max = 160) {
  if (typeof value !== 'string') return '';
  const text = value.replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return text.slice(0, max - 3).trimEnd() + '...';
}

function buildRigContextAdvisory(context, options = {}) {
  if (!context || typeof context !== 'object') return '';
  const now = toDate(options.now);
  const summary = summarizeRigContext(context);
  const stale = isRigContextStale(context, now, staleAfterMs(context, options.maxAgeMs));
  if (summary.status === 'ok' && !stale) return '';

  const status = stale ? `${summary.status} [stale]` : summary.status;
  const lines = [`[rig-context] ${status}: ${summary.headline}`];

  if (stale) {
    const age = ageMinutes(context, now);
    lines.push(`- snapshot (stale): generated ${Number.isFinite(age) ? `${age}m ago` : 'at an unknown time'}`);
  }

  const issues = Array.isArray(summary.issues) ? summary.issues : [];
  for (const issue of issues.slice(0, options.maxIssues || DEFAULT_MAX_ISSUES)) {
    lines.push(`- ${clip(issue.name, 40)} (${issue.status || 'unknown'}): ${clip(issue.summary || 'No summary', 180)}`);
  }
  if (issues.length > (options.maxIssues || DEFAULT_MAX_ISSUES)) {
    lines.push(`- +${issues.length - (options.maxIssues || DEFAULT_MAX_ISSUES)} more rig issue(s) in _runs/os/rig-context.json`);
  }

  lines.push('Advisory only: verify live source of truth before relying on generated context. Do not block, stage, commit, or mutate runtime state because of this warning.');
  return lines.join('\n');
}

function readJsonSafe(filePath, fsImpl = fs) {
  try {
    if (!fsImpl.existsSync(filePath)) return null;
    return JSON.parse(fsImpl.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function readRigContextAdvisory(options = {}) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const stateDir = path.resolve(options.stateDir || path.join(cwd, '_runs', 'os'));
  const context = readJsonSafe(path.join(stateDir, 'rig-context.json'), options.fsImpl || fs);
  return buildRigContextAdvisory(context, options);
}

module.exports = {
  buildRigContextAdvisory,
  readRigContextAdvisory,
  ageMinutes,
  staleAfterMs,
};
