'use strict';
// companion-insights.cjs — Contextual one-liner engine for the companion speech bubble.
// getInsight(state) -> string | null
// Returns a contextual insight when rotation timer allows, null otherwise.
// Null means the caller should fall back to the static GREETINGS map.
//
// Message bar (project CLAUDE.md, "Companion (Anvil)"):
//   - Genuinely useful: tips and observations about the CURRENT work
//   - Warm and encouraging, never snarky
//   - Brief but substantive
//   - Context-aware: comment on what's actually happening (test results,
//     git state, forge phases, OS health) — not generic filler.
//
// Selection is tiered: event rules (something just happened) beat general
// contextual rules, which beat ambient personality lines. Ambient only
// surfaces when there is genuinely nothing contextual to say.

const fs = require('fs');
const http = require('http');
const path = require('path');

// ── File paths ────────────────────────────────────────────────────────────────
const _PROJECT_ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const STATE_FILE = path.join(_PROJECT_ROOT, '_runs', 'os', '.companion-insights.json');
const MEMORY_CACHE_FILE = path.join(_PROJECT_ROOT, '_runs', 'os', '.companion-memory-cache.json');

// ── State I/O ────────────────────────────────────────────────────────────────
function readState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch { /* fall through */ }
  return { lastInsightAt: 0, lastInsightId: null, sessionStartAt: Date.now() };
}

function writeState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state), 'utf8');
  } catch { /* silent — never crash HUD */ }
}

// ── Memory cache ─────────────────────────────────────────────────────────────
// Hub is queried via HTTP on the dev-memory hub port. All calls are best-effort:
// if the hub is down or slow (>500ms), we skip memory insights silently.
// Cache TTL is 5 minutes. Cache is read synchronously (file I/O is local).

const MEMORY_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const MEMORY_HUB_PORT = 8091;
const MEMORY_HUB_TIMEOUT = 500; // ms — never slow the HUD

/**
 * Synchronously read the on-disk memory cache.
 * Returns { fetchedAt, results } or null if missing/corrupt/expired.
 */
function readMemoryCache() {
  try {
    if (fs.existsSync(MEMORY_CACHE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(MEMORY_CACHE_FILE, 'utf8'));
      if (raw && typeof raw.fetchedAt === 'number' && Array.isArray(raw.results)) {
        if (Date.now() - raw.fetchedAt < MEMORY_CACHE_TTL) {
          return raw;
        }
      }
    }
  } catch { /* corrupt or missing — return null */ }
  return null;
}

/**
 * Write the memory cache to disk.
 * Silent on failure — never crash the HUD.
 */
function writeMemoryCache(results) {
  try {
    fs.writeFileSync(
      MEMORY_CACHE_FILE,
      JSON.stringify({ fetchedAt: Date.now(), results }),
      'utf8',
    );
  } catch { /* silent */ }
}

/**
 * Fire a single memory_search query to the hub via HTTP.
 * Returns parsed results array or null on any error/timeout.
 * Uses Node's built-in http module — no fetch, no dependencies.
 *
 * @param {string} query
 * @param {number} limit
 * @returns {Promise<Array|null>}
 */
function queryMemoryHub(query, limit) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (val) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };

    const body = JSON.stringify({
      method: 'tools/call',
      params: {
        name: 'memory_search',
        arguments: { query, limit: limit || 5, threshold: 0.4 },
      },
    });

    const options = {
      hostname: '127.0.0.1',
      port: MEMORY_HUB_PORT,
      path: '/mcp',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          // MCP response shape: { result: { content: [{ type: 'text', text: '...' }] } }
          // The text itself is JSON with { status, results }
          const content = parsed && parsed.result && parsed.result.content;
          if (Array.isArray(content) && content[0] && content[0].type === 'text') {
            const inner = JSON.parse(content[0].text);
            if (inner && Array.isArray(inner.results)) {
              settle(inner.results);
              return;
            }
          }
          settle(null);
        } catch { settle(null); }
      });
      res.on('error', () => settle(null));
    });

    req.on('error', () => settle(null));
    req.setTimeout(MEMORY_HUB_TIMEOUT, () => { req.destroy(); settle(null); });
    req.write(body);
    req.end();

    // Belt-and-suspenders timeout at JS level
    setTimeout(() => settle(null), MEMORY_HUB_TIMEOUT + 50);
  });
}

