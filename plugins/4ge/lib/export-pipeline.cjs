'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// PptxGenJS — loaded lazily so the module is usable without the dep installed.
let _PptxGenJS = null;
function getPptxGenJS() {
  if (_PptxGenJS !== null) return _PptxGenJS;
  try {
    _PptxGenJS = require('pptxgenjs');
  } catch {
    _PptxGenJS = false; // falsy sentinel: not available
  }
  return _PptxGenJS;
}

// Transcript root: ~/.claude/projects/<slug>/<session-id>/
const { buildProjectSlug } = require(path.resolve(__dirname, '../bin/hud-transcript-source.cjs'));
const DEFAULT_SESSIONS_ROOT = path.join(
  os.homedir(),
  '.claude',
  'projects',
  buildProjectSlug(process.cwd())
);

// Decision-signal keywords (case-insensitive)
const DECISION_KEYWORDS = ['decided', 'chose', 'decision', 'choosing', 'selected', 'opted'];

/**
 * Reads a Claude Code transcript JSONL (subagent or top-level session) and
 * extracts session metadata.
 *
 * Transcript schema (per line):
 *   { type, timestamp, message: { role, content: [{ type, name, input, text }] }, ... }
 *
 * @param {string} transcriptPath - Absolute path to a .jsonl transcript file
 * @returns {{
 *   sessionId: string,
 *   messageCount: number,
 *   decisionCount: number,
 *   fileChangeCount: number,
 *   artifacts: string[],
 *   firstTimestamp: number|null,
 *   lastTimestamp: number|null,
 *   durationMs: number|null,
 * }}
 */
function parseSessionTranscript(transcriptPath) {
  const raw = fs.readFileSync(transcriptPath, 'utf8');
  const lines = raw.split('\n').filter(Boolean);

  let sessionId = '';
  let messageCount = 0;
  let decisionCount = 0;
  let fileChangeCount = 0;
  const artifactSet = new Set();
  let firstTimestamp = null;
  let lastTimestamp = null;

  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    // Track session ID (first occurrence wins)
    if (!sessionId && entry.sessionId) {
      sessionId = entry.sessionId;
    }

    // Track timestamps
    const ts = typeof entry.timestamp === 'number' ? entry.timestamp : null;
    if (ts !== null) {
      if (firstTimestamp === null || ts < firstTimestamp) firstTimestamp = ts;
      if (lastTimestamp === null || ts > lastTimestamp) lastTimestamp = ts;
    }

    // Count messages
    const msg = entry.message;
    if (!msg || typeof msg !== 'object') continue;

    if (msg.role === 'user' || msg.role === 'assistant') {
      messageCount++;
    }

    // Inspect content blocks
    const content = Array.isArray(msg.content) ? msg.content : [];
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;

      // Tool-use blocks from assistant
      if (block.type === 'tool_use') {
        const toolName = block.name || '';
        const input = block.input || {};

        if (toolName === 'Write' || toolName === 'Edit') {
          fileChangeCount++;
          const filePath = input.file_path || input.path || '';
          if (filePath) artifactSet.add(filePath);
        }
      }

      // Text blocks — scan for decision signals
      if (block.type === 'text' && typeof block.text === 'string') {
        const lower = block.text.toLowerCase();
        if (DECISION_KEYWORDS.some(kw => lower.includes(kw))) {
          decisionCount++;
        }
      }
    }
  }

  return {
    sessionId,
    messageCount,
    decisionCount,
    fileChangeCount,
    artifacts: Array.from(artifactSet),
    firstTimestamp,
    lastTimestamp,
    durationMs: firstTimestamp !== null && lastTimestamp !== null
      ? lastTimestamp - firstTimestamp
      : null,
  };
}

/**
 * Formats a duration in milliseconds as a human-readable string.
 *
 * @param {number|null} ms
 * @returns {string}
 */
