'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const STATE_FILE = 'forge-sessions.json';
const MAX_HISTORY = 20;
const SESSION_TIMEOUT_MS = 4 * 60 * 60 * 1000; // 4 hours

const STATE_VALUES = ['staged', 'executing', 'parked', 'shipped'];

// Allowed state transitions: { from: [to1, to2, ...] }
const TRANSITIONS = {
  staged:    ['executing'],
  executing: ['parked', 'shipped'],
  parked:    ['executing', 'shipped'],
  shipped:   [], // terminal — no transitions allowed
};

module.exports = {
  manifest: {
    name: 'forge-session',
    version: '2.0.0',
    description: 'Forge session state management (quad-state: staged/executing/parked/shipped)',
    depends_on: [],
    actions: {
      create: { description: 'Create a new forge session', args: ['scope', 'phase'] },
      update: { description: 'Update current session phase, teammates, scope, or state', args: ['phase', 'teammates', 'scope', 'state'] },
      end:    { description: 'End the current session', args: [] },
      status: { description: 'Return current session, history count, and state breakdown', args: [] },
    },
    health() {
      return {
        ok: this._state !== null,
        active_session: this._state !== null && this._state.current !== null,
      };
    },
    resources: { typical_duration: '30m' },
  },

  _os: null,
  _stateFile: null,
  _state: null,

  probeCost: 'cheap',
  probe() {
    try {
      const stateFile = path.join(process.cwd(), '_runs', 'os', 'forge-sessions.json');
      if (!fs.existsSync(stateFile)) {
        return { ok: true, active_session: false };
      }
      const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      return { ok: true, active_session: !!(raw && raw.current) };
    } catch (e) {
      return { ok: false, reason: `probe threw: ${e.message}` };
    }
  },

  init(os) {
    const obs = os.observability;
    const t0 = Date.now();
    obs.log('capability', 'init-start', { capability: 'forge-session', severity: 'info' });

    try {
      this._os = os;
      this._stateFile = path.join(os.capDir, STATE_FILE);
      this._state = this._loadState();

      obs.log('capability', 'init-complete', {
        capability: 'forge-session',
        severity: 'info',
        durationMs: Date.now() - t0,
        hasActiveSession: this._state.current !== null,
        historyCount: this._state.history.length,
      });
    } catch (e) {
      obs.log('capability', 'init-error', {
        capability: 'forge-session',
        severity: 'error',
        message: e.message,
        durationMs: Date.now() - t0,
      });
      throw e;
    }
  },

  shutdown() {
    this._saveState();
  },

  _loadState() {
    try {
      if (fs.existsSync(this._stateFile)) {
        const data = JSON.parse(fs.readFileSync(this._stateFile, 'utf8'));
        const current = data.current || null;
        const history = Array.isArray(data.history) ? data.history : [];

        // Backward-compat: current session without state was mid-flight
        if (current && !current.state) {
          current.state = 'executing';
        }
        for (const s of history) {
          if (!s.state) {
            s.state = s.endedAt ? 'parked' : 'staged';
          }
        }

        return { current, history };
      }
    } catch { /* start fresh */ }
    return { current: null, history: [] };
  },

  _saveState() {
    if (!this._stateFile) return;
    try {
      fs.mkdirSync(path.dirname(this._stateFile), { recursive: true });
      fs.writeFileSync(this._stateFile, JSON.stringify(this._state, null, 2) + '\n');
    } catch { /* best-effort */ }
  },

  actions: {
    create(args) {
      const { scope, phase } = args || {};
      if (!scope) return { ok: false, error: 'scope is required' };

      // End any stale active session before creating a new one
      if (this._state.current) {
        const elapsed = Date.now() - new Date(this._state.current.startedAt).getTime();
        if (elapsed > SESSION_TIMEOUT_MS) {
          const stale = {
            ...this._state.current,
            state: 'parked',
            endedAt: new Date().toISOString(),
            endReason: 'timeout',
          };
          this._state.history.unshift(stale);
          this._state.history = this._state.history.slice(0, MAX_HISTORY);
        } else {
          return { ok: false, error: 'session already active; call end first' };
        }
      }

      const session = {
        id: crypto.randomUUID(),
        scope,
        phase: phase || 'scope',
        state: 'staged',
        startedAt: new Date().toISOString(),
        teammates: [],
      };
      this._state.current = session;
      this._saveState();
      return { ok: true, session };
    },

    update(args) {
      if (!this._state.current) return { ok: false, error: 'no active session' };
      const { phase, teammates, scope, state } = args || {};

      // State transition validation
      if (state !== undefined) {
        if (!STATE_VALUES.includes(state)) {
          return { ok: false, error: `invalid state: ${state}. Must be one of: ${STATE_VALUES.join(', ')}` };
        }
        const currentState = this._state.current.state || 'staged';
        const allowed = TRANSITIONS[currentState] || [];
        if (!allowed.includes(state)) {
          return { ok: false, error: `illegal state transition: ${currentState} -> ${state}` };
        }

        // Emit session-state-change event on valid transitions
        const os = module.exports._os;
        if (os && os.observability) {
          os.observability.log('capability', 'session-state-change', {
            capability: 'forge-session',
            severity: 'info',
            sessionId: this._state.current.id,
            fromState: currentState,
            toState: state,
            scope: this._state.current.scope,
          });
        }

        this._state.current.state = state;
      }

      if (phase !== undefined) this._state.current.phase = phase;
      if (teammates !== undefined) this._state.current.teammates = teammates;
      if (scope !== undefined) this._state.current.scope = scope;
      this._state.current.updatedAt = new Date().toISOString();
      this._saveState();
      return { ok: true, session: this._state.current };
    },

    end(_args) {
      if (!this._state.current) return { ok: false, error: 'no active session' };

      const currentState = this._state.current.state || 'staged';
      let endState;
      if (currentState === 'executing') {
        // Interrupted mid-execution — park for later resume
        endState = 'parked';
      } else if (currentState === 'parked') {
        // Explicitly ending a parked session — ship it
        endState = 'shipped';
      } else {
        // staged, never executed — abandoned (park, not ship)
        endState = 'parked';
      }

      const ended = {
        ...this._state.current,
        state: endState,
        endedAt: new Date().toISOString(),
      };
      this._state.history.unshift(ended);
      this._state.history = this._state.history.slice(0, MAX_HISTORY);
      this._state.current = null;
      this._saveState();
      return { ok: true, ended };
    },

    status(_args) {
      const breakdown = { staged: 0, executing: 0, parked: 0, shipped: 0 };
      for (const s of this._state.history) {
        const st = s.state || 'parked';
        if (breakdown[st] !== undefined) breakdown[st]++;
      }
      return {
        ok: true,
        current: this._state.current,
        current_state: this._state.current ? (this._state.current.state || null) : null,
        history_count: this._state.history.length,
        state_breakdown: breakdown,
        recent: this._state.history.slice(0, 3),
      };
    },
  },
};
