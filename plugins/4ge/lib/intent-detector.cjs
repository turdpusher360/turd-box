'use strict';
/**
 * intent-detector.cjs — Classify current workflow intent from recent tool history.
 *
 * Input: recent tool events (last N tool calls with tool name, input snapshot,
 * and timestamp) + current HUD state.
 *
 * Output: { intent, confidence, reason }
 *   intent: 'debugging' | 'shipping' | 'exploring' | 'testing'
 *         | 'refactoring' | 'reviewing' | 'idle' | 'unknown'
 *   confidence: 0..1 (how sure we are, based on signal strength)
 *   reason: short human-readable why (for debug output)
 *
 * Pure function: no I/O. The caller owns the tool ring buffer.
 */

// Time thresholds
const IDLE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

// Tool category sets
const GIT_COMMANDS = ['git commit', 'git push', 'git status', 'git diff', 'git log', 'git add'];
const TEST_COMMANDS = ['vitest', 'jest', 'npm test', 'npm run test', 'npx vitest', 'pytest'];
const BUILD_COMMANDS = ['npm run build', 'tsc', 'npx tsc', 'npm run lint', 'eslint'];

// ── Helpers ──

function countByTool(events) {
  const counts = {};
  for (const e of events) {
    counts[e.tool] = (counts[e.tool] || 0) + 1;
  }
  return counts;
}

function matchesAny(str, patterns) {
  if (!str) return false;
  return patterns.some(p => str.includes(p));
}

function extractBashCommands(events) {
  return events
    .filter(e => e.tool === 'Bash' && e.command)
    .map(e => e.command);
}

function uniqueFilesTouched(events, tools) {
  const files = new Set();
  for (const e of events) {
    if (tools && !tools.includes(e.tool)) continue;
    if (e.filePath) files.add(e.filePath);
  }
  return files.size;
}

function fileTouches(events, toolFilter) {
  // Returns map: filePath → count of touches (Read/Edit/Write combined)
  const touches = {};
  for (const e of events) {
    if (toolFilter && !toolFilter.includes(e.tool)) continue;
    if (!e.filePath) continue;
    touches[e.filePath] = (touches[e.filePath] || 0) + 1;
  }
  return touches;
}

// ── Intent Classifiers ──
// Each returns a score 0..1 (confidence this is the active intent).
// The highest-scoring classifier wins.

function scoreIdle(events, state, now) {
  if (events.length === 0) return { score: 0.3, reason: 'no recent tools' };
  const lastTs = events[events.length - 1].ts || 0;
  const gap = now - lastTs;
  if (gap >= IDLE_THRESHOLD_MS) {
    return { score: 0.9, reason: `${Math.floor(gap / 60000)}m since last tool` };
  }
  return { score: 0, reason: '' };
}

function scoreShipping(events, state) {
  const bash = extractBashCommands(events);
  const gitHits = bash.filter(c => matchesAny(c, GIT_COMMANDS)).length;
  if (gitHits === 0) return { score: 0, reason: '' };

  const hasCommit = bash.some(c => c.includes('git commit'));
  const hasPush = bash.some(c => c.includes('git push'));

  if (hasCommit && hasPush) return { score: 0.95, reason: 'commit + push' };
  if (hasCommit) return { score: 0.85, reason: 'commit in recent activity' };
  if (gitHits >= 3) return { score: 0.7, reason: `${gitHits} git commands` };
  return { score: 0.4, reason: 'some git activity' };
}

function scoreTesting(events, state) {
  const bash = extractBashCommands(events);
  const testCmdHits = bash.filter(c => matchesAny(c, TEST_COMMANDS)).length;
  const testFileEdits = events.filter(e =>
    (e.tool === 'Edit' || e.tool === 'Write') &&
    e.filePath && /\.test\.(js|cjs|ts)$/.test(e.filePath)
  ).length;

  const signal = testCmdHits + testFileEdits;
  if (signal === 0) return { score: 0, reason: '' };
  if (signal >= 3) return { score: 0.85, reason: `${testCmdHits} test runs, ${testFileEdits} test edits` };
  if (signal >= 2) return { score: 0.7, reason: 'test activity' };
  return { score: 0.4, reason: 'some test activity' };
}

function scoreDebugging(events, state) {
  // Signals: repeated Read/Grep on same files, Edit after test-fail, Bash with error output,
  // high tool count in short time on narrow file set
  const recentEdits = events.filter(e => e.tool === 'Edit' || e.tool === 'Write');

  // Repeated reads on the same file = investigation
  const readTouches = fileTouches(events, ['Read']);
  const repeatedReads = Object.values(readTouches).filter(n => n >= 2).length;
  const maxRereads = Object.values(readTouches).reduce((m, n) => Math.max(m, n), 0);

  // Edit immediately preceded by Read of the same file = targeted fix
  let targetedFixes = 0;
  for (let i = 1; i < events.length; i++) {
    const prev = events[i - 1], cur = events[i];
    if ((cur.tool === 'Edit' || cur.tool === 'Write') &&
        prev.tool === 'Read' &&
        prev.filePath && cur.filePath && prev.filePath === cur.filePath) {
      targetedFixes++;
    }
  }

  // Look for error output keywords in recent bash
  const bashErrorHits = extractBashCommands(events).filter(c =>
    /error|failed|fail|exception/i.test(c)
  ).length;

  if (repeatedReads >= 2 && targetedFixes >= 1) {
    return { score: 0.85, reason: `${repeatedReads} reread files, ${targetedFixes} targeted fixes` };
  }
  if (maxRereads >= 3 && targetedFixes >= 1) {
    return { score: 0.85, reason: `${maxRereads}× reread same file + fix` };
  }
  if (targetedFixes >= 2) {
    return { score: 0.75, reason: `${targetedFixes} read→edit pairs` };
  }
  if (repeatedReads >= 3) {
    return { score: 0.6, reason: `${repeatedReads} files reread` };
  }
  if (bashErrorHits >= 2 && recentEdits.length > 0) {
    return { score: 0.55, reason: 'error output + edits' };
  }
  return { score: 0, reason: '' };
}