/**
 * Refresh the memory cache if stale, then return cached results.
 * This function MUST NOT be awaited in the synchronous rule evaluation path —
 * it is called speculatively (fire-and-forget) to warm the cache for future renders.
 * The synchronous getInsight() reads from the already-cached file.
 *
 * @param {string} [cwd]
 */
async function refreshMemoryCache(cwd) {
  try {
    // Only refresh if cache is absent or expired
    const existing = readMemoryCache();
    if (existing !== null) return; // still fresh

    // Derive the project slug from the active project directory so the memory
    // query reflects the user's own repo, not a hardcoded one.
    const projectDir = cwd || _PROJECT_ROOT;
    const projectSlug = path.basename(projectDir) || 'project';
    const query = `${projectSlug} session decisions constraints handoff`;

    const results = await queryMemoryHub(query, 8);
    if (results !== null) {
      writeMemoryCache(results);
    }
  } catch { /* never crash */ }
}

// ── Message helpers ──────────────────────────────────────────────────────────

/** Trim a string to one line of at most `max` chars (ellipsis if cut). */
function oneLine(str, max) {
  const flat = String(str || '').replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return flat.slice(0, max - 3) + '...';
}

/**
 * Git dirty count, only when ACTUALLY OBSERVED. smart-order returns
 * dirty: null for unobserved snapshots and explicitly forbids rendering
 * clean-tree messaging from them — so we distinguish three states:
 *   observedDirtyCount(s)  -> number  (0 = observed clean)
 *   observedDirtyCount(s)  -> null    (state never observed — say nothing)
 */
function observedDirtyCount(s) {
  const dirty = s && s.git ? s.git.dirty : undefined;
  if (typeof dirty === 'number') return dirty;
  if (dirty === true) return 1;   // boolean contract: observed dirty, count unknown
  if (dirty === false) return 0;  // observed clean
  return null;                    // null/undefined: unobserved — no claims
}

/** First non-shelved degraded capability entries, or []. AISLE is shelved by
 *  design (ADR-SEC-001) — flagging it every render would be noise, not signal. */
function degradedCaps(s) {
  const caps = s && s.os && s.os.capabilities;
  if (!caps || typeof caps !== 'object') return [];
  return Object.entries(caps).filter(
    ([, c]) => c && c.ok === false && c.shelved !== true
  );
}

// ── Rules ────────────────────────────────────────────────────────────────────
// Each rule: { id, category, condition(state), message(state), tone }
// Categories drive both tone filtering and selection tiering:
//   'event'   — something just happened (tests, commit, forge phase, export)
//   'os'      — OS capability health
//   'forge'   — active forge pipeline state
//   'session' | 'context' | 'git' | 'memory' — general contextual
//   'nudge'   — gentle suggestions (skipped under tone=minimal)
//   'ambient' — personality fallback (skipped under tone=technical/minimal,
//               and only ever shown when nothing contextual fires)

