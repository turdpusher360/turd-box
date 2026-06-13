/**
 * diff-parser.js — Map PR diff hunks to commentable line numbers.
 *
 * GitHub's PR-review inline comments anchor to lines that are actually part of
 * the diff. The `line` field of a review comment is the line number in the file
 * on a given `side` (RIGHT = the head/new version, LEFT = the base/old version),
 * and GitHub rejects the whole `comments` array if any one entry points at a
 * line outside the diff. DFE findings carry absolute file line numbers, so we
 * need the set of new-file line numbers that the PR actually touched in order to
 * (a) anchor comments with `line`+`side` and (b) drop out-of-range findings into
 * the summary instead of poisoning the entire inline batch.
 *
 * This module is pure (no I/O, no network) so it is unit-testable in isolation.
 */

// A unified-diff hunk header looks like: `@@ -oldStart,oldCount +newStart,newCount @@ heading`
// The counts are optional (a single-line hunk is `@@ -1 +1 @@`). We only need the
// new-side start line to walk the RIGHT side of the hunk.
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Parse a single file's unified-diff patch into the set of RIGHT-side
 * (new-file) line numbers that can carry an inline review comment.
 *
 * Added (`+`) and context (` `) lines advance the new-file counter and are
 * commentable on the RIGHT side. Removed (`-`) lines belong to the LEFT side
 * and do not advance the new-file counter. The `\ No newline at end of file`
 * marker is ignored.
 *
 * @param {string} patch — the `patch` string from the GitHub PR files API.
 * @returns {Set<number>} commentable new-file line numbers.
 */
export function parsePatch(patch) {
  const commentable = new Set();
  if (typeof patch !== 'string' || patch.length === 0) return commentable;

  let newLine = null;

  for (const line of patch.split('\n')) {
    const header = line.match(HUNK_HEADER);
    if (header) {
      newLine = parseInt(header[1], 10);
      continue;
    }

    // Lines before the first hunk header (file metadata) are skipped.
    if (newLine === null) continue;

    const marker = line[0];
    if (marker === '+') {
      commentable.add(newLine);
      newLine += 1;
    } else if (marker === '-') {
      // Removed line — LEFT side only, does not advance the new-file counter.
    } else if (marker === '\\') {
      // "\ No newline at end of file" — metadata, no line consumed.
    } else {
      // Context line (leading space) or a blank context line. Both advance the
      // new-file counter and are commentable on the RIGHT side.
      commentable.add(newLine);
      newLine += 1;
    }
  }

  return commentable;
}

/**
 * Build a lookup of commentable new-file line numbers per file path from a
 * GitHub PR "list files" response.
 *
 * Files without a `patch` (binary files, or files too large for GitHub to
 * inline a patch) yield an empty set — findings against them fall through to
 * the summary rather than being posted inline.
 *
 * @param {Array<{filename: string, patch?: string}>} files
 * @returns {Map<string, Set<number>>} path -> commentable line numbers.
 */
export function buildLineIndex(files) {
  const index = new Map();
  if (!Array.isArray(files)) return index;

  for (const file of files) {
    if (!file || typeof file.filename !== 'string') continue;
    index.set(file.filename, parsePatch(file.patch));
  }

  return index;
}

/**
 * Is a given (file, line) anchorable as an inline comment in this PR's diff?
 *
 * @param {Map<string, Set<number>>} index — from buildLineIndex.
 * @param {string} file — finding file path.
 * @param {number} line — finding line number.
 * @returns {boolean}
 */
export function isAnchorable(index, file, line) {
  if (!file || !Number.isInteger(line) || line <= 0) return false;
  const lines = index.get(file);
  return Boolean(lines && lines.has(line));
}
