'use strict';

/**
 * artifact-shape.cjs: label agent-written text before a hook puts it in another
 * agent's context.
 *
 * BL-347 R1. Design note: _runs/2026-09-30/s705/lane-4/BL-347/design-note.md
 * (sha256 a896aa8a...), section 3, Option F.
 *
 * Pure functions, no I/O:
 *   flag(text)                  -> { labels }  instruction-shaped or tag-shaped content
 *   clean(text, max)            -> one safe line: hidden and control characters removed,
 *                                  harness-style tags defanged, newlines flattened, capped
 *   cleanLabel(text, max)       -> clean() plus the label delimiters [ ] | swapped out
 *   fenceLine(text, meta, max)  -> { line, labels }  provenance label + quoted clean text
 *
 * flag() is TELEMETRY, not a guard. The real cases in the BL-347 evidence carried
 * no pattern at all, and the rig's own threat reports trip these patterns. A caller
 * labels a hit; it never denies or drops on one (ADR-SEC-001).
 *
 * Every quantifier is bounded ({0,N}), so a scan is linear in the input, and the
 * input is capped at MAX_SCAN_CHARS. A hook that runs past its timeout fails open
 * (the tool call proceeds), so a slow scan would be a bypass.
 */

const MAX_SCAN_CHARS = 64 * 1024;

// Whitespace between words: bounded so no pattern can backtrack across a long run.
const W = '\\s{1,8}';

function rx(source) {
  return new RegExp(source, 'i');
}

// Instruction-override shapes. Sources: AISLE Scanner G INJECTION_PATTERNS
// (lib/aisle/scanners/prompt-safety.cjs:30-38) and Scanner I OVERRIDE_PATTERNS
// (lib/aisle/scanners/memory-integrity.cjs:45-58), merged, bounded and de-duplicated.
// Scanner I's /\bact\s+as\b/ is left out on purpose: ordinary prose ("act as a proxy")
// would bury every real hit.
const PATTERNS = [
  { label: 'ignore-previous', re: rx(`\\b(?:ignore|disregard|forget)${W}(?:all${W})?(?:(?:the|your)${W})?(?:previous|prior|above|earlier)\\b`) },
  { label: 'forget-everything', re: rx(`\\bforget${W}(?:everything|your${W}instructions)\\b`) },
  { label: 'you-are-now', re: rx(`\\byou${W}are${W}now\\b`) },
  { label: 'new-instructions', re: rx(`\\bnew${W}instructions?\\s{0,4}:`) },
  { label: 'system-delimiter', re: rx(`(?:^|\\n)[ \\t]{0,20}system[ \\t]{0,20}:|\\bsystem\\s{0,4}:\\s{0,4}you\\b`) },
  { label: 'inst-delimiter', re: rx('\\[\\/?INST\\]') },
  { label: 'chat-template-token', re: rx('<\\|(?:system|user|assistant|im_start|im_end)\\|>') },
  { label: 'bypass-safety', re: rx(`\\b(?:bypass|disable|override|ignore)${W}(?:safety|security|aisle|scanning|verification|guardrails?)\\b|\\b(?:skip${W}verification|turn${W}off${W}scanning)\\b`) },
  // Harness-style tags, lower case included (working-context.cjs sanitize() misses these).
  { label: 'harness-tag', re: rx('<\\/?(?:system-reminder|system|instructions?|tool_use|tool_result|teammate-message|cross-session-message|function_calls|invoke|parameter)\\b[^>]{0,200}>') },
  // Authority claims addressed to the reader (BL-347 design note section 2b).
  { label: 'authority-claim', re: rx(`\\bthe${W}(?:operator|lead|user)${W}(?:has${W})?(?:said|says|approved|wants|decided|authori[sz]ed|ruled)\\b`) },
  { label: 'reader-directive', re: rx(`\\b(?:you|the${W}next${W}(?:agent|session|helper|reader))${W}(?:must|are${W}required${W}to)\\b`) },
  { label: 'conceal', re: rx(`\\bdo${W}not${W}(?:tell|inform|mention${W}this${W}to)${W}(?:the${W})?(?:user|operator|lead)\\b`) },
];

