'use strict';

/**
 * hud-transcript-source.cjs
 *
 * Live HUD data source that reads the current session's JSONL transcript
 * file instead of polling _runs/os/*.json state files. Returns a shape
 * suitable for merging into the canonical state via hud-data-loader.
 *
 * The transcript is the source-of-truth for tool activity. Every tool call,
 * result, text message, and attachment is appended to
 * ~/.claude/projects/<slug>/<sessionId>.jsonl as the session progresses.
 * Reading it gives instantaneous access to real activity without cooldowns.
 *
 * @s246 substrate unlock / method #18 (transcript path reactivity)
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// ---------------------------------------------------------------------------
// Transcript discovery
// ---------------------------------------------------------------------------

/**
 * Build the Claude Code project slug for a cwd.
 * Claude Code replaces non-alphanumeric characters in the absolute path
 * with '-' to form the project directory name under ~/.claude/projects/.
 * Example: "O:\\Example_Workspace" -> "O--Example-Workspace"
 */
function buildProjectSlug(cwd) {
  // Normalize to forward slashes, then replace every run of non-alphanumeric
  // with a single dash. Actually Claude Code replaces each char individually,
  // producing `O--Example-Workspace` for `O:\Example_Workspace` (colon + backslash both
  // become dashes). Match that behavior exactly.
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

function findProjectDir(cwd) {
  const home = os.homedir();
  const projectsRoot = path.join(home, '.claude', 'projects');
  if (!fs.existsSync(projectsRoot)) return null;

  let candidates;
  try {
    candidates = fs.readdirSync(projectsRoot)
      .map((name) => ({ name, full: path.join(projectsRoot, name) }))
      .filter(({ full }) => {
        try { return fs.statSync(full).isDirectory(); } catch { return false; }
      });
  } catch {
    return null;
  }

  // First pass: exact slug match
  const slug = buildProjectSlug(cwd);
  const exact = candidates.find(({ name }) => name === slug);
  if (exact) return exact.full;

  // Second pass: basename-contains match with dashes, excluding variants
  const basename = path.basename(cwd).replace(/[^A-Za-z0-9]/g, '-').toLowerCase();
  const primary = candidates.filter(({ name }) => {
    const lower = name.toLowerCase();
    return lower.includes(basename) && !lower.includes('worktree') && !lower.includes('aisle');
  });
  if (primary.length > 0) return primary[0].full;

  // Fallback: any match
  const fallback = candidates.find(({ name }) => name.toLowerCase().includes(basename));
  return fallback ? fallback.full : null;
}

/**
 * Find the active transcript file for a given session id (or newest if none).
 * @param {string} cwd
 * @param {string|null} sessionId
 * @returns {string|null}
 */
function findTranscriptPath(cwd, sessionId) {
  const projectDir = findProjectDir(cwd);
  if (!projectDir) return null;

  let files;
  try {
    files = fs.readdirSync(projectDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => {
        const full = path.join(projectDir, f);
        let mtime = 0;
        try { mtime = fs.statSync(full).mtimeMs; } catch { /* ignore */ }
        return { f, full, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return null;
  }

  if (sessionId) {
    const match = files.find(({ f }) => f.startsWith(sessionId));
    if (match) return match.full;
  }

  return files[0] ? files[0].full : null;
}

// ---------------------------------------------------------------------------
// Transcript parsing
// ---------------------------------------------------------------------------

/**
 * Extract a short, HUD-friendly summary of a tool input.
 * @param {object} input
 * @param {string} toolName
 * @returns {string}
 */
function shortInput(input, toolName) {
  if (!input || typeof input !== 'object') return '';
  switch (toolName) {
    case 'Bash':
      return String(input.command || '').slice(0, 60);
    case 'Read':
    case 'Edit':
    case 'Write':
      return String(input.file_path || '');
    case 'Glob':
      return String(input.pattern || '');
    case 'Grep':
      return String(input.pattern || '');
    case 'Agent':
    case 'Task':
      return String(input.description || input.prompt || '').slice(0, 60);
    default:
      try {
        return JSON.stringify(input).slice(0, 60);
      } catch {
        return '';
      }
  }
}

/**
 * Parse a transcript file and return structured activity data.
 * Safe against malformed lines — skips them silently.
 */
function parseTranscript(filepath) {
  let raw;
  try {
    raw = fs.readFileSync(filepath, 'utf8');
  } catch {
    return null;
  }

  const lines = raw.trim().split('\n');
  const events = [];
  const typeCounts = {};
  const toolCounts = {};
  let toolUses = 0;
  let toolResults = 0;
  let toolErrors = 0;
  let textMessages = 0;
  let firstTimestamp = null;
  let lastTimestamp = null;

  for (const line of lines) {
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }

    const type = obj.type || 'unknown';
    typeCounts[type] = (typeCounts[type] || 0) + 1;

    if (obj.timestamp) {
      if (!firstTimestamp) firstTimestamp = obj.timestamp;
      lastTimestamp = obj.timestamp;
    }

    const content = obj.message && obj.message.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (block.type === 'tool_use') {
        toolUses++;
        toolCounts[block.name] = (toolCounts[block.name] || 0) + 1;
        events.push({
          ts: obj.timestamp || null,
          kind: 'tool_use',
          name: block.name,
          summary: shortInput(block.input, block.name),
          id: block.id,
        });
      } else if (block.type === 'tool_result') {
        toolResults++;
        if (block.is_error) toolErrors++;
        const preview = typeof block.content === 'string'
          ? block.content
          : Array.isArray(block.content)
            ? block.content.map((c) => c && c.text ? c.text : '').join(' ')
            : '';
        events.push({
          ts: obj.timestamp || null,
          kind: 'tool_result',
          id: block.tool_use_id,
          error: !!block.is_error,
          summary: preview.replace(/\s+/g, ' ').slice(0, 60),
        });
      } else if (block.type === 'text') {
        textMessages++;
      }
    }
  }

  let fileSize = 0;
  try { fileSize = fs.statSync(filepath).size; } catch { /* ignore */ }

  return {
    filepath,
    fileSize,
    totalLines: lines.length,
    typeCounts,
    toolCounts,
    toolUses,
    toolResults,
    toolErrors,
    textMessages,
    firstTimestamp,
    lastTimestamp,
    events,
  };
}

// ---------------------------------------------------------------------------
// HUD state adapter
// ---------------------------------------------------------------------------

/**
 * Load transcript activity for HUD consumption. Returns null if no
 * transcript is available (fresh project, no sessions yet).
 *
 * @param {object} opts
 * @param {string} opts.cwd
 * @param {string|null} [opts.sessionId]
 * @param {number} [opts.tailCount=12]
 * @returns {null | object}
 */
function loadTranscriptActivity(opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const sessionId = opts.sessionId || null;
  const tailCount = typeof opts.tailCount === 'number' ? opts.tailCount : 12;

  const filepath = findTranscriptPath(cwd, sessionId);
  if (!filepath) return null;

  const parsed = parseTranscript(filepath);
  if (!parsed) return null;

  // Build tool-name frequency list sorted by count desc
  const toolFrequency = Object.entries(parsed.toolCounts)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  // Recent events (both tool_use and tool_result), most recent last
  const recent = parsed.events.slice(-tailCount);

  return {
    source: 'transcript-tail',
    transcriptPath: parsed.filepath,
    fileSize: parsed.fileSize,
    totalLines: parsed.totalLines,
    typeCounts: parsed.typeCounts,
    toolCounts: parsed.toolCounts,
    toolFrequency,
    toolCallsTotal: parsed.toolUses,
    toolResultsTotal: parsed.toolResults,
    toolErrorsTotal: parsed.toolErrors,
    textMessagesTotal: parsed.textMessages,
    sessionStartedAt: parsed.firstTimestamp,
    lastActivityAt: parsed.lastTimestamp,
    recentEvents: recent,
  };
}

// ---------------------------------------------------------------------------
// CLI entry — for standalone debugging / smoke-test
// ---------------------------------------------------------------------------

if (require.main === module) {
  const args = process.argv.slice(2);
  let tailCount = 15;
  let sessionId = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--tail' && i + 1 < args.length) tailCount = parseInt(args[++i], 10) || 15;
    else if (args[i] === '--session' && i + 1 < args.length) sessionId = args[++i];
  }

  const activity = loadTranscriptActivity({ cwd: process.cwd(), sessionId, tailCount });
  if (!activity) {
    process.stderr.write('No transcript found\n');
    process.exit(1);
  }

  console.log('transcript:', activity.transcriptPath);
  console.log(`lines: ${activity.totalLines}  size: ${activity.fileSize}B`);
  console.log(`tool calls: ${activity.toolCallsTotal}  results: ${activity.toolResultsTotal}  errors: ${activity.toolErrorsTotal}`);
  console.log(`text msgs: ${activity.textMessagesTotal}`);
  console.log(`session: ${activity.sessionStartedAt} -> ${activity.lastActivityAt}`);
  console.log();
  console.log('tool frequency:');
  for (const { name, count } of activity.toolFrequency.slice(0, 10)) {
    console.log(`  ${name.padEnd(18)} ${String(count).padStart(4)}`);
  }
  console.log();
  console.log(`recent ${tailCount} events:`);
  for (const e of activity.recentEvents) {
    const icon = e.kind === 'tool_use' ? '→' : e.error ? '✗' : '✓';
    const label = e.kind === 'tool_use' ? e.name : 'result';
    console.log(`  ${icon} ${String(label).padEnd(16)} ${e.summary}`);
  }
}

// UNWIRED — integration into hud-data-loader.cjs pending. See S246 forge plan.
module.exports = {
  buildProjectSlug,
  findProjectDir,
  findTranscriptPath,
  parseTranscript,
  loadTranscriptActivity,
  shortInput,
};
