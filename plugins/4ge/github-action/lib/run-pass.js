/**
 * run-pass.js — Execute one DFE pass against the PR diff using the Anthropic SDK.
 *
 * Usage: node run-pass.js <pass_id> <diff_file_path> <output_file_path>
 *
 * Writes structured JSON to output_file_path.
 * Exit 0 on success. Exit 1 on unrecoverable error.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Parse args ───────────────────────────────────────────────────────────────

const [, , passId, diffFilePath, outputFilePath] = process.argv;

if (!passId || !diffFilePath || !outputFilePath) {
  console.error('Usage: node run-pass.js <pass_id> <diff_file_path> <output_file_path>');
  process.exit(1);
}

// ─── Load pass definition ─────────────────────────────────────────────────────

const passesPath = join(__dirname, '..', 'passes.json');
const passesConfig = JSON.parse(readFileSync(passesPath, 'utf8'));
const passDef = passesConfig.passes.find((p) => p.id === passId);

if (!passDef) {
  console.error(`Unknown pass ID: ${passId}. Valid IDs: ${passesConfig.passes.map((p) => p.id).join(', ')}`);
  process.exit(1);
}

// ─── Load diff ────────────────────────────────────────────────────────────────

let diffContent;
try {
  diffContent = readFileSync(resolve(diffFilePath), 'utf8');
} catch (err) {
  console.error(`Failed to read diff file: ${diffFilePath} — ${err.message}`);
  process.exit(1);
}

if (!diffContent.trim()) {
  console.log(`${passId}: Empty diff — nothing to review`);
  const emptyResult = { pass: passId, verdict: 'CLEAN', findings: [] };
  writeFileSync(resolve(outputFilePath), JSON.stringify(emptyResult, null, 2));
  process.exit(0);
}

// ─── Determine model ──────────────────────────────────────────────────────────

const ALLOWED_SONNET_MODELS = new Set(['claude-sonnet-4-6']);
const ALLOWED_OPUS_MODELS = new Set(['claude-opus-4-8', 'claude-opus-4-7']);

function readModelEnv(envName, defaultValue) {
  return (process.env[envName] || defaultValue).trim();
}

function validateModelId(envName, model, allowedModels) {
  if (allowedModels.has(model)) return;

  console.error(`Invalid ${envName}: "${model}". Allowed values: ${[...allowedModels].join(', ')}`);
  process.exit(1);
}

const BASE_MODEL = readModelEnv('DFE_MODEL', 'claude-sonnet-4-6');
const OPUS_MODEL = readModelEnv('DFE_OPUS_MODEL', 'claude-opus-4-8');

validateModelId('DFE_MODEL', BASE_MODEL, ALLOWED_SONNET_MODELS);
validateModelId('DFE_OPUS_MODEL', OPUS_MODEL, ALLOWED_OPUS_MODELS);

const model = passDef.model_tier === 'opus' ? OPUS_MODEL : BASE_MODEL;

console.log(`${passId} (${passDef.name}): running on ${model}`);

// ─── Call Anthropic API ───────────────────────────────────────────────────────

const { default: Anthropic } = await import('@anthropic-ai/sdk');

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const userMessage = `Review this pull request diff for the ${passDef.name} pass.\n\n\`\`\`diff\n${diffContent}\n\`\`\``;

let responseText;

try {
  const message = await client.messages.create({
    model,
    max_tokens: 4096,
    system: passDef.system_prompt,
    messages: [
      {
        role: 'user',
        content: userMessage,
      },
    ],
  });

  if (message.content.length === 0 || message.content[0].type !== 'text') {
    throw new Error('Unexpected response structure from API');
  }

  responseText = message.content[0].text;
  console.log(`${passId}: API call complete (${message.usage.input_tokens} in / ${message.usage.output_tokens} out)`);
} catch (err) {
  console.error(`${passId}: API call failed — ${err.message}`);

  // Write a degraded result so the orchestrator can continue
  const degradedResult = {
    pass: passId,
    verdict: 'BLOCKED',
    error: err.message,
    findings: [],
  };
  writeFileSync(resolve(outputFilePath), JSON.stringify(degradedResult, null, 2));
  process.exit(1);
}

// ─── Extract JSON from response ───────────────────────────────────────────────

/**
 * Extract a fenced JSON block from the response text.
 * Claude is instructed to respond with ```json ... ``` — parse that first.
 * Fall back to the whole response if no fenced block is found.
 */
function extractJson(text) {
  // Try to find ```json ... ``` block
  const fencedMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (fencedMatch) {
    try {
      return JSON.parse(fencedMatch[1]);
    } catch (parseErr) {
      console.warn(`${passId}: Fenced JSON parse failed — ${parseErr.message}`);
    }
  }

  // Try to find a raw JSON object in the text
  const objectMatch = text.match(/\{[\s\S]*"pass"[\s\S]*"findings"[\s\S]*\}/);
  if (objectMatch) {
    try {
      return JSON.parse(objectMatch[0]);
    } catch (parseErr) {
      console.warn(`${passId}: Raw JSON parse failed — ${parseErr.message}`);
    }
  }

  return null;
}

let result = extractJson(responseText);

if (!result) {
  console.warn(`${passId}: Could not extract structured JSON from response — storing raw text`);
  result = {
    pass: passId,
    verdict: 'BLOCKED',
    parse_error: true,
    raw_response: responseText,
    findings: [],
  };
}

// ─── Validate and normalise result ────────────────────────────────────────────

const VALID_VERDICTS = new Set(['CLEAN', 'RISK', 'BLOCKED']);
const VALID_SEVERITIES = new Set(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']);
const VALID_CONFIDENCE = new Set(['TP', 'Likely TP', 'Uncertain']);

if (!VALID_VERDICTS.has(result.verdict)) {
  console.warn(`${passId}: Invalid verdict "${result.verdict}" — defaulting to BLOCKED`);
  result.verdict = 'BLOCKED';
}

result.pass = passId;
result.name = passDef.name;
result.model_used = model;

// Normalise findings array
result.findings = (result.findings || []).map((f, idx) => {
  const normalised = { ...f };

  if (!VALID_SEVERITIES.has(normalised.severity)) {
    console.warn(`${passId} finding[${idx}]: Invalid severity "${normalised.severity}" — defaulting to MEDIUM`);
    normalised.severity = 'MEDIUM';
  }

  if (!VALID_CONFIDENCE.has(normalised.confidence)) {
    normalised.confidence = 'Uncertain';
  }

  // Ensure numeric line if possible
  if (normalised.line !== undefined) {
    normalised.line = parseInt(String(normalised.line), 10) || 0;
  }

  return normalised;
});

console.log(`${passId}: ${result.verdict} — ${result.findings.length} findings`);

// ─── Write output ─────────────────────────────────────────────────────────────

writeFileSync(resolve(outputFilePath), JSON.stringify(result, null, 2));
console.log(`${passId}: Report written to ${outputFilePath}`);
