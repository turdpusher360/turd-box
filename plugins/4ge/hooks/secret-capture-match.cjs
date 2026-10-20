'use strict';

/**
 * secret-capture-match.cjs - is this prompt a /secret capture?
 *
 * Every UserPromptSubmit hook receives the raw prompt in parallel, and a block
 * by secret-redact.cjs gates none of them. So each hook that reads the prompt
 * calls isSecretCapturePrompt() right after reading stdin and exits silently
 * on true, before any network, process or file I/O.
 *
 * Contract (pinned by lib/__tests__/secret-capture-match.test.js): true on
 * every prompt secret-redact blocks. It may be broader than the hook, never
 * narrower. No requires, so it loads anywhere.
 */

const MARKER = '##SECRET_CAPTURE##';

// "/secret" or "/superdupersecret", optionally plugin-prefixed ("/4ge:secret"),
// at the start of the prompt or of any line, followed by whitespace or the end.
// [^\S\n]* (whitespace minus newline), never \s*: \s* rescans every following
// newline from each newline and goes quadratic on long newline runs.
const COMMAND_RE = /(?:^|\n)[^\S\n]*\/(?:[\w-]+:)?(?:secret|superdupersecret)(?![\w-])/i;

// Coarse test for a whole raw or re-serialized payload: any field, any shape.
// JSON leaves "/", letters, ":", "-" and "#" unescaped, so on JSON text it is
// at least as broad as isSecretCapturePrompt on any string inside. It also
// hits paths such as /secrets/x, so a hook may only use it to SKIP work, never
// to decide a prompt is a capture. secret-redact.cjs keeps an inline copy (it
// loads nothing before its pre-test); T11 pins the two as identical.
const RAW_CAPTURE_RE = /\/(?:[\w-]+:)?(?:secret|superdupersecret)|##SECRET_CAPTURE##/i;

function isSecretCapturePrompt(prompt) {
  if (typeof prompt !== 'string' || prompt === '') return false;
  return prompt.includes(MARKER) || COMMAND_RE.test(prompt);
}

function mayCarrySecretCapture(text) {
  return typeof text === 'string' && RAW_CAPTURE_RE.test(text);
}

module.exports = { isSecretCapturePrompt, mayCarrySecretCapture, RAW_CAPTURE_RE };
