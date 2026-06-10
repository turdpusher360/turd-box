#!/usr/bin/env node
/**
 * economy-command.cjs — CTX-ECON-001 T17
 * Handles /4ge economy subcommands: show, set tier, stats.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(process.cwd(), '.4ge-config.json');

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch { return { economy: { tier: 'standard' } }; }
}

function writeConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
}

function showStatus() {
  const config = readConfig();
  const tier = config.economy?.tier || 'standard';
  const override = config.economy?.subagent_model_override;
  const llm = config.economy?.local_llm_enabled !== false;
  const memFirst = config.economy?.memory_first !== false;

  const TIER_INFO = {
    low: { label: 'Low (aggressive savings)', model: 'inherit', filter: '50 lines' },
    standard: { label: 'Standard (balanced)', model: 'inherit', filter: '200 lines' },
    high: { label: 'High (full context)', model: 'inherit', filter: '500 lines' }
  };

  const info = TIER_INFO[tier] || TIER_INFO.standard;

  return [
    `  Economy tier: ${tier} — ${info.label}`,
    `  Subagent model: ${override || info.model}${override ? ' (override)' : ' (current runtime)'}`,
    `  Output filter: ${info.filter}`,
    `  Local LLM: ${llm ? 'enabled' : 'disabled'}`,
    `  Memory-first: ${memFirst ? 'enabled' : 'disabled'}`,
    '',
    '  * Economy tiers adjust context handling; model selection inherits the active runtime unless explicitly overridden.',
  ].join('\n');
}

function setTier(newTier) {
  const valid = ['low', 'standard', 'high'];
  if (!valid.includes(newTier)) {
    return `  Unknown tier: ${newTier}. Valid: ${valid.join(', ')}`;
  }
  const config = readConfig();
  config.economy = config.economy || {};
  config.economy.tier = newTier;
  writeConfig(config);
  return `  Economy tier set to: ${newTier}`;
}

function showStats() {
  const cachePath = path.join(process.cwd(), '_runs', '.read-cache.json');
  let cacheEntries = 0;
  try {
    const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    cacheEntries = Object.keys(cache).length;
  } catch { /* no cache yet */ }

  const compressedDir = path.join(process.cwd(), '_runs', 'rules-compressed');
  let compressedCount = 0;
  try {
    compressedCount = fs.readdirSync(compressedDir).filter(f => f.endsWith('.md')).length;
  } catch { /* no compressed rules yet */ }

  return [
    '  Session stats:',
    `    Read-once cache entries: ${cacheEntries}`,
    `    Compressed rules cached: ${compressedCount}`,
  ].join('\n');
}

module.exports = { showStatus, setTier, showStats };