function formatDuration(ms) {
  if (ms === null || ms < 0) return 'unknown';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/**
 * Transforms parsed transcript data into a structured export payload.
 *
 * @param {ReturnType<typeof parseSessionTranscript>} parsed
 * @returns {{
 *   title: string,
 *   date: string,
 *   duration: string,
 *   decisions: string[],
 *   artifacts: string[],
 *   messageCount: number,
 *   fileCount: number,
 *   summary: string,
 * }}
 */
function buildExportData(parsed) {
  const date = parsed.firstTimestamp
    ? new Date(parsed.firstTimestamp).toISOString().slice(0, 10)
    : new Date().toISOString().slice(0, 10);

  const sessionLabel = parsed.sessionId
    ? parsed.sessionId.slice(0, 8)
    : 'unknown';

  return {
    title: `Session ${sessionLabel} — ${date}`,
    date,
    duration: formatDuration(parsed.durationMs),
    decisions: Array.from({ length: parsed.decisionCount }, (_, i) => `Decision ${i + 1}`),
    artifacts: parsed.artifacts,
    messageCount: parsed.messageCount,
    fileCount: parsed.fileChangeCount,
    summary: '[AI storytelling layer — not yet implemented]',
  };
}

/**
 * Writes a Markdown brief to the given output path.
 *
 * @param {{
 *   title: string,
 *   date: string,
 *   duration: string,
 *   decisions: string[],
 *   artifacts: string[],
 *   messageCount: number,
 *   fileCount: number,
 *   summary: string,
 * }} exportData
 * @param {string} sessionId
 * @param {string} outputPath - Absolute path to write the .md file
 * @returns {void}
 */
function generateBrief(exportData, sessionId, outputPath) {
  const lines = [
    `# Session Brief`,
    ``,
    `**Session ID:** ${sessionId || 'unknown'}`,
    `**Date:** ${exportData.date}`,
    `**Duration:** ${exportData.duration}`,
    ``,
    `---`,
    ``,
    `## Executive Summary`,
    ``,
    exportData.summary,
    ``,
    `---`,
    ``,
    `## Decisions`,
    ``,
  ];

  if (exportData.decisions.length === 0) {
    lines.push('_No decisions detected._');
  } else {
    for (const d of exportData.decisions) {
      lines.push(`- ${d}`);
    }
  }

  lines.push('', '---', '', '## Artifacts', '');

  if (exportData.artifacts.length === 0) {
    lines.push('_No file changes detected._');
  } else {
    for (const a of exportData.artifacts) {
      lines.push(`- \`${a}\``);
    }
  }

  lines.push(
    '',
    '---',
    '',
    '## Metrics',
    '',
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Messages | ${exportData.messageCount} |`,
    `| Files changed | ${exportData.fileCount} |`,
    `| Duration | ${exportData.duration} |`,
    `| Decisions | ${exportData.decisions.length} |`,
    ''
  );

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, lines.join('\n'), 'utf8');
}

/**
 * Generates a PPTX slide deck from export data using PptxGenJS.
 *
 * Slides:
 *   1. Title — session title, date, duration
 *   2. Executive Summary — summary text block
 *   3. Key Decisions — bulleted list
 *   4. Artifacts — bulleted list of file changes
 *   5. Metrics — 2x2 table: message count, file count, duration, decision count
 *
 * Dark theme styling to match terminal aesthetic.
 *
 * @param {object} exportData
 * @param {string} exportData.title
 * @param {string} exportData.date
 * @param {string} exportData.duration
 * @param {string} exportData.summary
 * @param {string[]} exportData.decisions
 * @param {string[]} exportData.artifacts
 * @param {number} exportData.messageCount
 * @param {number} exportData.fileCount
 * @param {string} outputPath
 * @returns {{ path: string, slides: number } | { stub: true, reason: string }}
 */
function generateSlides(exportData, outputPath) {
  const PptxGenJS = getPptxGenJS();
  if (!PptxGenJS) {
    return { stub: true, reason: 'PptxGenJS not installed' };
  }

  // Dark theme palette matching catppuccin-mocha terminal aesthetic
  const BG      = '1e1e2e';
  const TEXT     = 'cdd6f4';
  const ACCENT   = 'cba6f7';
  const MUTED    = '6c7086';
  const OK_GREEN = 'a6e3a1';

  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.title = exportData.title || 'Session Brief';

  // Slide master defaults
  const slideDefaults = {
    background: { color: BG },
  };

  // --- Slide 1: Title ---
  const s1 = pptx.addSlide();
  Object.assign(s1, slideDefaults);
  s1.background = { color: BG };
  s1.addText(exportData.title || 'Session Brief', {
    x: 0.5, y: 1.5, w: '90%', h: 1.2,
    fontSize: 36, bold: true, color: ACCENT, align: 'center',
  });
  s1.addText(`${exportData.date || ''}  \u00B7  ${exportData.duration || ''}`, {
    x: 0.5, y: 3.0, w: '90%', h: 0.6,
    fontSize: 16, color: MUTED, align: 'center',
  });

  // --- Slide 2: Executive Summary ---
  const s2 = pptx.addSlide();
  s2.background = { color: BG };
  s2.addText('Executive Summary', {
    x: 0.5, y: 0.4, w: '90%', h: 0.6,
    fontSize: 24, bold: true, color: ACCENT,
  });
  s2.addText(exportData.summary || 'No summary available.', {
    x: 0.5, y: 1.2, w: '90%', h: 3.5,
    fontSize: 14, color: TEXT, valign: 'top', wrap: true,
  });

  // --- Slide 3: Key Decisions ---
  const s3 = pptx.addSlide();
  s3.background = { color: BG };
  s3.addText('Key Decisions', {
    x: 0.5, y: 0.4, w: '90%', h: 0.6,
    fontSize: 24, bold: true, color: ACCENT,
  });
  const decisions = Array.isArray(exportData.decisions) && exportData.decisions.length > 0
    ? exportData.decisions
    : ['No decisions detected.'];
  const decisionRows = decisions.map(d => ({ text: d, options: { bullet: true, color: TEXT, fontSize: 14 } }));
  s3.addText(decisionRows, { x: 0.5, y: 1.2, w: '90%', h: 3.5, valign: 'top' });

  // --- Slide 4: Artifacts ---
  const s4 = pptx.addSlide();
  s4.background = { color: BG };
  s4.addText('Artifacts', {
    x: 0.5, y: 0.4, w: '90%', h: 0.6,
    fontSize: 24, bold: true, color: ACCENT,
  });
  const artifacts = Array.isArray(exportData.artifacts) && exportData.artifacts.length > 0
    ? exportData.artifacts
    : ['No file changes detected.'];
  const artifactRows = artifacts.map(a => ({ text: a, options: { bullet: true, color: OK_GREEN, fontSize: 13 } }));
  s4.addText(artifactRows, { x: 0.5, y: 1.2, w: '90%', h: 3.5, valign: 'top' });

  // --- Slide 5: Metrics ---
  const s5 = pptx.addSlide();
  s5.background = { color: BG };
  s5.addText('Metrics', {
    x: 0.5, y: 0.4, w: '90%', h: 0.6,
    fontSize: 24, bold: true, color: ACCENT,
  });
  const metricsTable = [
    [
      { text: 'Messages', options: { bold: true, color: MUTED, fill: { color: '313244' } } },
      { text: String(exportData.messageCount || 0), options: { color: TEXT, fill: { color: '1e1e2e' } } },
      { text: 'Files changed', options: { bold: true, color: MUTED, fill: { color: '313244' } } },
      { text: String(exportData.fileCount || 0), options: { color: TEXT, fill: { color: '1e1e2e' } } },
    ],
    [
      { text: 'Duration', options: { bold: true, color: MUTED, fill: { color: '313244' } } },
      { text: exportData.duration || 'unknown', options: { color: TEXT, fill: { color: '1e1e2e' } } },
      { text: 'Decisions', options: { bold: true, color: MUTED, fill: { color: '313244' } } },
      { text: String(Array.isArray(exportData.decisions) ? exportData.decisions.length : 0), options: { color: TEXT, fill: { color: '1e1e2e' } } },
    ],
  ];
  s5.addTable(metricsTable, {
    x: 0.5, y: 1.2, w: 9, colW: [2, 2.5, 2, 2.5],
    fontSize: 14, border: { type: 'solid', color: MUTED, pt: 1 },
  });

  // Write file
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  return pptx.writeFile({ fileName: outputPath }).then(() => {
    return { path: outputPath, slides: 5 };
  });
}

/**
 * Locates the transcript JSONL for a given session ID.
 * Searches the default sessions root for a directory matching the session ID,
 * then returns the first .jsonl found inside it (subagents/ or root).
 *
 * @param {string} sessionId
 * @param {string} [sessionsRoot]
 * @returns {string|null} Absolute path or null if not found
 */
function findTranscript(sessionId, sessionsRoot) {
  const root = sessionsRoot || DEFAULT_SESSIONS_ROOT;

  if (!fs.existsSync(root)) return null;

  // Session dir may be the UUID itself
  const sessionDir = path.join(root, sessionId);
  if (fs.existsSync(sessionDir)) {
    // Prefer subagents/ directory
    const subagentsDir = path.join(sessionDir, 'subagents');
    if (fs.existsSync(subagentsDir)) {
      const jsonlFiles = fs.readdirSync(subagentsDir).filter(f => f.endsWith('.jsonl'));
      if (jsonlFiles.length > 0) {
        return path.join(subagentsDir, jsonlFiles[0]);
      }
    }
    // Fall back to any .jsonl in the session dir itself
    const topLevel = fs.readdirSync(sessionDir).filter(f => f.endsWith('.jsonl'));
    if (topLevel.length > 0) {
      return path.join(sessionDir, topLevel[0]);
    }
  }

  // Prefix search for partial session IDs
  const entries = fs.readdirSync(root);
  for (const entry of entries) {
    if (entry.startsWith(sessionId)) {
      const candidate = path.join(root, entry, 'subagents');
      if (fs.existsSync(candidate)) {
        const jsonlFiles = fs.readdirSync(candidate).filter(f => f.endsWith('.jsonl'));
        if (jsonlFiles.length > 0) return path.join(candidate, jsonlFiles[0]);
      }
    }
  }

  return null;
}

/**
 * Full export orchestration:
 *  1. Locate transcript for sessionId
 *  2. Parse it
 *  3. Build export data
 *  4. Write Markdown brief to _runs/{sessionId}-brief.md  (format: 'brief' or 'all')
 *  5. Generate PPTX deck to _runs/{sessionId}-brief.pptx  (format: 'deck' or 'all')
 *  6. Optionally copy outputs to H:/Dropbox/BizOps/ if options.bizops is true
 *
 * @param {string} sessionId
 * @param {{
 *   runsDir?: string,
 *   sessionsRoot?: string,
 *   bizops?: boolean,
 *   format?: 'brief' | 'deck' | 'all',
 * }} [options]
 * @returns {Promise<{ brief?: string, deck?: string, data: object }>}
 */
async function runExport(sessionId, options) {
  const opts = options || {};
  const runsDir = opts.runsDir || path.join(process.cwd(), '_runs');
  const format = opts.format || 'brief';

  const transcriptPath = findTranscript(sessionId, opts.sessionsRoot);
  if (!transcriptPath) {
    throw new Error(`No transcript found for session: ${sessionId}`);
  }

  const parsed = parseSessionTranscript(transcriptPath);
  const exportData = buildExportData(parsed);

  const result = { data: exportData };

  // Brief (Markdown)
  if (format === 'brief' || format === 'all') {
    const briefPath = path.join(runsDir, `${sessionId}-brief.md`);
    generateBrief(exportData, sessionId, briefPath);
    result.brief = briefPath;

    if (opts.bizops) {
      const bizopsDir = 'H:/Dropbox/BizOps';
      try {
        fs.mkdirSync(bizopsDir, { recursive: true });
        fs.copyFileSync(briefPath, path.join(bizopsDir, `${sessionId}-brief.md`));
      } catch (err) {
        // Non-fatal: BizOps copy failure does not abort the export
        process.stderr.write(`[export-pipeline] BizOps copy failed: ${err.message}\n`);
      }
    }
  }

  // Deck (PPTX)
  if (format === 'deck' || format === 'all') {
    const deckPath = path.join(runsDir, `${sessionId}-brief.pptx`);
    const slideResult = await generateSlides(exportData, deckPath);
    if (slideResult && !slideResult.stub) {
      result.deck = deckPath;
    }
  }

  return result;
}

module.exports = {
  parseSessionTranscript,
  buildExportData,
  generateBrief,
  generateSlides,
  findTranscript,
  runExport,
  formatDuration,
  DEFAULT_SESSIONS_ROOT,
  DECISION_KEYWORDS,
};
