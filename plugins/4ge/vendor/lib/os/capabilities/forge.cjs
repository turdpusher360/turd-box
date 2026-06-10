'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SESSION_FILE = '.forge-session.json';
const PLAN_TIMEOUT_MS = 30 * 60 * 1000;

module.exports = {
  manifest: {
    name: 'forge',
    version: '1.0.0',
    description: 'Multi-teammate DAG orchestrator (7-phase workflow chain)',
    depends_on: ['forge-session'],
    actions: {
      run:                 { description: 'Start a forge session', args: ['task'] },
      resume:              { description: 'Resume a parked session', args: [] },
      park:                { description: 'Park current session', args: [] },
      status:              { description: 'Show session state', args: [] },
      'check-plan-timeout': { description: 'Check whether planning phase has exceeded 30-minute timeout', args: [] },
    },
    health() {
      const active = this._hasActiveSession();
      if (!active) {
        return { ok: true, active_session: false };
      }
      // Session file exists — validate it has required 'phase' field
      try {
        const raw = require('node:fs').readFileSync(
          require('node:path').join(process.cwd(), SESSION_FILE), 'utf8'
        );
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || !parsed.phase) {
          return { ok: false, reason: 'session file missing phase field', active_session: true };
        }
        return { ok: true, active_session: true };
      } catch (e) {
        return { ok: false, reason: `session file unparseable: ${e.message}`, active_session: true };
      }
    },
    resources: { max_concurrent: 1, typical_duration: '15m', uses_worktrees: true },
  },

  _os: null,
  _stateDir: null,

  probeCost: 'cheap',
  probe() {
    try {
      const exists = require('node:fs').existsSync(
        require('node:path').join(process.cwd(), '.forge-session.json')
      );
      return { ok: true, active_session: exists };
    } catch (e) {
      return { ok: false, reason: `probe threw: ${e.message}` };
    }
  },

  init(os) {
    const obs = os.observability;
    const t0 = Date.now();
    obs.log('capability', 'init-start', { capability: 'forge', severity: 'info' });

    try {
      this._os = os;
      this._stateDir = os.capDir;

      const hasActiveSession = this._hasActiveSession();
      obs.log('capability', 'init-complete', {
        capability: 'forge',
        severity: 'info',
        durationMs: Date.now() - t0,
        activeSession: hasActiveSession,
      });
    } catch (e) {
      obs.log('capability', 'init-error', {
        capability: 'forge',
        severity: 'error',
        message: e.message,
        durationMs: Date.now() - t0,
      });
      throw e;
    }
  },

  shutdown() {},

  _hasActiveSession() {
    try {
      return fs.existsSync(path.join(process.cwd(), SESSION_FILE));
    } catch {
      return false;
    }
  },

  _readSession() {
    try {
      const sessionPath = path.join(process.cwd(), SESSION_FILE);
      if (!fs.existsSync(sessionPath)) return null;
      return JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
    } catch {
      return null;
    }
  },

  _findParkedState() {
    try {
      const runsDir = path.join(process.cwd(), '_runs');
      if (!fs.existsSync(runsDir)) return null;

      const entries = fs.readdirSync(runsDir);
      for (const entry of entries) {
        if (entry.includes('forge-state-') && entry.endsWith('.json')) {
          const fullPath = path.join(runsDir, entry);
          const data = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
          if (data.parked) return data;
        }
      }
    } catch { /* best-effort */ }
    return null;
  },

  _startPlanTimer() {
    const session = this._readSession();
    if (session) {
      session.plan_started_at = new Date().toISOString();
      session.plan_timeout_ms = PLAN_TIMEOUT_MS;
      fs.writeFileSync(path.join(process.cwd(), SESSION_FILE), JSON.stringify(session, null, 2));
    }
  },

  _checkPlanTimeout() {
    const session = this._readSession();
    if (!session || !session.plan_started_at) return { expired: false, elapsed_ms: 0, has_plan: false };
    const elapsed = Date.now() - new Date(session.plan_started_at).getTime();
    if (elapsed > PLAN_TIMEOUT_MS) {
      return {
        expired: true,
        elapsed_ms: elapsed,
        has_plan: true,
        suggestion: 'Planning exceeded 30 minutes. Consider simplifying the task scope or breaking into sub-projects.',
      };
    }
    return { expired: false, elapsed_ms: elapsed, has_plan: true };
  },

  actions: {
    run(args, _os) {
      const { task } = args || {};
      if (!task) return { error: 'task description required' };

      // Emit session-start event when a forge run is initiated
      const os = module.exports._os;
      if (os && os.observability) {
        os.observability.log('capability', 'session-start', {
          capability: 'forge',
          severity: 'info',
          message: `Forge session started: ${task.slice(0, 80)}`,
        });
      }

      return {
        advisory: true,
        instruction: 'Invoke the forge:forge skill with this task description.',
        task,
        skill: 'forge:forge',
      };
    },

    resume(_args, _os) {
      const parked = this._findParkedState();
      if (!parked) return { error: 'no parked session found' };

      return {
        advisory: true,
        instruction: 'Invoke the forge:forge skill with "resume".',
        skill: 'forge:forge',
        parked_state: {
          slug: parked.slug,
          phase: parked.current_phase,
          plan_path: parked.plan_path,
        },
      };
    },

    park(_args, _os) {
      const session = this._readSession();
      if (!session) return { error: 'no active session to park' };

      // Emit session-complete (park) event
      const os = module.exports._os;
      if (os && os.observability) {
        os.observability.log('capability', 'session-complete', {
          capability: 'forge',
          severity: 'info',
          outcome: 'parked',
          slug: session.slug,
          phase: session.phase,
        });
      }

      return {
        advisory: true,
        instruction: 'Invoke the forge:forge skill with "park".',
        skill: 'forge:forge',
        session: {
          slug: session.slug,
          phase: session.phase,
        },
      };
    },

    'check-plan-timeout'(_args, _os) {
      return this._checkPlanTimeout();
    },

    status(_args, _os) {
      const session = this._readSession();
      if (!session) {
        const parked = this._findParkedState();
        if (parked) {
          return {
            active: false,
            parked: true,
            slug: parked.slug,
            phase: parked.current_phase,
            plan_path: parked.plan_path,
          };
        }
        return { active: false };
      }

      return {
        active: true,
        slug: session.slug,
        phase: session.phase,
        started: session.started,
        plan_path: session.plan_path,
        teammates: (session.teammates || []).map(t => ({
          name: t.name,
          agent: t.agent,
          status: t.status,
        })),
      };
    },
  },
};
