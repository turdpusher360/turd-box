'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const PLUGIN_VERSION = '2.8.0';

// ---------------------------------------------------------------------------
// Internal paths
// ---------------------------------------------------------------------------

function _dotFgeDir() {
  return path.join(os.homedir(), '.4ge');
}

function _configPath() {
  return path.join(_dotFgeDir(), 'config.json');
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

/**
 * isFirstRun() — true if ~/.4ge/ directory does not exist
 */
function isFirstRun() {
  return !fs.existsSync(_dotFgeDir());
}

/**
 * getSetupSteps() — returns array of 3 step objects { step, title, text }
 *
 * Imports tier-gate to show current tier in the welcome step.
 * Gracefully falls back to 'free' if tier-gate is unavailable.
 */
function getSetupSteps() {
  let currentTier = 'free';
  try {
    const tierGate = require('./tier-gate.cjs');
    currentTier = tierGate.current();
  } catch {
    // tier-gate unavailable — default to free display
  }

  const tierLabel = currentTier === 'free'
    ? 'Free (starter commands unlocked)'
    : currentTier === 'pro'
      ? 'Pro (all Pro commands unlocked)'
      : 'Team (all Pro commands + team features)';

  return [
    {
      step: 1,
      title: 'Welcome',
      text: [
        '4ge makes Claude Code production-grade.',
        'Memory, orchestration, review, security -- in one plugin.',
        '',
        `Your tier: ${tierLabel}`,
        'Upgrade to Pro for all Pro commands: https://3sixtyco.dev/4ge',
        '',
        '(enter) continue    (s) skip setup',
      ].join('\n'),
    },
    {
      step: 2,
      title: 'Memory Connection',
      text: [
        '4ge works best with persistent memory across sessions.',
        '',
        '(l) Local Docker (you run it)     -- requires Docker + GPU',
        '(h) Hosted (we run it)            -- requires Team, $39/seat/mo',
        '(s) Skip (no memory)              -- basic mode, no persistence',
      ].join('\n'),
    },
    {
      step: 3,
      title: 'Ready',
      text: [
        'Setup complete. Try these first:',
        '',
        '/ship      Verify and push your current work',
        '/map       See your repository structure',
        '/recall    Search memory (if connected)',
        '/help      Full command reference',
        '',
        'Config saved to ~/.4ge/config.json',
      ].join('\n'),
    },
  ];
}

/**
 * completeSetup(options) — creates ~/.4ge/ and writes config.json
 *
 * @param {object} options
 * @param {string} [options.tier]    - 'free'|'pro'|'team' (default: 'free')
 * @param {string} [options.memory]  - 'none'|'local'|'hosted' (default: 'none')
 */
function completeSetup(options) {
  const opts = options || {};
  const tier = opts.tier || 'free';
  const memory = opts.memory || 'none';

  const dir = _dotFgeDir();
  fs.mkdirSync(dir, { recursive: true });

  const config = {
    setupComplete: true,
    setupDate: new Date().toISOString(),
    tier,
    memory,
    version: PLUGIN_VERSION,
  };

  fs.writeFileSync(_configPath(), JSON.stringify(config, null, 2), 'utf8');

  return config;
}

// ---------------------------------------------------------------------------
// Wave 2B: context-aware "What to do next" suggestions
// ---------------------------------------------------------------------------

/**
 * suggestNext(projectRoot) — prints "What to do next" with context-aware
 * suggestions based on what exists in the project root.
 *
 * Always suggests /4ge tour.
 * Suggests /4ge map  when package.json is present.
 * Suggests /4ge forge when .git is present.
 *
 * @param {string} [projectRoot] - Directory to probe (default: process.cwd())
 */
function suggestNext(projectRoot) {
  const root = projectRoot || process.cwd();
  const suggestions = ['/4ge tour    — 5-step walkthrough of the best commands'];

  if (fs.existsSync(path.join(root, '.git'))) {
    suggestions.unshift('/4ge forge   — start a Forge session (brainstorm → ship)');
  }
  if (fs.existsSync(path.join(root, 'package.json'))) {
    suggestions.unshift('/4ge map     — visual dependency map of this project');
  }

  console.log('\nWhat to do next:');
  for (const s of suggestions) {
    console.log(`  ${s}`);
  }
}

// ---------------------------------------------------------------------------
// Wave 2B: inline tour step 1 text (for --tour chaining)
// ---------------------------------------------------------------------------

const _TOUR_STEP1 = [
  '/4ge Tour — Step 1/5',
  '════════════════════════════════════════',
  '',
  'Step 1/5 — Discover what\'s here',
  '  Run:  /help',
  '  You\'ll see all commands grouped by tier (Free / Pro).',
  '  Try: /help forge   to read the full spec for any command.',
  '',
  '(Step 1/5 complete)',
  'Run /tour --step 2 to continue, or /tour to restart from step 1.',
].join('\n');

/**
 * getTourStep1() — returns the step-1 tour text as a string.
 * Used by the --tour flag handler and by tests.
 */
function getTourStep1() {
  return _TOUR_STEP1;
}

/**
 * hasTourFlag() — returns true if --tour is present in process.argv.
 */
function hasTourFlag() {
  return process.argv.includes('--tour');
}

module.exports = {
  isFirstRun,
  getSetupSteps,
  completeSetup,
  suggestNext,
  getTourStep1,
  hasTourFlag,
};
