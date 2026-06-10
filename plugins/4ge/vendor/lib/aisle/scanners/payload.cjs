'use strict';

/**
 * payload.cjs — AISLE Scanner H
 *
 * File-based payload detection. Pure-JS YARA-like analysis:
 *   1. Magic byte validation: compare file extension vs actual file signature
 *   2. Entropy analysis: high-entropy content indicates encryption/packing
 *   3. Zip bomb detection: compression ratio > 100:1
 *   4. Path traversal in archives: ../../ patterns in archive member paths
 *
 * On-demand scanner: cadence ['on-demand'].
 * evaluate() always returns allow=true (on-demand, called by gate when needed).
 * scan(context) performs the actual analysis.
 * Synchronous throughout (P0-B compliance).
 */

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCANNER_ID = 'H';
const CANARY_DIR = path.resolve(__dirname, '../canaries/H');

const RULE_OF_TWO = { untrusted: true, sensitive: false, external: false };

// Zip bomb detection: compressed:uncompressed ratio > 100:1
const ZIP_BOMB_RATIO_THRESHOLD = 100;

// High entropy threshold (Shannon entropy > 7.2 = likely encrypted/packed)
const HIGH_ENTROPY_THRESHOLD = 7.2;

// Magic byte signatures by extension
// Format: extension => [bufferHex prefix, description]
const MAGIC_BYTES = {
  '.pdf':  { hex: '25504446', desc: 'PDF (%PDF)' },
  '.zip':  { hex: '504b0304', desc: 'ZIP (PK)' },
  '.exe':  { hex: '4d5a',     desc: 'PE (MZ)' },
  '.dll':  { hex: '4d5a',     desc: 'PE (MZ)' },
  '.png':  { hex: '89504e47', desc: 'PNG' },
  '.jpg':  { hex: 'ffd8ff',   desc: 'JPEG' },
  '.gif':  { hex: '47494638', desc: 'GIF' },
  '.elf':  { hex: '7f454c46', desc: 'ELF' },
  '.gz':   { hex: '1f8b',     desc: 'GZIP' },
  // P1-4: TAR "ustar" magic is at offset 257 per POSIX spec, not offset 0
  '.tar':  { hex: '7573746172', desc: 'TAR', offset: 257 },
  '.7z':   { hex: '377abcaf271c', desc: '7-Zip' },
  '.rar':  { hex: '526172211a07', desc: 'RAR' },
  '.ps1':  { hex: null,       desc: 'PowerShell (text)' }, // text-based, skip magic
  '.js':   { hex: null,       desc: 'JavaScript (text)' },
  '.cjs':  { hex: null,       desc: 'CommonJS (text)' },
  '.json': { hex: null,       desc: 'JSON (text)' },
};

// Extensions that should NOT have binary magic bytes (text files)
const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.js', '.cjs', '.ts', '.json', '.yaml', '.yml', '.sh', '.ps1', '.py', '.rb', '.go', '.rs', '.html', '.css', '.xml', '.csv']);

// Binary signatures that should NOT appear in text files (indicates mismatch)
const BINARY_SIGNATURES = [
  { hex: '4d5a', desc: 'PE executable (MZ)' },
  { hex: '7f454c46', desc: 'ELF binary' },
  { hex: '504b0304', desc: 'ZIP archive' },
  { hex: '25504446', desc: 'PDF document' },
  { hex: '1f8b', desc: 'GZIP compressed' },
  { hex: 'ffd8ff', desc: 'JPEG image' },
  { hex: '89504e47', desc: 'PNG image' },
];

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build a Finding object.
 */
function makeFinding(opts) {
  return {
    scannerId: SCANNER_ID,
    severity: opts.severity || 'HIGH',
    title: opts.title,
    description: opts.description,
    filePath: opts.filePath || null,
    ruleOfTwo: { ...RULE_OF_TWO },
    actions: opts.actions || [],
    tier: opts.tier || 'LOG',
    flags: { ...RULE_OF_TWO },
    scanner: SCANNER_ID,
    pattern: opts.pattern || opts.title,
  };
}

/**
 * Calculate Shannon entropy of a buffer.
 * @param {Buffer} buf
 * @returns {number}
 */