const RULES = [
  // ── Events — the moment that just happened ─────────────────────────────────
  {
    id: 'event-test-pass',
    category: 'event',
    condition: (s) => Boolean(s.context && s.context.event === 'test-pass'),
    message: (s) => {
      const dirty = observedDirtyCount(s);
      if (typeof dirty === 'number' && dirty > 0) {
        return `Tests green with ${dirty} file${dirty !== 1 ? 's' : ''} changed — good time to commit.`;
      }
      return 'Tests green. Clean pass.';
    },
    tone: 'warm',
  },
  {
    id: 'event-test-fail',
    category: 'event',
    condition: (s) => Boolean(s.context && s.context.event === 'test-fail'),
    message: () => 'A test failed. Start from the most recent edit and work back.',
    tone: 'warm',
  },
  {
    id: 'event-commit',
    category: 'event',
    condition: (s) => Boolean(s.context && s.context.event === 'commit'),
    message: (s) => {
      const subj = ((s.git && s.git.lastCommitMsg) || '').split('\n')[0].trim();
      return subj ? `Landed: "${oneLine(subj, 48)}"` : 'Commit landed. Tree is lighter.';
    },
    tone: 'warm',
  },
  {
    id: 'event-forge-phase',
    category: 'event',
    condition: (s) => Boolean(s.context && s.context.event === 'forge-phase'),
    message: (s) => {
      const phase = (s.forge && s.forge.phase) || '';
      return phase ? `Forge moved into ${oneLine(phase, 24)}.` : 'Forge moved to the next phase.';
    },
    tone: 'warm',
  },
  {
    id: 'event-badge-earned',
    category: 'event',
    condition: (s) => Boolean(s.context && s.context.event === 'badge-earned'),
    message: () => 'New badge earned. That one goes on the wall.',
    tone: 'warm',
  },
  {
    id: 'event-export',
    category: 'event',
    condition: (s) => Boolean(s.context && s.context.event === 'export'),
    message: () => 'Export complete. Worth a spot-check before it ships.',
    tone: 'warm',
  },

  // ── OS health ──────────────────────────────────────────────────────────────
  {
    id: 'os-degraded',
    category: 'os',
    condition: (s) => degradedCaps(s).length > 0,
    message: (s) => {
      const bad = degradedCaps(s);
      if (bad.length === 0) return null;
      const [name, cap] = bad[0];
      const more = bad.length > 1 ? ` (+${bad.length - 1} more)` : '';
      return `Heads up: ${name} capability is ${cap.status || 'degraded'}${more}.`;
    },
    tone: 'technical',
  },

  // ── Forge pipeline ─────────────────────────────────────────────────────────
  {
    id: 'forge-active',
    category: 'forge',
    condition: (s) => Boolean(s.forge && s.forge.active && s.forge.phase),
    message: (s) => {
      const tm = Array.isArray(s.forge.teammates) ? s.forge.teammates.length : 0;
      const phase = oneLine(s.forge.phase, 24);
      return tm > 0
        ? `Forge ${phase} underway — ${tm} teammate${tm !== 1 ? 's' : ''} on it.`
        : `Forge ${phase} underway.`;
    },
    tone: 'warm',
  },

  // ── Session rhythm ─────────────────────────────────────────────────────────
  {
    id: 'session-30m',
    category: 'session',
    condition: (s) => {
      const dur = s.session && s.session.duration;
      return typeof dur === 'number' && dur > 30 && dur <= 60;
    },
    message: (s) => {
      const added = (s.session && s.session.linesAdded) || 0;
      const removed = (s.session && s.session.linesRemoved) || 0;
      return (added + removed) > 0
        ? `30 minutes in — +${added}/-${removed} lines already.`
        : '30 minutes in. Settling into it.';
    },
    tone: 'warm',
  },
  {
    id: 'session-1h',
    category: 'session',
    condition: (s) => {
      const dur = s.session && s.session.duration;
      return typeof dur === 'number' && dur > 60 && dur <= 120;
    },
    message: (s) => {
      const tools = (s.session && s.session.toolCount) || 0;
      return tools > 0
        ? `An hour in, ${tools} tool calls deep. Good pace.`
        : 'An hour in. Good pace.';
    },
    tone: 'warm',
  },
  {
    id: 'session-2h',
    category: 'session',
    condition: (s) => {
      const dur = s.session && s.session.duration;
      return typeof dur === 'number' && dur > 120;
    },
    message: () => "Two hours deep. Worth a stretch — I'll keep watch.",
    tone: 'warm',
  },
  {
    id: 'commit-first',
    category: 'session',
    condition: (s) => {
      const msg = s.git && s.git.lastCommitMsg;
      const tools = (s.session && s.session.toolCount) || 0;
      return Boolean(msg) && tools < 50;
    },
    message: (s) => {
      const subj = ((s.git && s.git.lastCommitMsg) || '').split('\n')[0].trim();
      return subj
        ? `First commit landed: "${oneLine(subj, 40)}"`
        : 'First commit landed.';
    },
    tone: 'warm',
  },
  {
    id: 'tools-100',
    category: 'session',
    condition: (s) => {
      const t = (s.session && s.session.toolCount) || 0;
      return t > 100 && t <= 300;
    },
    message: (s) => `${s.session.toolCount} tool calls in. Solid momentum.`,
    tone: 'warm',
  },
  {
    id: 'tools-300',
    category: 'session',
    condition: (s) => {
      const t = (s.session && s.session.toolCount) || 0;
      return t > 300;
    },
    message: (s) => `${s.session.toolCount} tool calls — marathon. Watch context headroom.`,
    tone: 'warm',
  },

  // ── Context awareness ──────────────────────────────────────────────────────
  {
    id: 'ctx-fresh',
    category: 'context',
    condition: (s) => {
      const pct = (s.session && s.session.contextPct) || 0;
      return pct < 10;
    },
    message: () => 'Fresh context, full headroom. Big tasks fit best now.',
    tone: 'warm',
  },
  {
    id: 'ctx-quarter',
    category: 'context',
    condition: (s) => {
      const pct = (s.session && s.session.contextPct) || 0;
      return pct >= 20 && pct <= 40;
    },
    message: (s) => `Context at ${Math.round(s.session.contextPct)}%. Plenty of room to move.`,
    tone: 'warm',
  },
  {
    id: 'ctx-half',
    category: 'context',
    condition: (s) => {
      const pct = (s.session && s.session.contextPct) || 0;
      return pct >= 50 && pct <= 65;
    },
    message: (s) => `Context at ${Math.round(s.session.contextPct)}% — worth landing a milestone soon.`,
    tone: 'warm',
  },
  {
    id: 'ctx-high',
    category: 'context',
    condition: (s) => {
      const pct = (s.session && s.session.contextPct) || 0;
      return pct > 75;
    },
    message: (s) => `Context at ${Math.round(s.session.contextPct)}%. Commit what's in flight.`,
    tone: 'warm',
  },

  // ── Cost & efficiency ──────────────────────────────────────────────────────
  {
    id: 'cost-1',
    category: 'context',
    condition: (s) => {
      const cost = (s.session && s.session.cost) || 0;
      return cost >= 1 && cost < 3;
    },
    message: (s) => `Session cost so far: $${s.session.cost.toFixed(2)}.`,
    tone: 'technical',
  },
  {
    id: 'cost-3',
    category: 'context',
    condition: (s) => {
      const cost = (s.session && s.session.cost) || 0;
      return cost >= 3 && cost < 8;
    },
    message: (s) => `$${s.session.cost.toFixed(2)} in. Normal pace for a working session.`,
    tone: 'technical',
  },
  {
    id: 'cost-8',
    category: 'context',
    condition: (s) => {
      const cost = (s.session && s.session.cost) || 0;
      return cost >= 8;
    },
    message: (s) => `$${s.session.cost.toFixed(2)} this session — deep work. Make the context count.`,
    tone: 'warm',
  },
  {
    id: 'rate-countdown',
    category: 'context',
    condition: (s) => {
      const rl = s.session && s.session.rateLimits;
      if (!rl || rl === 'N/A') return false;
      return (rl.fiveHour >= 95 && rl.fiveHourResetsAt) || (rl.sevenDay >= 95 && rl.sevenDayResetsAt);
    },
    message: (s) => {
      const rl = s.session.rateLimits;
      const resetsAt = (rl.fiveHour >= 95 && rl.fiveHourResetsAt) || (rl.sevenDay >= 95 && rl.sevenDayResetsAt);
      if (!resetsAt) return 'Rate limit pressure — wrap the critical piece first.';
      const ms = new Date(resetsAt).getTime() - Date.now();
      if (ms <= 0) return 'Rate limit resetting now.';
      const min = Math.ceil(ms / 60000);
      return min > 60 ? `Rate limit resets in ${Math.round(min / 60)}h.` : `Rate limit resets in ${min}min.`;
    },
    tone: 'technical',
  },
  {
    id: 'cache-low',
    category: 'context',
    condition: (s) => {
      const input = (s.session && s.session.inputTokens) || 0;
      const cacheRead = (s.session && s.session.cacheReadTokens) || 0;
      if (input < 10000) return false; // too early to measure
      return cacheRead / input < 0.3;
    },
    message: (s) => {
      const ratio = Math.round(((s.session.cacheReadTokens || 0) / s.session.inputTokens) * 100);
      return `Cache hits at ${ratio}% — most input is full-price tokens.`;
    },
    tone: 'technical',
  },
  {
    id: 'api-wait',
    category: 'context',
    condition: (s) => {
      const total = (s.session && s.session.durationMs) || 0;
      const api = (s.session && s.session.apiDurationMs) || 0;
      if (total < 60000) return false; // too early
      return api / total > 0.6;
    },
    message: (s) => {
      const pct = Math.round(((s.session.apiDurationMs || 0) / s.session.durationMs) * 100);
      return `${pct}% of wall time waiting on API — parallel tool calls help.`;
    },
    tone: 'technical',
  },
  {
    id: 'exceeds-200k',
    category: 'context',
    condition: (s) => s.session && s.session.exceeds200k === true,
    message: () => 'Past 200K context — verify edits are landing as expected.',
    tone: 'warm',
  },
  {
    id: 'lines-velocity',
    category: 'session',
    condition: (s) => {
      const added = (s.session && s.session.linesAdded) || 0;
      const removed = (s.session && s.session.linesRemoved) || 0;
      return (added + removed) > 100;
    },
    message: (s) => {
      const added = s.session.linesAdded || 0;
      const removed = s.session.linesRemoved || 0;
      return `+${added} -${removed} lines this session.`;
    },
    tone: 'technical',
  },

  // ── Git awareness ──────────────────────────────────────────────────────────
  {
    id: 'git-dirty',
    category: 'git',
    condition: (s) => {
      const n = observedDirtyCount(s);
      return typeof n === 'number' && n > 0;
    },
    message: (s) => {
      const n = observedDirtyCount(s) || 1;
      if (n >= 15) {
        return `${n} files in flight — a checkpoint commit would derisk this.`;
      }
      return `${n} file${n !== 1 ? 's' : ''} changed since last commit.`;
    },
    tone: 'warm',
  },
  {
    id: 'git-ahead',
    category: 'git',
    condition: (s) => {
      const ahead = (s.git && s.git.ahead) || 0;
      return ahead > 0;
    },
    message: (s) => {
      const n = s.git.ahead;
      return `${n} commit${n !== 1 ? 's' : ''} ahead of origin. Push when ready.`;
    },
    tone: 'warm',
  },
  {
    id: 'git-behind',
    category: 'git',
    condition: (s) => {
      const behind = (s.git && s.git.behind) || 0;
      return behind > 0;
    },
    message: (s) => {
      const n = s.git.behind;
      return `${n} commit${n !== 1 ? 's' : ''} behind origin — pull before branching off.`;
    },
    tone: 'warm',
  },
  {
    id: 'git-clean',
    category: 'git',
    // Only claim a clean tree when cleanliness was OBSERVED (dirty === 0/false).
    // dirty: null means smart-order never probed — saying "clean" would be a lie.
    condition: (s) => {
      const n = observedDirtyCount(s);
      const branch = s.git && s.git.branch;
      return n === 0 && Boolean(branch);
    },
    message: (s) => `Clean tree on ${s.git.branch} — solid footing.`,
    tone: 'warm',
  },
  {
    id: 'git-old-commit',
    category: 'git',
    // Stale-commit age only matters when there is uncommitted work at risk.
    // On a clean tree, "last commit 4h ago" is noise, not signal.
    condition: (s) => {
      const age = (s.git && s.git.lastCommitAge) || 0;
      const n = observedDirtyCount(s);
      return age > 30 && typeof n === 'number' && n > 0;
    },
    message: (s) => {
      const m = Math.round(s.git.lastCommitAge);
      const label = m > 120 ? `${Math.round(m / 60)}h` : `${m}m`;
      return `Uncommitted work, last commit ${label} ago. Checkpoint when it holds.`;
    },
    tone: 'warm',
  },

  // ── Nudges ─────────────────────────────────────────────────────────────────
  {
    id: 'nudge-no-tests',
    category: 'nudge',
    condition: (s) => {
      const tools = (s.session && s.session.toolCount) || 0;
      // No vitest/jest in activeCommand or forge phase
      const forgePhase = (s.forge && s.forge.phase) || '';
      const active = (s.forge && s.forge.activeCommand) || '';
      const noTestSignal = !forgePhase.includes('test') && !active.includes('test');
      return tools > 50 && noTestSignal;
    },
    message: () => 'No test signal yet — a vitest pass is cheap insurance.',
    tone: 'technical',
  },
  {
    id: 'nudge-forge-idle',
    category: 'nudge',
    condition: (s) => {
      const forgeActive = s.forge && s.forge.active;
      const tools = (s.session && s.session.toolCount) || 0;
      return !forgeActive && tools > 100;
    },
    message: () => 'Long freeform run — /forge can give it structure.',
    tone: 'technical',
  },

  // ── Memory-backed insights ─────────────────────────────────────────────────
  // These rules read from the on-disk memory cache (populated by refreshMemoryCache).
  // If the cache is absent or expired, the conditions return false — silent skip.
  {
    id: 'memory-decision',
    category: 'memory',
    condition: () => {
      const cache = readMemoryCache();
      if (!cache) return false;
      return cache.results.some(
        (r) => r.memory && r.memory.memory_type === 'fact' && typeof r.memory.content === 'string'
      );
    },
    message: () => {
      const cache = readMemoryCache();
      if (!cache) return null;
      const hit = cache.results.find(
        (r) => r.memory && r.memory.memory_type === 'fact' && typeof r.memory.content === 'string'
      );
      if (!hit) return null;
      // Trim to a single line, max 80 chars for the speech bubble
      return oneLine(hit.memory.content, 80);
    },
    tone: 'technical',
  },
  {
    id: 'memory-constraint',
    category: 'memory',
    condition: () => {
      const cache = readMemoryCache();
      if (!cache) return false;
      return cache.results.some(
        (r) => r.memory && r.memory.memory_type === 'observation' && typeof r.memory.content === 'string'
      );
    },
    message: () => {
      const cache = readMemoryCache();
      if (!cache) return null;
      const hit = cache.results.find(
        (r) => r.memory && r.memory.memory_type === 'observation' && typeof r.memory.content === 'string'
      );
      if (!hit) return null;
      return oneLine(hit.memory.content, 80);
    },
    tone: 'technical',
  },
  {
    id: 'memory-session-tip',
    category: 'memory',
    condition: () => {
      const cache = readMemoryCache();
      if (!cache) return false;
      return cache.results.some(
        (r) => r.memory && r.memory.memory_type === 'event' && typeof r.memory.content === 'string'
      );
    },
    message: () => {
      const cache = readMemoryCache();
      if (!cache) return null;
      const hit = cache.results.find(
        (r) => r.memory && r.memory.memory_type === 'event' && typeof r.memory.content === 'string'
      );
      if (!hit) return null;
      return oneLine(hit.memory.content, 80);
    },
    tone: 'warm',
  },

  // ── Ambient / personality (fallback tier — shown only when nothing
  //    contextual fires; see selection tiering in getInsight) ────────────────
  {
    id: 'ambient-forge-warm',
    category: 'ambient',
    condition: () => true,
    message: () => 'Forge is warm.',
    tone: 'ambient',
  },
  {
    id: 'ambient-standing',
    category: 'ambient',
    condition: () => true,
    message: () => 'Standing watch — nothing needs you right now.',
    tone: 'ambient',
  },
  {
    id: 'ambient-tools',
    category: 'ambient',
    condition: () => true,
    message: () => 'Tools in order, bench is clear.',
    tone: 'ambient',
  },
  {
    id: 'ambient-ready',
    category: 'ambient',
    condition: () => true,
    message: () => 'Ready when you are.',
    tone: 'ambient',
  },
  {
    id: 'ambient-quiet',
    category: 'ambient',
    // Same observed-clean guard as git-clean: never claim quiet from an
    // unobserved git snapshot (dirty: null).
    condition: (s) => {
      const n = observedDirtyCount(s);
      const branch = s.git && s.git.branch;
      return n === 0 && Boolean(branch);
    },
    message: (s) => `All quiet on ${s.git.branch}.`,
    tone: 'ambient',
  },
];