function scoreExploring(events, state) {
  // Signals: many unique files via Read/Glob/Grep, few or no edits
  const uniqueReads = uniqueFilesTouched(events, ['Read']);
  const globs = events.filter(e => e.tool === 'Glob').length;
  const greps = events.filter(e => e.tool === 'Grep').length;
  const edits = events.filter(e => e.tool === 'Edit' || e.tool === 'Write').length;

  const searchActivity = globs + greps;
  if (uniqueReads < 3 && searchActivity < 2) return { score: 0, reason: '' };

  // Exploration: broad search, narrow (or zero) editing
  if (edits === 0 && (uniqueReads >= 4 || searchActivity >= 3)) {
    return { score: 0.8, reason: `${uniqueReads} files read, ${searchActivity} searches, 0 edits` };
  }
  if (edits < uniqueReads / 3 && uniqueReads >= 5) {
    return { score: 0.65, reason: `${uniqueReads} files read vs ${edits} edits` };
  }
  return { score: 0, reason: '' };
}

function scoreRefactoring(events, state) {
  // Signals: replace_all edits, many edits in same dir, no new files (only Edits not Writes)
  const replaceAllEdits = events.filter(e =>
    e.tool === 'Edit' && e.replaceAll === true
  ).length;
  const edits = events.filter(e => e.tool === 'Edit').length;
  const writes = events.filter(e => e.tool === 'Write').length;

  // Count directories touched
  const dirs = new Set();
  for (const e of events) {
    if ((e.tool === 'Edit' || e.tool === 'Write') && e.filePath) {
      const lastSlash = Math.max(e.filePath.lastIndexOf('/'), e.filePath.lastIndexOf('\\'));
      if (lastSlash > 0) dirs.add(e.filePath.slice(0, lastSlash));
    }
  }

  if (replaceAllEdits >= 2) {
    return { score: 0.8, reason: `${replaceAllEdits} replace-all edits` };
  }
  if (edits >= 5 && writes === 0 && dirs.size <= 2) {
    return { score: 0.7, reason: `${edits} edits across ${dirs.size} dirs` };
  }
  return { score: 0, reason: '' };
}

function scoreReviewing(events, state) {
  // Signals: Read-heavy, Grep to find things, no edits
  const reads = events.filter(e => e.tool === 'Read').length;
  const greps = events.filter(e => e.tool === 'Grep').length;
  const edits = events.filter(e => e.tool === 'Edit' || e.tool === 'Write').length;
  const bashReviewHits = extractBashCommands(events).filter(c =>
    /git (log|diff|show)|gh pr/.test(c)
  ).length;

  if (edits > 0) return { score: 0, reason: '' };
  if (reads >= 3 && (greps > 0 || bashReviewHits > 0)) {
    return { score: 0.75, reason: `${reads} reads + ${greps + bashReviewHits} inspects, 0 edits` };
  }
  if (bashReviewHits >= 2) {
    return { score: 0.65, reason: `${bashReviewHits} review-oriented git/gh calls` };
  }
  return { score: 0, reason: '' };
}

// ── Public API ──

/**
 * @param {object} opts
 * @param {Array<{tool:string, command?:string, filePath?:string, ts:number, replaceAll?:boolean}>} opts.recentTools
 * @param {object} opts.state - canonical HUD state (optional, for future signals)
 * @param {number} [opts.now] - current time in ms (testable)
 * @returns {{ intent:string, confidence:number, reason:string }}
 */
function detectIntent(opts) {
  const events = (opts && opts.recentTools) || [];
  const state = (opts && opts.state) || {};
  const now = (opts && opts.now) || Date.now();

  // Check idle first — it trumps everything
  const idleResult = scoreIdle(events, state, now);
  if (idleResult.score >= 0.8) {
    return { intent: 'idle', confidence: idleResult.score, reason: idleResult.reason };
  }

  const candidates = [
    { intent: 'shipping',    ...scoreShipping(events, state) },
    { intent: 'testing',     ...scoreTesting(events, state) },
    { intent: 'debugging',   ...scoreDebugging(events, state) },
    { intent: 'refactoring', ...scoreRefactoring(events, state) },
    { intent: 'reviewing',   ...scoreReviewing(events, state) },
    { intent: 'exploring',   ...scoreExploring(events, state) },
  ];

  // Highest score wins, with minimum confidence threshold
  candidates.sort((a, b) => b.score - a.score);
  const top = candidates[0];
  if (top.score >= 0.5) {
    return { intent: top.intent, confidence: top.score, reason: top.reason };
  }

  // Low-confidence fallback: if idle was ambiguous but nothing else scored, say so
  if (idleResult.score > 0) {
    return { intent: 'idle', confidence: idleResult.score, reason: idleResult.reason };
  }

  return { intent: 'unknown', confidence: 0.2, reason: 'no clear pattern' };
}

module.exports = {
  detectIntent,
  // Exported for tests / direct use
  scoreIdle,
  scoreShipping,
  scoreTesting,
  scoreDebugging,
  scoreExploring,
  scoreRefactoring,
  scoreReviewing,
  IDLE_THRESHOLD_MS,
};
