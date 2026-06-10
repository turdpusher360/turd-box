'use strict';
/**
 * Context Phoenix — standalone session context compaction helper.
 * Extracted from .claude/hooks/checks/dcd-extract.cjs.
 *
 * Wraps the extractDCD + writeDCD pipeline and returns a result object
 * suitable for CLI and programmatic use.
 *
 * @module context-phoenix
 */

const path = require('path');

/**
 * Compact the current session context into a DCD-style summary and write it
 * to the standard output locations (_runs/ and .claude/rules/).
 *
 * @param {object} [opts]
 * @param {string} [opts.projectRoot] - Absolute path to project root (default: process.cwd())
 * @param {string} [opts.sessionId]   - Session ID for file-tracking lookup (optional)
 * @param {string} [opts.trigger]     - Trigger label written into the DCD ('manual' default)
 * @returns {{ outputPath: string, wordCount: number, metadata: object }}
 */
function compact(opts) {
  const options = opts || {};
  const projectRoot = options.projectRoot || process.cwd();
  const sessionId   = options.sessionId   || undefined;
  const trigger     = options.trigger     || 'manual';

  // Load the extraction + write helpers from the hook module.
  // Using an absolute path so this works regardless of working directory.
  const extractorPath = path.resolve(__dirname, '../../../.claude/hooks/checks/dcd-extract.cjs');
  const { extractDCD, writeDCD } = require(extractorPath);

  const result = extractDCD({ cwd: projectRoot, sessionId, trigger });
  writeDCD(projectRoot, result.content);

  const outputPath = path.join(projectRoot, '_runs', 'decision-chain-latest.md');
  const wordCount  = result.content
    .split(/\s+/)
    .filter(Boolean)
    .length;

  return { outputPath, wordCount, metadata: result.metadata };
}

module.exports = { compact };