// Hidden characters: the Arabic letter mark, zero-width and bidi controls, word joiners
// and deprecated format characters (U+2060-206F), variation selectors (U+FE00-FE0F), BOM,
// and every \uDB40 code unit. \uDB40 is the high half of each assigned plane-14 character:
// the Unicode Tags block (U+E0000-E007F) and the variation selectors supplement
// (U+E0100-E01EF). The class matches single code units, so removing them cannot join two
// remaining halves into a new hidden character (a pair pattern can: "\uDB40" + zero-width
// + "\uDC41" reassembles a Tags character once the zero-width is gone). Removing \uDB40
// leaves the low half of each plane-14 character behind, so LONE_SURROGATE_RE runs next.
// The variation selectors lead the class: after another character, eslint's
// no-misleading-character-class reads them as combined with it.
const HIDDEN_RE = /[\uFE00-\uFE0F\u061C\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF\uDB40]/g;
// Unpaired surrogates: a high half not followed by a low half, or a low half not preceded
// by a high half. Removing one cannot pair two others, so one pass leaves well-formed
// UTF-16. clean() runs it before the tag defang, because a removal after the defang
// could rejoin an opener ("<" + lone half + "system").
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
// flag() leaves out U+FE00-FE0F: U+FE0F follows ordinary emoji. A payload smuggled in
// variation selectors also needs the supplement range, which the \uDB40 unit catches.
const HIDDEN_TEST_RE = /[\u061C\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF\uDB40]/;
// C0 and C1 controls except tab, newline and carriage return (whitespace, collapsed later).
// C1 includes NEL (U+0085), which \s does not match.
const CONTROL_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g;
// Any tag-like "<name" or "</name": the "<" becomes a lookalike so the text cannot
// open or close a harness-style block. Bounded name length keeps it linear.
const TAG_OPEN_RE = /<(\/?)([A-Za-z!|][\w:|-]{0,64})/g;

/**
 * Labels for instruction-shaped or hidden-channel content. Telemetry only.
 * @param {unknown} text
 * @returns {{ labels: string[] }}
 */
function flag(text) {
  const s = String(text ?? '').slice(0, MAX_SCAN_CHARS);
  const labels = [];
  for (const { label, re } of PATTERNS) {
    if (re.test(s)) labels.push(label);
  }
  if (HIDDEN_TEST_RE.test(s)) labels.push('hidden-unicode');
  return { labels };
}

/**
 * One safe line of well-formed UTF-16: hidden characters, unpaired surrogates and
 * control characters removed, tag openers defanged, guillemets swapped out (they
 * quote the text in fenceLine), newlines and runs of whitespace collapsed, capped at
 * max characters without splitting a surrogate pair.
 * @param {unknown} text
 * @param {number} [max]
 * @returns {string}
 */
function clean(text, max = 300) {
  return String(text ?? '')
    .slice(0, MAX_SCAN_CHARS)
    .replace(HIDDEN_RE, '')
    .replace(LONE_SURROGATE_RE, '')
    .replace(CONTROL_RE, ' ')
    .replace(TAG_OPEN_RE, '\u2039$1$2')
    .replace(/[\u00AB\u00BB]/g, '"')
    .replace(/\s{1,64}/g, ' ')
    .trim()
    .slice(0, max)
    // The cap can cut a pair in half; drop the stranded high half.
    .replace(/[\uD800-\uDBFF]$/, '');
}

/**
 * clean() for a label field: the label delimiters [ ] | become the lookalikes ( ) /,
 * so a field value cannot close the label or forge another field.
 * @param {unknown} text
 * @param {number} [max]
 * @returns {string}
 */
function cleanLabel(text, max = 300) {
  return clean(text, max).replace(/\[/g, '(').replace(/\]/g, ')').replace(/\|/g, '/');
}

/**
 * Provenance label plus the quoted clean text, on one line. The label comes first,
 * every label field goes through cleanLabel(), and the text cannot contain a newline
 * or a guillemet, so a stored note cannot forge another note's label or its own.
 * @param {unknown} text
 * @param {{ kind?: string, id?: string, created?: string, scope?: string, source?: string, extra?: string }} [meta]
 * @param {number} [max]
 * @returns {{ line: string, labels: string[] }}
 */
function fenceLine(text, meta = {}, max = 300) {
  const { labels } = flag(text);
  const parts = [cleanLabel(meta.kind || 'data', 20)];
  if (meta.id) parts.push(`id ${cleanLabel(meta.id, 12)}`);
  if (meta.created) parts.push(`created ${cleanLabel(meta.created, 10)}`);
  if (meta.scope) parts.push(`scope ${cleanLabel(meta.scope, 20)}`);
  parts.push(`source ${meta.source ? cleanLabel(meta.source, 40) : 'none'}`);
  if (meta.extra) parts.push(cleanLabel(meta.extra, 60));
  parts.push(`flags ${labels.length ? labels.join(',') : 'none'}`);
  return { line: `[${parts.join(' | ')}] \u00AB${clean(text, max)}\u00BB`, labels };
}

module.exports = {
  MAX_SCAN_CHARS,
  PATTERNS,
  flag,
  clean,
  cleanLabel,
  fenceLine,
};
