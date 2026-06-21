'use strict';

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (value && typeof value === 'object') {
    const copy = {};
    for (const [key, child] of Object.entries(value)) copy[key] = cloneValue(child);
    return copy;
  }
  return value;
}

const EVENT_CATALOG = deepFreeze({
  commit: {
    ttlMs: 30000,
    throttleMs: 30000,
    tier: 'signal',
    major: true,
    companionState: 'commit',
    statuslineZones: ['gitStatus'],
    compactHint: 'commit',
    compactMessage: 'committed',
  },
  push: {
    ttlMs: 30000,
    throttleMs: 30000,
    tier: 'signal',
    major: true,
    companionState: 'push',
    statuslineZones: ['gitStatus'],
    compactHint: 'push',
    compactMessage: 'pushed',
  },
  'skill-load': {
    ttlMs: 8000,
    throttleMs: 30000,
    tier: 'flash',
    major: true,
    companionState: 'skill-load',
    statuslineZones: ['activity'],
    compactHint: 'skill-load',
    compactMessage: 'skill loaded',
  },
  'test-pass': {
    ttlMs: 8000,
    throttleMs: 30000,
    tier: 'flash',
    major: true,
    companionState: 'tests-pass',
    statuslineZones: ['activity', 'gitStatus'],
    statuslineRole: 'ok',
    compactHint: 'tests-pass',
    compactMessage: 'all tests green',
    zoneBoost: { session: 8, cards: 6 },
  },
  'test-fail': {
    ttlMs: 30000,
    throttleMs: 30000,
    tier: 'signal',
    major: true,
    companionState: 'tests-fail',
    statuslineZones: ['health', 'activity'],
    statuslineRole: 'error',
    compactHint: 'tests-fail',
    compactMessage: 'tests failed',
    zoneBoost: { session: 8, cards: 8 },
  },
  'error-state': {
    ttlMs: 120000,
    throttleMs: 10000,
    tier: 'critical',
    major: true,
    companionState: 'error',
    statuslineZones: ['health', 'activity'],
    statuslineRole: 'error',
    compactHint: 'error',
  },
  'rate-limit-warn': {
    ttlMs: 120000,
    throttleMs: 120000,
    tier: 'critical',
    major: true,
    companionState: 'rate-limited',
    statuslineZones: ['rate', 'context'],
    statuslineRole: 'warn',
    compactHint: 'rate-limited',
  },
  'context-high': {
    ttlMs: 30000,
    throttleMs: 60000,
    tier: 'signal',
    companionState: 'context-warn',
    statuslineZones: ['context'],
    statuslineRole: 'warn',
    compactHint: 'context-warn',
  },
  'forge-phase': {
    ttlMs: 30000,
    throttleMs: 30000,
    tier: 'signal',
    statuslineZones: ['forge', 'forgeProgress'],
    compactMessage: 'forge phase transition',
    zoneBoost: { forge: 9, cards: 8 },
  },
  'badge-earned': {
    ttlMs: 8000,
    throttleMs: 60000,
    tier: 'flash',
    statuslineZones: ['badges'],
    compactMessage: 'badge earned',
    zoneBoost: { badges: 9, cards: 7 },
  },
  export: {
    ttlMs: 8000,
    throttleMs: 60000,
    tier: 'flash',
    statuslineZones: ['activity'],
  },
  'zone-change': {
    ttlMs: 8000,
    throttleMs: 30000,
    tier: 'flash',
    statuslineZones: ['activity'],
    compactMessage: 'zone updated',
  },
  'session-end': {
    ttlMs: 120000,
    throttleMs: 0,
    tier: 'critical',
    statuslineZones: ['session'],
    statuslineRole: 'warn',
  },
});

const EVENT_KEYS = Object.freeze(Object.keys(EVENT_CATALOG));

function mapBy(field) {
  const out = {};
  for (const key of EVENT_KEYS) {
    const value = EVENT_CATALOG[key][field];
    if (value !== undefined) out[key] = cloneValue(value);
  }
  return out;
}

function reactiveTtlMap() { return mapBy('ttlMs'); }
function eventThrottleMap() { return mapBy('throttleMs'); }
function eventTierMap() { return mapBy('tier'); }
function companionEventMap() { return mapBy('companionState'); }
function statuslineZoneMap() { return mapBy('statuslineZones'); }
function statuslineRoleMap() { return mapBy('statuslineRole'); }
function zoneBoostMap() { return mapBy('zoneBoost'); }
function compactCompanionHintMap() { return mapBy('compactHint'); }
function compactMessageMap() { return mapBy('compactMessage'); }

function majorEventSet() {
  return new Set(EVENT_KEYS.filter((key) => EVENT_CATALOG[key].major === true));
}

function eventConfig(key) {
  return EVENT_CATALOG[key] || null;
}

module.exports = {
  EVENT_CATALOG,
  EVENT_KEYS,
  eventConfig,
  reactiveTtlMap,
  eventThrottleMap,
  eventTierMap,
  majorEventSet,
  companionEventMap,
  statuslineZoneMap,
  statuslineRoleMap,
  zoneBoostMap,
  compactCompanionHintMap,
  compactMessageMap,
};
