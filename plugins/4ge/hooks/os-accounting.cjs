#!/usr/bin/env node
/**
 * PostToolUse Hook: os-accounting — Plugin Hook (4ge) [D3 port]
 *
 * Three-tier accounting for the Agentic OS cost-tracking capability.
 * - Tier 1: Heuristic token estimation for all tools
 * - Tier 2: Real data extraction for completed Agent tool calls
 * - Heartbeat per-agent file writes
 * - Leak pattern detection (redundant_read, failed_tool, scatter_search, wrong_tool, oversized_result)
 *
 * Writes to: _runs/os/resource-ledger.jsonl, _runs/os/heartbeats/{aid}.json,
 *            _runs/os/agent-state-{aid}.json, _runs/os/agent-summary-{aid}.json
 *
 * Gate: cost-tracking (lib/os/config/gates.json)
 * Exit: 0 always (PostToolUse is warn-only)
 *
 * PERF: require() and gate check hoisted to module scope (paid once per process).
 *       Per-call path is fs reads/writes only. Target: <100ms per invocation.
 */
'use strict';

// --- Module-scope requires (P0 #3: hoisted for performance) ---
const fs = require('fs');
const path = require('path');
const { readStdinJson, deriveSessionNumber } = require('./hook-utils.cjs');
// [D3] Plugin-managed OS resolution + collision guard.
const { isProjectManaged, resolveOsRoot } = require('./os-guard.cjs');

// --- Utility functions (exported for testing via require) ---

function safeNum(val) {
  return typeof val === 'number' && Number.isFinite(val) && val >= 0 ? val : -1;
}