// ── Tone filtering ───────────────────────────────────────────────────────────
// 'warm'      — all categories eligible
// 'technical' — skip ambient
// 'minimal'   — skip ambient AND nudge
function isEligibleByTone(rule, tone) {
  if (tone === 'minimal') {
    return rule.category !== 'ambient' && rule.category !== 'nudge';
  }
  if (tone === 'technical') {
    return rule.category !== 'ambient';
  }
  // 'warm' — everything eligible
  return true;
}

// ── Main export ──────────────────────────────────────────────────────────────
function getInsight(state) {
  try {
    const { loadCompanionConfig } = require('./companion-config.cjs');
    const config = loadCompanionConfig();
    const insightCfg = config.insights || {};

    if (insightCfg.enabled === false) return null;

    const rotationMs = typeof insightCfg.rotationMs === 'number'
      ? insightCfg.rotationMs
      : 45000;
    const tone = insightCfg.tone || 'warm';

    const persisted = readState();
    const now = Date.now();

    // Rotation gate: if we just showed an insight, stay quiet
    if (persisted.lastInsightAt && (now - persisted.lastInsightAt) < rotationMs) {
      return null;
    }

    // Collect eligible rules: condition passes + tone allows + not the last shown
    const eligible = RULES.filter((rule) => {
      if (rule.id === persisted.lastInsightId) return false;
      if (!isEligibleByTone(rule, tone)) return false;
      try {
        return rule.condition(state);
      } catch {
        return false;
      }
    });

    if (eligible.length === 0) return null;

    // Tiered pool — context-aware beats filler:
    //   1. event rules: something JUST happened (test result, commit, phase)
    //   2. any other contextual rule (os/forge/session/context/git/memory/nudge)
    //   3. ambient personality lines — only when there is nothing real to say
    const events = eligible.filter((r) => r.category === 'event');
    const contextual = eligible.filter(
      (r) => r.category !== 'event' && r.category !== 'ambient'
    );
    const ambient = eligible.filter((r) => r.category === 'ambient');
    const pool = events.length > 0 ? events : (contextual.length > 0 ? contextual : ambient);

    // Pick deterministically but with variety: use current minute as seed
    // so the same pick doesn't repeat for a full minute even if state doesn't
    // change. Walk forward from the seeded index so a rule whose message()
    // returns null (e.g. memory cache raced to expiry) falls through to the
    // next eligible rule instead of silencing the bubble entirely.
    const minuteSeed = Math.floor(now / 60000);
    for (let i = 0; i < pool.length; i++) {
      const picked = pool[(minuteSeed + i) % pool.length];

      let text;
      try {
        text = picked.message(state);
      } catch {
        continue;
      }
      if (!text || typeof text !== 'string') continue;

      writeState({
        lastInsightAt: now,
        lastInsightId: picked.id,
        sessionStartAt: persisted.sessionStartAt || now,
      });

      return text;
    }

    return null;
  } catch {
    return null;
  }
}

module.exports = { getInsight, RULES, refreshMemoryCache, readMemoryCache, writeMemoryCache, MEMORY_CACHE_TTL };
