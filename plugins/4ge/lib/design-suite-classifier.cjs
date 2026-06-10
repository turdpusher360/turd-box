// plugins/4ge/lib/design-suite-classifier.cjs
'use strict';

const VISUAL_PATTERNS = [
  /\.tsx$/,
  /\.jsx$/,
  /\.vue$/,
  /\.svelte$/,
  /\.css$/,
  /\.scss$/,
  /\.sass$/,
  /\.less$/,
  /\.styl$/,
  /tailwind\.config/,
  /postcss\.config/,
];

const API_PATTERNS = [
  /\/api\//,
  /\/routes\//,
  /\/controllers?\//,
  /\/handlers?\//,
  /\/middleware\//,
  /\.controller\.[jt]sx?$/,
  /\.handler\.[jt]sx?$/,
  /\.route\.[jt]sx?$/,
  /openapi\.(json|ya?ml)$/,
  /swagger\.(json|ya?ml)$/,
];

const DATA_PATTERNS = [
  /\.prisma$/,
  /\.sql$/,
  /\/migrations?\//,
  /\/models?\//,
  /\/entities?\//,
  /\/schemas?\//,
  /\.schema\.[jt]sx?$/,
  /drizzle\.config/,
  /knexfile/,
];

const SYSTEM_PATTERNS = [
  /(^|\/)docs?\/(architecture|design|adr|system)/i,
  /docker-compose\.(ya?ml|json)$/,
  /Dockerfile$/,
  /\.github\/workflows\//,
  /terraform/,
  /\.tf$/,
  /pulumi/,
  /cdk\.json$/,
  /wrangler\.(toml|jsonc?)$/,
];

const MODE_PATTERNS = {
  visual: VISUAL_PATTERNS,
  api: API_PATTERNS,
  data: DATA_PATTERNS,
  system: SYSTEM_PATTERNS,
};

/**
 * Classifies a set of file paths into a design mode.
 *
 * @param {string[]} filePaths - Array of file paths being worked on
 * @returns {{ mode: string, confidence: number, signals: string[] }}
 */
function classifyContext(filePaths) {
  const scores = { visual: 0, api: 0, data: 0, system: 0 };
  const signals = [];

  for (const fp of filePaths) {
    for (const [mode, patterns] of Object.entries(MODE_PATTERNS)) {
      for (const pattern of patterns) {
        if (pattern.test(fp)) {
          scores[mode]++;
          signals.push(`${mode}:${fp}`);
          break; // one match per mode per file
        }
      }
    }
  }

  // Find the mode with highest score (insertion order wins on tie)
  let bestMode = 'visual';
  let bestScore = 0;
  const totalFiles = filePaths.length || 1;

  for (const [mode, score] of Object.entries(scores)) {
    if (score > bestScore) {
      bestScore = score;
      bestMode = mode;
    }
  }

  const confidence = totalFiles > 0 ? bestScore / totalFiles : 0;

  return { mode: bestMode, confidence, signals };
}

module.exports = { classifyContext, VISUAL_PATTERNS, API_PATTERNS, DATA_PATTERNS, SYSTEM_PATTERNS, MODE_PATTERNS };