function sanitizeAgentId(aid) {
  return (aid || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
}

function classifyCaller(input) {
  if (!input.agent_id) {
    return { type: 'main', id: 'main', name: 'lead' };
  }
  if (input.agent_type === 'in_process_teammate') {
    return { type: 'teammate', id: input.agent_id, name: input.agent_id };
  }
  return { type: 'subagent', id: input.agent_id, name: input.agent_type || 'unknown' };
}

function estimateTokens(toolName, toolInput, toolResponse) {
  if (toolName === 'Read') {
    if (typeof toolResponse === 'string') {
      if (toolResponse.includes('This exact Read was already made earlier')) {
        return { est_tokens: 0, cache_hit: true };
      }
      return { est_tokens: Math.ceil(toolResponse.length / 4), cache_hit: false };
    }
    return { est_tokens: 500, cache_hit: false };
  }
  if (toolName === 'Edit') {
    const oldLen = ((toolInput && toolInput.old_string) || '').length;
    const newLen = ((toolInput && toolInput.new_string) || '').length;
    return { est_tokens: Math.ceil((oldLen + newLen) / 4), cache_hit: false };
  }
  if (toolName === 'Write') {
    return { est_tokens: Math.ceil(((toolInput && toolInput.content) || '').length / 4), cache_hit: false };
  }
  if (toolName === 'Bash') {
    const cmdLen = ((toolInput && toolInput.command) || '').length;
    const resLen = typeof toolResponse === 'string' ? Math.min(toolResponse.length, 50000) : 0;
    return { est_tokens: Math.ceil((cmdLen + resLen) / 4), cache_hit: false };
  }
  if (toolName === 'Grep' || toolName === 'Glob') {
    return { est_tokens: 500, cache_hit: false };
  }
  if (toolName === 'Agent') {
    return { est_tokens: 15000, cache_hit: false };
  }
  return { est_tokens: 200, cache_hit: false };
}

function detectWrongTool(command) {
  if (!command) return null;
  const segments = command.split(/\s*[|;&]+\s*/);
  const WRONG_TOOLS = /^(cat|grep|head|tail|sed|awk|echo)$/;
  for (const seg of segments) {
    const firstToken = seg.trim().split(/\s+/)[0];
    if (WRONG_TOOLS.test(firstToken)) return firstToken;
  }
  return null;
}

// Export utilities for unit testing (must be before gate check which may return early)
if (typeof module !== 'undefined') {
  module.exports = { classifyCaller, safeNum, sanitizeAgentId, estimateTokens, detectWrongTool };
}

// --- Module-scope gate check (evaluated once per process) ---
// Precedence guard: when the project wires its own os-accounting, the
// project-managed hook is authoritative — exit to avoid double-counted
// ledger entries (collision design).
const _osRoot = isProjectManaged(process.cwd(), 'os-accounting') ? null : resolveOsRoot(process.cwd());
let costEnabled = false;
try {
  if (_osRoot) {
    const _osLib = path.join(_osRoot.root, 'lib', 'os');
    const { createFeatureGates } = require(path.join(_osLib, 'kernel', 'feature-gates.cjs'));
    const gates = createFeatureGates(path.join(_osLib, 'config', 'gates.json'));
    costEnabled = gates.isEnabled('cost-tracking');
  }
} catch { /* gates unavailable — disabled */ }

if (!costEnabled) {
  // Drain stdin before exiting to prevent pipe-hold zombie processes on Windows
  process.stdin.resume();
  process.stdin.on('end', () => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
  return;
}

// --- JSONL rotation ---
const { appendJsonl } = require(require('path').join(_osRoot.root, 'lib', 'os', 'jsonl-rotate.cjs'));
// Upstream fix carried over: LEDGER_OPTS was referenced at the appendJsonl call
// sites below but never defined -> every ledger append threw ReferenceError
// (swallowed by best-effort try/catch), so resource-ledger.jsonl silently stopped
// recording tool events. Restored with jsonl-rotate's defaults (10k entries / 5 MB / 3 rotated).
const LEDGER_OPTS = { maxEntries: 10000, maxBytes: 5 * 1024 * 1024, maxRotated: 3 };

// --- Main hook logic ---

async function main() {
  const input = await readStdinJson();

  const toolName = input.tool_name || '';
  const toolInput = input.tool_input || {};
  const toolResponse = input.tool_response;
  const durationMs = safeNum(input.duration_ms);
  const caller = classifyCaller(input);
  const aid = sanitizeAgentId(caller.id);
  const sid = input.session_id || '';

  const stateDir = path.join(process.cwd(), '_runs', 'os');
  const ledgerPath = path.join(stateDir, 'resource-ledger.jsonl');
  const heartbeatDir = path.join(stateDir, 'heartbeats');
  const agentStatePath = path.join(stateDir, `agent-state-${aid}.json`);

  try { fs.mkdirSync(heartbeatDir, { recursive: true }); } catch { /* exists */ }

  // --- Tier 1: Heuristic accounting ---
  const isSuccess = input.isError !== true && input.success !== false &&
    !(typeof toolResponse === 'string' && /^(Error:|TypeError:|ReferenceError:|SyntaxError:|AssertionError:)/m.test(toolResponse));
  const isFileOp = ['Read', 'Edit', 'Write'].includes(toolName);
  const tokenEst = estimateTokens(toolName, toolInput, toolResponse);
  const leaks = [];

  // --- Leak detection ---
  let agentState = { reads: {}, recent_searches: [], failed_count: 0 };
  try {
    agentState = JSON.parse(fs.readFileSync(agentStatePath, 'utf8'));
  } catch { /* first call or missing */ }

  // (P0 #5) Cap agentState.reads to prevent unbounded growth + re-serialization cost
  if (agentState.reads && Object.keys(agentState.reads).length > 200) {
    agentState.reads = {};
  }

  // redundant_read
  if (toolName === 'Read' && toolInput.file_path) {
    const fp = toolInput.file_path;
    agentState.reads[fp] = (agentState.reads[fp] || 0) + 1;
    if (agentState.reads[fp] >= 2) {
      leaks.push({ pattern: 'redundant_read', detail: `${fp} read ${agentState.reads[fp]}x` });
    }
  }

  // failed_tool (P1 #9: threshold >= 3 to reduce noise)
  if (!isSuccess) {
    agentState.failed_count = (agentState.failed_count || 0) + 1;
    if (agentState.failed_count >= 3) {
      const snippet = typeof toolResponse === 'string' ? toolResponse.slice(0, 100) : '';
      leaks.push({ pattern: 'failed_tool', detail: `${toolName}: ${snippet}` });
    }
  } else {
    agentState.failed_count = 0;
  }

  // scatter_search
  if (toolName === 'Grep' || toolName === 'Glob') {
    const searchDir = (toolInput.path || toolInput.directory || '.').toString();
    const now = Date.now();
    agentState.recent_searches = (agentState.recent_searches || []).filter(
      s => now - new Date(s.ts).getTime() < 30000
    );
    agentState.recent_searches.push({ pattern: toolInput.pattern || '', tool: toolName, ts: new Date().toISOString(), dir: searchDir });
    const sameDirSearches = agentState.recent_searches.filter(s => s.dir === searchDir);
    if (sameDirSearches.length >= 3) {
      leaks.push({ pattern: 'scatter_search', detail: `${sameDirSearches.length} searches in ${searchDir} within 30s` });
    }
  }

  // wrong_tool
  if (toolName === 'Bash') {
    const wrongCmd = detectWrongTool(toolInput.command || '');
    if (wrongCmd) {
      leaks.push({ pattern: 'wrong_tool', detail: `Used Bash(${wrongCmd}) instead of dedicated tool` });
    }
  }

  // oversized_result
  if (typeof toolResponse === 'string' && toolResponse.length > 50000) {
    leaks.push({ pattern: 'oversized_result', detail: `${toolResponse.length} chars` });
  }

  // Write agent state
  try { fs.writeFileSync(agentStatePath, JSON.stringify(agentState)); } catch { /* best-effort */ }

  // --- Write tool event to ledger ---
  const toolEvent = {
    ts: new Date().toISOString(), sid, aid: caller.id, caller: caller.type, name: caller.name,
    event: 'tool', tool: toolName, success: isSuccess, file_op: isFileOp,
    est_tokens: tokenEst.est_tokens, leaks: leaks.map(l => l.pattern),
  };
  if (tokenEst.cache_hit) toolEvent.cache_hit = true;
  if (durationMs >= 0) toolEvent.duration_ms = durationMs;

  try { appendJsonl(ledgerPath, toolEvent, LEDGER_OPTS); } catch { /* best-effort */ }

  // Write standalone leak events
  for (const leak of leaks) {
    try {
      appendJsonl(ledgerPath, {
        ts: toolEvent.ts, sid, aid: caller.id, caller: caller.type, name: caller.name,
        event: 'leak', tool: toolName, pattern: leak.pattern, detail: leak.detail,
      }, LEDGER_OPTS);
    } catch { /* best-effort */ }
  }

  // --- Tier 2: Agent tool extraction ---
  if (toolName === 'Agent' && toolResponse && typeof toolResponse === 'object' && toolResponse.status === 'completed') {
    const agentSummary = {
      ts: new Date().toISOString(), sid, aid: caller.id, caller: caller.type, name: caller.name,
      event: 'agent_summary',
      totalTokens: safeNum(toolResponse.totalTokens),
      totalToolUseCount: safeNum(toolResponse.totalToolUseCount),
      totalDurationMs: safeNum(toolResponse.totalDurationMs),
      model: (toolInput && toolInput.model) || 'unknown',
      usage: {
        input_tokens: safeNum(toolResponse.usage && toolResponse.usage.input_tokens),
        output_tokens: safeNum(toolResponse.usage && toolResponse.usage.output_tokens),
        cache_creation_input_tokens: safeNum(toolResponse.usage && toolResponse.usage.cache_creation_input_tokens),
        cache_read_input_tokens: safeNum(toolResponse.usage && toolResponse.usage.cache_read_input_tokens),
        server_tool_use: (toolResponse.usage && toolResponse.usage.server_tool_use) || null,
        service_tier: (toolResponse.usage && toolResponse.usage.service_tier) || null,
      },
    };

    try { appendJsonl(ledgerPath, agentSummary, LEDGER_OPTS); } catch { /* best-effort */ }

    // Write per-agent summary file for O(1) lookup by os-agent-cleanup
    const agentId = sanitizeAgentId(toolResponse.agentId || caller.id);
    const summaryPath = path.join(stateDir, `agent-summary-${agentId}.json`);
    try { fs.writeFileSync(summaryPath, JSON.stringify(agentSummary)); } catch { /* best-effort */ }
  }

  // --- Heartbeat update ---
  const heartbeatPath = path.join(heartbeatDir, `${aid}.json`);
  let hbData = { caller: caller.type, name: caller.name, last_seen: '', tool_count: 0, leak_count: 0 };
  try { hbData = JSON.parse(fs.readFileSync(heartbeatPath, 'utf8')); } catch { /* first write */ }
  hbData.last_seen = new Date().toISOString();
  hbData.tool_count = (hbData.tool_count || 0) + 1;
  hbData.leak_count = (hbData.leak_count || 0) + leaks.length;
  try { fs.writeFileSync(heartbeatPath, JSON.stringify(hbData)); } catch { /* best-effort */ }

  // --- Session-level heartbeat for session-reaper.cjs ---
  try {
    const sessionRegPath = path.join(stateDir, 'session-processes.json');
    if (fs.existsSync(sessionRegPath)) {
      const reg = JSON.parse(fs.readFileSync(sessionRegPath, 'utf8'));
      reg.last_heartbeat = new Date().toISOString();
      fs.writeFileSync(sessionRegPath, JSON.stringify(reg, null, 2));
    }
  } catch { /* best-effort */ }

  // --- ZOM-PRV-002 T9: Bridge heartbeat to kernel process-registry JSONL ---
  try {
    const processTablePath = path.join(stateDir, 'kernel', 'process-table.jsonl');
    if (fs.existsSync(processTablePath)) {
      const heartbeatEvent = JSON.stringify({
        event: 'heartbeat',
        osPid: process.pid,
        ts: new Date().toISOString(),
        sid,
        aid,
        callerType: caller.type,
        tool: toolName,
      });
      fs.appendFileSync(processTablePath, heartbeatEvent + '\n');
    }
  } catch { /* best-effort — never block PostToolUse */ }

  // --- HUD context writer (T19) ---
  try {
    const ctxPath = path.join(stateDir, 'hud-context.json');
    const cwd = input.cwd || process.cwd();
    let workflow = null, phase = '', progress = '', label = 'idle';

    if (fs.existsSync(path.join(cwd, '.forge-session.json'))) {
      try {
        const forge = JSON.parse(fs.readFileSync(path.join(cwd, '.forge-session.json'), 'utf8'));
        workflow = 'forge';
        phase = forge.phase || '';
        const done = (forge.completed_tasks || []).length;
        const total = (forge.current_phase_tasks || []).length + done + (forge.blocked_tasks || []).length;
        progress = total ? `${done}/${total}` : '';
        label = `forge:${phase}`;
      } catch { workflow = 'forge'; label = 'forge'; }
    } else if (fs.existsSync(path.join(cwd, '.maintain-session.json'))) {
      workflow = 'maintain'; label = 'maintain';
    } else if (fs.existsSync(path.join(cwd, '.dfe-session.json'))) {
      workflow = 'dfe'; label = 'dfe';
    }

    if (workflow && caller.type === 'main') {
      fs.writeFileSync(ctxPath, JSON.stringify({
        workflow, phase, progress, label,
        updated_at: new Date().toISOString()
      }));
    }
  } catch { /* non-fatal */ }

  // --- HUD live data layer: running counters + gated cheap health refresh ---
  try {
    const metaPath = path.join(stateDir, 'session-meta.json');
    if (fs.existsSync(metaPath)) {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));

      // Self-heal session_number from _runs/HANDOFF-S*.md every refresh.
      // Source-of-truth = shipped work products. Survives stale meta from
      // boots that ran before the derive-from-handoffs migration.
      try {
        const derived = deriveSessionNumber(process.cwd());
        if (derived > 0) meta.session_number = derived;
      } catch { /* keep existing session_number */ }

      // Running counter updates (O(1) per hook invocation)
      const estDelta = Number.isFinite(tokenEst.est_tokens) ? tokenEst.est_tokens : 0;
      meta.est_tokens_running_total = (meta.est_tokens_running_total || 0) + estDelta;
      meta.tool_count_running = (meta.tool_count_running || 0) + 1;
      if (durationMs >= 0) meta.total_tool_ms = (meta.total_tool_ms || 0) + durationMs;
      const ctxWindow = meta.context_window || (/opus/i.test(meta.model || '') ? 1000000 : 200000);
      meta.est_context_pct = Math.min(100, Math.round(
        (meta.est_tokens_running_total / ctxWindow) * 100
      ));

      // Adaptive cooldown based on current health
      let cooldown = 60_000; // default: all healthy (single pass)
      let anyDegraded = false;
      try {
        const healthPath = path.join(stateDir, 'health.json');
        if (fs.existsSync(healthPath)) {
          const health = JSON.parse(fs.readFileSync(healthPath, 'utf8'));
          // Flat map -- iterate values directly, no .capabilities key
          for (const v of Object.values(health)) {
            if (v && v.ok === false) { anyDegraded = true; break; }
          }
        }
      } catch { /* treat as degraded */ anyDegraded = true; }

      if (anyDegraded) cooldown = 30_000;
      else if ((meta.consecutive_healthy || 0) >= 5) cooldown = 120_000;

      const now = Date.now();
      const lastRefresh = meta.last_refresh_ms || 0;
      if (now - lastRefresh >= cooldown) {
        // Mark last_refresh_ms BEFORE async detach so next hook
        // invocation does not also schedule a refresh.
        meta.last_refresh_ms = now;
        require('node:timers').setImmediate(() => {
          try {
            const { refreshCheap } = require(path.join(_osRoot.root, 'lib', 'os', 'health-refresh.cjs'));
            const capDir = path.join(_osRoot.root, 'lib', 'os', 'capabilities');
            const newHealth = refreshCheap(capDir, stateDir);
            const stillDegraded = Object.values(newHealth).some(v => v && v.ok === false);
            try {
              const freshMeta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
              freshMeta.consecutive_healthy = stillDegraded ? 0 : (freshMeta.consecutive_healthy || 0) + 1;
              const tmp = metaPath + '.' + process.pid + '.refresh.tmp';
              fs.writeFileSync(tmp, JSON.stringify(freshMeta, null, 2), 'utf8');
              fs.renameSync(tmp, metaPath);
            } catch { /* best-effort - next hook invocation will overwrite */ }
          } catch { /* best-effort */ }
        });
      }

      // Atomic write session-meta.json
      const metaTmp = `${metaPath}.${process.pid}.tmp`;
      fs.writeFileSync(metaTmp, JSON.stringify(meta, null, 2), 'utf8');
      fs.renameSync(metaTmp, metaPath);
    }
  } catch { /* non-fatal */ }

  process.exit(0);
}

main().catch(() => process.exit(0));

