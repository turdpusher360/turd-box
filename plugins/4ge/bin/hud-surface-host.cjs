'use strict';

const path = require('node:path');
const { loadHudData, mergeHarnessStdin } = require('./hud-data-loader.cjs');
const { renderByMode, resolveProjectRoot } = require('./hud-engine.cjs');

function defaultProjectRoot() {
  return resolveProjectRoot({
    envProjectDir: process.env.CLAUDE_PROJECT_DIR,
    fallbackRoot: path.resolve(__dirname, '..', '..', '..'),
  });
}

function resolveSurfaceProjectRoot(options = {}) {
  return resolveProjectRoot({
    envProjectDir: options.projectRoot || options.envProjectDir || process.env.CLAUDE_PROJECT_DIR,
    workspaceProjectDir: options.workspaceProjectDir || '',
    stdinCwd: options.stdinCwd || '',
    fallbackRoot: options.fallbackRoot || defaultProjectRoot(),
  });
}

function surfaceStateDir(projectRoot, options = {}) {
  return options.stateDir || path.join(projectRoot, '_runs', 'os');
}

function applySurfaceOverrides(rawState, options = {}) {
  const state = (rawState && typeof rawState === 'object') ? rawState : {};
  if (options.terminal && typeof options.terminal === 'object') {
    state.terminal = Object.assign({}, state.terminal, options.terminal);
  }
  if (options.context && typeof options.context === 'object') {
    state.context = Object.assign({}, state.context, options.context);
  }
  if (options.session && typeof options.session === 'object') {
    state.session = Object.assign({}, state.session, options.session);
  }
  if (options.git && typeof options.git === 'object') {
    state.git = Object.assign({}, state.git || {}, options.git);
  }
  if (options.theme && typeof options.theme === 'object') {
    state.theme = Object.assign({}, state.theme, options.theme);
  }
  return state;
}

function loadSurfaceState(options = {}) {
  const projectRoot = resolveSurfaceProjectRoot(options);
  const rawState = loadHudData({
    stateDir: surfaceStateDir(projectRoot, options),
    cwd: projectRoot,
    runExpensiveProbes: !!options.runExpensiveProbes,
    stdinOverride: options.stdinOverride || null,
  });
  rawState.projectRoot = projectRoot;
  if (options.harnessStdin) mergeHarnessStdin(rawState, options.harnessStdin);
  return applySurfaceOverrides(rawState, options);
}

function renderSurface(options = {}) {
  const mode = options.mode || 'full';
  const maxRows = options.maxRows;
  const rawState = options.rawState
    ? applySurfaceOverrides(options.rawState, options)
    : loadSurfaceState(options);
  return {
    state: rawState,
    output: renderByMode(rawState, mode, maxRows),
  };
}

module.exports = {
  defaultProjectRoot,
  resolveSurfaceProjectRoot,
  surfaceStateDir,
  applySurfaceOverrides,
  loadSurfaceState,
  renderSurface,
};