function shannonEntropy(buf) {
  if (!buf || buf.length === 0) return 0;
  const freq = new Array(256).fill(0);
  for (let i = 0; i < buf.length; i++) {
    freq[buf[i]]++;
  }
  let entropy = 0;
  const len = buf.length;
  for (let i = 0; i < 256; i++) {
    if (freq[i] === 0) continue;
    const p = freq[i] / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * Convert a hex string to a Buffer for comparison.
 * @param {string} hexStr
 * @returns {Buffer}
 */
function hexToBuffer(hexStr) {
  return Buffer.from(hexStr, 'hex');
}

/**
 * Check if a buffer starts with the given hex bytes.
 * @param {Buffer} buf
 * @param {string} hexPrefix
 * @returns {boolean}
 */
function startsWithMagic(buf, hexPrefix, offset = 0) {
  if (!hexPrefix) return false;
  const magic = hexToBuffer(hexPrefix);
  if (buf.length < offset + magic.length) return false;
  return buf.slice(offset, offset + magic.length).equals(magic);
}

/**
 * Validate magic bytes for a file: compare declared extension vs actual content.
 * @param {string} filePath
 * @param {Buffer} content
 * @returns {{ mismatch: boolean, declared: string, actual: string|null }}
 */
function checkMagicBytes(filePath, content) {
  const ext = path.extname(filePath).toLowerCase();
  const declared = ext || '(no extension)';

  // If it's a declared text extension, check it doesn't start with binary magic bytes
  if (TEXT_EXTENSIONS.has(ext)) {
    for (const sig of BINARY_SIGNATURES) {
      if (startsWithMagic(content, sig.hex)) {
        return { mismatch: true, declared, actual: sig.desc };
      }
    }
    return { mismatch: false, declared, actual: null };
  }

  // For known binary extensions, verify the magic bytes match
  const expected = MAGIC_BYTES[ext];
  if (!expected || expected.hex === null) {
    // Unknown or text extension, skip
    return { mismatch: false, declared, actual: null };
  }

  if (!startsWithMagic(content, expected.hex, expected.offset || 0)) {
    // Does not match expected; check what it actually is
    let actualDesc = 'unknown';
    for (const sig of BINARY_SIGNATURES) {
      if (startsWithMagic(content, sig.hex)) {
        actualDesc = sig.desc;
        break;
      }
    }
    return { mismatch: true, declared, actual: actualDesc };
  }

  return { mismatch: false, declared, actual: expected.desc };
}

/**
 * Simple zip bomb detection: check if "compression ratio" field in stub JSON
 * or in actual zip central directory exceeds threshold.
 * For real zip parsing (without deps), we look for the ratio in structured JSON stubs
 * or estimate from file size vs declared uncompressed sizes in the local file headers.
 *
 * For actual ZIP: parse local file headers to find compressed vs uncompressed sizes.
 * ZIP local file header signature: 0x04034b50
 * Offset 18: compressed size (4 bytes LE)
 * Offset 22: uncompressed size (4 bytes LE)
 *
 * @param {Buffer} content
 * @param {string} filePath
 * @returns {{ isZipBomb: boolean, ratio: number }}
 */
function checkZipBomb(content, filePath) {
  // Handle JSON stubs (canary fixtures)
  if (filePath.endsWith('.json') || content.slice(0, 1).toString() === '{') {
    try {
      const parsed = JSON.parse(content.toString('utf8'));
      if (typeof parsed.compressionRatio === 'number' && parsed.compressionRatio > ZIP_BOMB_RATIO_THRESHOLD) {
        return { isZipBomb: true, ratio: parsed.compressionRatio };
      }
    } catch { /* not JSON */ }
    return { isZipBomb: false, ratio: 0 };
  }

  // Real ZIP: check magic
  if (!startsWithMagic(content, '504b0304')) {
    return { isZipBomb: false, ratio: 0 };
  }

  // Parse local file headers
  let offset = 0;
  let totalCompressed = 0;
  let totalUncompressed = 0;
  let entries = 0;

  while (offset + 30 <= content.length) {
    // Local file header signature
    const sig = content.readUInt32LE(offset);
    if (sig !== 0x04034b50) break;

    const compressedSize = content.readUInt32LE(offset + 18);
    const uncompressedSize = content.readUInt32LE(offset + 22);
    const fileNameLen = content.readUInt16LE(offset + 26);
    const extraLen = content.readUInt16LE(offset + 28);

    totalCompressed += compressedSize;
    totalUncompressed += uncompressedSize;
    entries++;

    offset += 30 + fileNameLen + extraLen + compressedSize;
    if (offset > content.length) break;
  }

  if (totalCompressed === 0 || entries === 0) {
    return { isZipBomb: false, ratio: 0 };
  }

  const ratio = totalUncompressed / totalCompressed;
  return { isZipBomb: ratio > ZIP_BOMB_RATIO_THRESHOLD, ratio };
}

/**
 * Check archive content for path traversal (../../) entries.
 * For ZIP files, scans file name fields in local file headers.
 * For JSON stubs, checks entries array.
 * @param {Buffer} content
 * @param {string} filePath
 * @returns {{ found: boolean, paths: string[] }}
 */
function checkPathTraversal(content, filePath) {
  const traversalPaths = [];

  // Handle JSON stubs
  try {
    const parsed = JSON.parse(content.toString('utf8'));
    if (Array.isArray(parsed.entries)) {
      for (const entry of parsed.entries) {
        if (typeof entry === 'string' && entry.includes('../')) {
          traversalPaths.push(entry);
        }
      }
    }
    return { found: traversalPaths.length > 0, paths: traversalPaths };
  } catch { /* not JSON */ }

  // Real ZIP: scan file name fields
  if (!startsWithMagic(content, '504b0304')) {
    return { found: false, paths: [] };
  }

  let offset = 0;
  while (offset + 30 <= content.length) {
    const sig = content.readUInt32LE(offset);
    if (sig !== 0x04034b50) break;

    const compressedSize = content.readUInt32LE(offset + 18);
    const fileNameLen = content.readUInt16LE(offset + 26);
    const extraLen = content.readUInt16LE(offset + 28);
    const fileName = content.slice(offset + 30, offset + 30 + fileNameLen).toString('utf8');

    if (fileName.includes('../') || fileName.includes('..\\')) {
      traversalPaths.push(fileName);
    }

    offset += 30 + fileNameLen + extraLen + compressedSize;
    if (offset > content.length) break;
  }

  return { found: traversalPaths.length > 0, paths: traversalPaths };
}

// ---------------------------------------------------------------------------
// Scanner contract
// ---------------------------------------------------------------------------

module.exports = {
  id: SCANNER_ID,
  name: 'payload',
  version: '1.0.0',
  defaultTier: 'LOG',
  cadence: ['on-demand'],
  capabilities: { network: false, fs: true, env: [] },

  /**
   * Per-tool evaluation — on-demand scanner always allows.
   * Gate calls scan() explicitly when needed.
   *
   * @param {object} toolInput
   * @param {object} cachedState
   * @returns {{ allow: boolean, findings: [] }}
   */
  evaluate(toolInput, cachedState) {
    return { allow: true, findings: [] };
  },

  /**
   * On-demand scan of a file or context.
   * @param {object} context - { filePath?, cwd?, content? }
   * @returns {{ findings: object[], duration: number, cachedState: object }}
   */
  scan(context) {
    const findings = [];
    const startTime = Date.now();

    const targetPath = context.filePath || context.path || null;
    if (!targetPath) {
      return { findings: [], duration: 0, cachedState: {} };
    }

    let content;
    try {
      content = fs.readFileSync(targetPath);
    } catch (err) {
      return { findings: [], duration: Date.now() - startTime, cachedState: {}, error: err.message };
    }

    const ext = path.extname(targetPath).toLowerCase();

    // 1. Magic byte validation
    const magicResult = checkMagicBytes(targetPath, content);
    if (magicResult.mismatch) {
      findings.push(makeFinding({
        severity: 'HIGH',
        title: 'Magic byte mismatch (polyglot file)',
        description: `File declares extension "${magicResult.declared}" but content signature matches ${magicResult.actual || 'different format'}`,
        filePath: targetPath,
        tier: 'LOG',
        pattern: `magic-mismatch:${magicResult.declared}`,
      }));
    }

    // 2. Entropy analysis
    const entropy = shannonEntropy(content);
    if (entropy > HIGH_ENTROPY_THRESHOLD) {
      findings.push(makeFinding({
        severity: 'MEDIUM',
        title: 'High entropy content detected',
        description: `Shannon entropy ${entropy.toFixed(2)} > threshold ${HIGH_ENTROPY_THRESHOLD} — possible encrypted/packed payload`,
        filePath: targetPath,
        tier: 'LOG',
        pattern: `high-entropy:${entropy.toFixed(2)}`,
      }));
    }

    // 3. Zip bomb detection (ZIP files and JSON stubs)
    if (ext === '.zip' || ext === '.json') {
      const zipResult = checkZipBomb(content, targetPath);
      if (zipResult.isZipBomb) {
        findings.push(makeFinding({
          severity: 'HIGH',
          title: 'Zip bomb detected',
          description: `Compression ratio ${zipResult.ratio.toFixed(1)}:1 exceeds threshold ${ZIP_BOMB_RATIO_THRESHOLD}:1`,
          filePath: targetPath,
          tier: 'LOG',
          pattern: `zip-bomb:${zipResult.ratio.toFixed(0)}`,
        }));
      }
    }

    // 4. Path traversal in archives
    if (ext === '.zip' || ext === '.json') {
      const traversalResult = checkPathTraversal(content, targetPath);
      if (traversalResult.found) {
        findings.push(makeFinding({
          severity: 'HIGH',
          title: 'Path traversal in archive',
          description: `Archive contains path traversal entries: ${traversalResult.paths.slice(0, 3).join(', ')}`,
          filePath: targetPath,
          tier: 'LOG',
          pattern: 'path-traversal',
          actions: ['quarantine'],
        }));
      }
    }

    return { findings, duration: Date.now() - startTime, cachedState: {} };
  },

  /**
   * Self-test against canary fixtures.
   */
  selfTest() {
    const results = [];

    // polyglot.pdf — magic byte mismatch
    try {
      const canaryPath = path.join(CANARY_DIR, 'polyglot.pdf');
      const result = module.exports.scan({ filePath: canaryPath });
      const hasMismatch = result.findings.some(f => f.pattern && f.pattern.startsWith('magic-mismatch'));
      results.push({ canary: 'polyglot.pdf', detected: hasMismatch, findings: result.findings.length });
    } catch (err) {
      results.push({ canary: 'polyglot.pdf', detected: false, error: err.message });
    }

    // zipbomb.zip — zip bomb ratio
    try {
      const canaryPath = path.join(CANARY_DIR, 'zipbomb.zip');
      const result = module.exports.scan({ filePath: canaryPath });
      const hasBomb = result.findings.some(f => f.pattern && f.pattern.startsWith('zip-bomb'));
      results.push({ canary: 'zipbomb.zip', detected: hasBomb, findings: result.findings.length });
    } catch (err) {
      results.push({ canary: 'zipbomb.zip', detected: false, error: err.message });
    }

    // magic-mismatch.js — binary bytes in JS file
    try {
      const canaryPath = path.join(CANARY_DIR, 'magic-mismatch.js');
      const result = module.exports.scan({ filePath: canaryPath });
      const hasMismatch = result.findings.some(f => f.pattern && f.pattern.startsWith('magic-mismatch'));
      results.push({ canary: 'magic-mismatch.js', detected: hasMismatch, findings: result.findings.length });
    } catch (err) {
      results.push({ canary: 'magic-mismatch.js', detected: false, error: err.message });
    }

    return { pass: results.every(r => r.detected), details: results };
  },

  /**
   * Health check.
   */
  health() {
    return {
      status: 'healthy',
      magicSignatures: Object.keys(MAGIC_BYTES).length,
      binarySignatures: BINARY_SIGNATURES.length,
    };
  },

  // Exposed for testing
  _internals: {
    makeFinding,
    shannonEntropy,
    startsWithMagic,
    checkMagicBytes,
    checkZipBomb,
    checkPathTraversal,
    hexToBuffer,
    MAGIC_BYTES,
    BINARY_SIGNATURES,
    ZIP_BOMB_RATIO_THRESHOLD,
    HIGH_ENTROPY_THRESHOLD,
    TEXT_EXTENSIONS,
    RULE_OF_TWO,
  },
};
