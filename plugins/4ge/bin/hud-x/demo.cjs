#!/usr/bin/env node
'use strict';

// HUD-X GLANCE — demo renderer. Synthetic view-model fixtures so the operator
// can eyeball every state without swapping settings.json:
//   node plugins/4ge/bin/hud-x/demo.cjs             # all scenarios
//   node plugins/4ge/bin/hud-x/demo.cjs --scenario=alert
//   node plugins/4ge/bin/hud-x/demo.cjs --full      # full-panel mode
//   node plugins/4ge/bin/hud-x/demo.cjs --cols=44   # force width

const { renderStatusline, renderFull, paint } = require('./engine.cjs');

const NOW = Date.parse('2026-07-09T03:00:00Z');

function baseVM() {
  return {
    now: NOW,
    repo: 'Sand_Box_Dev',
    sessionNumber: 550,
    model: 'Fable 5',
    modelShort: 'fable',
    context: { pct: 62, totalLabel: '1M', trend: 'up', history: [38, 40, 41, 45, 44, 48, 52, 55, 58, 60, 62] },
    usage: {
      sevenDayPct: 17,
      fiveHourPct: 33,
      sevenDayResetMs: 1.6 * 24 * 60 * 60 * 1000,
      fiveHourResetMs: 125 * 60 * 1000,
      posture: 'ABUNDANT',
      plan: 'Max',
      projected: 22.2,
    },
    os: {
      ready: 9,
      total: 9,
      degraded: [],
      bootMs: 1065,
      detail: ['aisle', 'audit', 'autoresearch', 'file-integrity', 'forge', 'forge-session', 'git', 'infra', 'process-health']
        .map((name) => ({ name, ready: true, initMs: 80 })),
    },
    git: {
      branch: 'main',
      dirty: 14,
      ahead: 0,
      behind: 0,
      sha: 'f6123f5',
      subject: 'feat(os): constraint register + rig sentinel re-arm',
      commitAgeMs: 3 * 60 * 60 * 1000,
    },
    session: {
      uptimeMs: 2 * 60 * 60 * 1000 + 14 * 60 * 1000,
      toolCount: 325,
      costUsd: 41.2,
      inTok: 179730,
      outTok: 12400,
      active: true,
      idleMs: 0,
    },
    forge: { active: false, phase: '', scope: '', teammates: 0, progressPct: null },
    reactive: null,
    anomaly: null,
    rig: { status: 'ok', issueCount: 0, headline: 'rig context ok', isStale: false },
    sentinel: { red: [], overdue: 0, ok: 15, total: 15, ranAt: '2026-07-09T00:21:13Z' },
    companion: { message: null, insight: null },
    memory: { lastSession: 'GH outage diagnosed + self-hosted CI live + register/sentinel shipped', next: '' },
  };
}

function merge(vm, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && vm[key] && typeof vm[key] === 'object') {
      Object.assign(vm[key], value);
    } else {
      vm[key] = value;
    }
  }
  return vm;
}

const SCENARIOS = {
  healthy: {
    cols: 100,
    note: 'nominal — quiet line, calm eyes, dark cockpit',
    vm: () => merge(baseVM(), { session: { uptimeMs: 40 * 60 * 1000, active: false } }),
  },
  momentum: {
    cols: 100,
    note: 'first minutes of a session — Anvil surfaces last-session momentum',
    vm: () => merge(baseVM(), { session: { uptimeMs: 3 * 60 * 1000 } }),
  },
  degraded: {
    cols: 100,
    note: 'capability down — voice goes red, annunciator counts the rest',
    vm: () => merge(baseVM(), {
      os: { ready: 7, total: 9, degraded: ['aisle', 'infra'] },
      rig: { status: 'warn', issueCount: 2, headline: '2 rig checks need attention' },
    }),
  },
  alert: {
    cols: 100,
    note: 'sentinel red + hot context + burn — worst case, strict priority',
    vm: () => merge(baseVM(), {
      sentinel: { red: ['disable-auto-compact'], overdue: 1, ok: 14, total: 15, ranAt: '2026-07-09T00:21:13Z' },
      context: { pct: 91, trend: 'up' },
      usage: { sevenDayPct: 83, fiveHourPct: 67 },
    }),
  },
  forge: {
    cols: 100,
    note: 'live lane — working eyes, lane owns the ship-row tail',
    vm: () => merge(baseVM(), {
      forge: { active: true, phase: 'execute', scope: 'hud-x build', teammates: 3, progressPct: 62 },
    }),
  },
  speaking: {
    cols: 100,
    note: 'Anvil speaks — italic + ramp, thinking eyes',
    vm: () => merge(baseVM(), {
      companion: { message: { text: 'tests are green on the sentinel suite — nice, that was the risky one', tier: 'signal' }, insight: null },
    }),
  },
  commit: {
    cols: 100,
    note: 'fresh commit — happy eyes (bottom lids up), green tick',
    vm: () => merge(baseVM(), {
      reactive: { event: 'commit', ageMs: 20000 },
      git: { dirty: 0, commitAgeMs: 4 * 60 * 1000 },
    }),
  },
  narrow: {
    cols: 44,
    note: 'phone via Termius — same 4 rows, density drops, geometry holds',
    vm: () => merge(baseVM(), { session: { uptimeMs: 40 * 60 * 1000, active: false } }),
  },
  'narrow-alert': {
    cols: 44,
    note: 'phone + trouble — red survives narrow',
    vm: () => merge(baseVM(), {
      sentinel: { red: ['agent-cap-8'], overdue: 0, ok: 14, total: 15, ranAt: '2026-07-09T00:21:13Z' },
      context: { pct: 88 },
    }),
  },
  idle: {
    cols: 100,
    note: 'long idle — Anvil rests, frame is byte-stable between refreshes',
    vm: () => merge(baseVM(), {
      session: { active: false, idleMs: 20 * 60 * 1000, uptimeMs: 3 * 60 * 60 * 1000 },
      git: { dirty: 0 },
    }),
  },
};

function parseArgs(argv) {
  const args = { scenario: null, cols: null, full: false };
  for (const arg of argv) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (!m) continue;
    if (m[1] === 'scenario') args.scenario = m[2];
    else if (m[1] === 'cols') args.cols = Number(m[2]) || null;
    else if (m[1] === 'full') args.full = true;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const names = args.scenario ? [args.scenario] : Object.keys(SCENARIOS);
  const out = [];

  for (const name of names) {
    const scenario = SCENARIOS[name];
    if (!scenario) {
      out.push(`unknown scenario: ${name} (have: ${Object.keys(SCENARIOS).join(', ')})`);
      continue;
    }
    const cols = args.cols || scenario.cols;
    const vm = scenario.vm();
    out.push(paint.dim(`── ${name} (${cols} cols) — ${scenario.note} ${'─'.repeat(Math.max(0, 30 - name.length))}`));
    out.push(args.full ? renderFull(vm, { cols }) : renderStatusline(vm, { cols, maxRows: 8 }));
    out.push('');
  }

  process.stdout.write(`${out.join('\n')}\n`);
}

if (require.main === module) main();

module.exports = { SCENARIOS, baseVM };
