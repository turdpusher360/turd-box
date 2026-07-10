'use strict';

/**
 * context-plane-liveness.cjs — F4 context-plane change gate (upstream).
 *
 * FILENAME NOTE: this is the "context-plane change gate" concept from the F4 design,
 * but the FILE is named `-liveness` (not `-gate`) deliberately. It is a boot+CI
 * liveness verifier — the sibling of check-wiring-liveness.cjs and heartbeat-registry.cjs
 * — not a PreToolUse hook guard. The enforcement-reachability census
 * (.claude/hooks/__tests__/) nets lib basenames containing "gate/guard/enforce" as a
 * proxy for PreToolUse enforcement hooks; this module is covered by its own dedicated
 * tests (context-plane-liveness.test.js + check-wiring-liveness.test.js), the same
 * coverage regime as its host check-wiring-liveness.cjs, so the `-liveness` name keeps
 * it in the correct test regime and out of a heuristic net meant for hook guards.
 *
 * Fixes root cause #2 of _runs/s546/RETROSPECTIVE-6-9-to-now.md (dev-memory 3ef6d253,
 * OPEN): there is no dependency-gate or owner for "context-plane changes" — repo-state
 * changes that alter what FUTURE sessions automatically read, or how the harness
 * automatically behaves — so value-corrections land 12/12 while mechanism-class fixes
 * land 0/9. Trigger incident: 8ddfd893 (upstream prune) archived TASKING.md's 41 project
 * drive-path refs — the only auto-read carrier of project<->path knowledge — and nothing
 * flagged it (1,040 -> 100 lines).
 *
 * This module is the pure, dependency-injected, fail-open verification core. It is
 * wired into scripts/check-wiring-liveness.cjs (upstream W3) via thin adapters — boot
 * (advisory, folded into the OS boot line) and CI (hard-fail via ci.yml:125). It is
 * a SIBLING of heartbeat-registry.cjs, not an extension of it (different inputs:
 * settings.json, economy-config levers, rules files, and a committed consumer
 * manifest; different failure vocabulary). heartbeat-registry.validateRegistry() gets
 * wired through the same new adapters, finally giving P6 ("a protection without a
 * liveness check does not exist") teeth.
 *
 * TOOTH (be precise — the design overstated this and review F1 corrected it):
 * a CI hard-fail exits 1 which REDS the CI job; it does NOT "block the push". Actual
 * merge-gating requires a GitHub branch-protection required-status-check (an operator
 * follow-up on the account-surface boundary). 8ddfd893 was a DIRECT commit to main, so
 * absent branch protection the CI tooth is post-push VISIBLE (a red X + a surfaced boot
 * fault in the mandated startup brief), not a hard block. That is still a real step up
 * over the 0/9 baseline, which had ZERO automated surfacing.
 *
 * Five check classes:
 *   H  hook classification  — wired-set (settings.json) vs manifest-classified-set,
 *                             bidirectional; a new wired hook with no entry, or a stale
 *                             entry for an unwired hook, both fault. (C1)
 *   E  env-key consumption  — every settings.json env key is `harness`-classified or
 *                             has a `process.env.<KEY>` reader in the corpus. (C3b)
 *   L  lever consumption    — every economy lever (TIER_DEFAULTS key) claiming `live`
 *                             has >=1 corpus consumer, else must be `declared-unbuilt`.
 *                             Reproduces the upstream zero-consumer economy-lever
 *                             finding at seed. (C3a)
 *   S  fact sentinels       — a declared load-bearing plain-string fact must live in
 *                             >=1 of its declared auto-read carrier surfaces. The
 *                             8ddfd893 class (a specific known fact removed). (C2)
 *   V  content-volume ratchet — a declared auto-read surface may grow freely, but a
 *                             DROP of more than CONTENT_VOLUME_DROP_THRESHOLD below its
 *                             committed baseline is a fault unless the same commit
 *                             lowers the baseline. This would have caught 8ddfd893
 *                             REGARDLESS of which fact was in the deleted lines — the
 *                             bulk-amputation guard the per-fact sentinels cannot be.
 *                             Sentinels (specific-fact) and the ratchet (bulk-volume)
 *                             are COMPLEMENTARY, not redundant. (C2, review F2 upgrade)
 *
 * Fail-open throughout: every function tolerates missing/garbage inputs and returns a
 * degraded/empty result rather than throwing. No console.log — stderr/return only. The
 * CI vs boot fail posture asymmetry (missing manifest = CI hard-fail, boot fail-open)
 * lives in the check-wiring-liveness adapter, not here.
 */

const fs = require('node:fs');
const path = require('node:path');

// The gate's own source files never count as a "consumer" of a lever they merely
// name in a check string — otherwise the gate self-satisfies (review R6, test 6).
const GATE_SELF_FILES = new Set([
  'lib/os/services/context-plane-liveness.cjs',
  'scripts/check-wiring-liveness.cjs',
  'scripts/seed-context-plane-manifest.cjs',
]);

// Content-volume ratchet threshold. A declared auto-read surface may grow without
// limit, but a drop of more than this fraction below its committed baseline line
// count is a fault unless the same commit lowers the baseline (the visible ratchet
// bump IS the "name your consumers" moment for content volume). 0.40 tolerates
// ordinary edit churn while catching bulk amputation — the 8ddfd893 incident was
// TASKING.md 1,040 -> 100 lines (a ~90% drop), an order of magnitude past this floor.
const CONTENT_VOLUME_DROP_THRESHOLD = 0.4;

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function emptyManifest() {
  return { version: undefined, hooks: {}, env: {}, levers: {}, factSentinels: [], autoReadSurfaces: [] };
}

function defaultManifestPath(repoRoot) {
  return path.join(repoRoot || process.cwd(), 'lib', 'os', 'config', 'context-plane-manifest.json');
}

/**
 * Load + shape-normalise the manifest. Fail-open: a missing file, unparseable JSON, or
 * a wrong-shaped section all degrade to an empty section rather than throwing.
 * @returns {{version:*,hooks:object,env:object,levers:object,factSentinels:Array,autoReadSurfaces:Array}}
 */
function loadManifest(manifestPath) {
  try {
    const raw = fs.readFileSync(manifestPath || defaultManifestPath(), 'utf8');
    const p = JSON.parse(raw);
    if (!p || typeof p !== 'object') return emptyManifest();
    return {
      version: p.version,
      hooks: p.hooks && typeof p.hooks === 'object' ? p.hooks : {},
      env: p.env && typeof p.env === 'object' ? p.env : {},
      levers: p.levers && typeof p.levers === 'object' ? p.levers : {},
      factSentinels: Array.isArray(p.factSentinels) ? p.factSentinels : [],
      autoReadSurfaces: Array.isArray(p.autoReadSurfaces) ? p.autoReadSurfaces : [],
    };
  } catch {
    return emptyManifest();
  }
}

/**
 * Extract wired-hook records from a settings object. Same .cjs extraction as
 * check-wiring-liveness measureMissingHookPaths (:199), keyed by basename (the manifest
 * key). ${CLAUDE_PROJECT_DIR} tokens are stripped; non-command / non-.cjs entries skipped.
 * @returns {Array<{event:string, basename:string, rel:string}>}
 */
function enumerateWiredHooks(settingsObj) {
  const out = [];
  const hooks = settingsObj && settingsObj.hooks;
  if (!hooks || typeof hooks !== 'object') return out;
  for (const event of Object.keys(hooks)) {
    const matchers = hooks[event];
    if (!Array.isArray(matchers)) continue;
    for (const matcher of matchers) {
      const list = matcher && matcher.hooks;
      if (!Array.isArray(list)) continue;
      for (const h of list) {
        if (!h || h.type !== 'command' || !h.command) continue;
        const cmd = String(h.command)
          .replace(/\$\{CLAUDE_PROJECT_DIR\}/g, '')
          .replace(/\$CLAUDE_PROJECT_DIR/g, '');
        const m = cmd.match(/([\w./${}-]*\.cjs)\b/);
        if (!m) continue;
        out.push({ event, basename: path.basename(m[1]), rel: m[1] });
      }
    }
  }
  return out;
}

/**
 * Check H — hook classification (C1). Bidirectional diff of the live wired set against
 * the manifest-classified set. `inert`-status entries pass but are counted.
 * @returns {{unclassified:string[], stale:string[], inertCount:number, total:number, wiredCount:number}}
 */
function checkHookClassification({ settingsObj, manifest } = {}) {
  const m = manifest || emptyManifest();
  const hooks = m.hooks || {};
  const wired = new Set(enumerateWiredHooks(settingsObj).map((h) => h.basename));
  const classified = new Set(Object.keys(hooks));
  const unclassified = [...wired].filter((b) => !classified.has(b)).sort();
  const stale = [...classified].filter((b) => !wired.has(b)).sort();
  let inertCount = 0;
  for (const b of classified) {
    if (hooks[b] && hooks[b].status === 'inert') inertCount++;
  }
  return { unclassified, stale, inertCount, total: classified.size, wiredCount: wired.size };
}

/**
 * Check H (artifact half, CI only) — for any hook entry whose consumers include an
 * `artifact` type, each named reader must exist in the corpus AND its source must
 * reference the artifact basename.
 * @returns {{broken:Array<{hook:string, artifact:(string|null), reason:string}>}}
 */
function checkArtifactReaders({ manifest, corpus } = {}) {
  const m = manifest || emptyManifest();
  const broken = [];
  const byRel = new Map();
  for (const f of corpus || []) if (f && f.rel) byRel.set(f.rel, f);
  for (const [hook, entry] of Object.entries(m.hooks || {})) {
    const consumers = entry && Array.isArray(entry.consumers) ? entry.consumers : [];
    for (const c of consumers) {
      if (!c || c.type !== 'artifact') continue;
      const artifact = c.path || c.artifact || null;
      if (!artifact) { broken.push({ hook, artifact: null, reason: 'artifact consumer without a path' }); continue; }
      const base = path.basename(artifact);
      const readers = Array.isArray(c.readers) ? c.readers : [];
      if (readers.length === 0) { broken.push({ hook, artifact, reason: 'artifact consumer names no readers[]' }); continue; }
      for (const rd of readers) {
        const f = byRel.get(rd);
        if (!f) { broken.push({ hook, artifact, reason: `reader ${rd} not found in corpus` }); continue; }
        if (!String(f.src).includes(base)) broken.push({ hook, artifact, reason: `reader ${rd} does not reference ${base}` });
      }
    }
  }
  return { broken };
}

/**
 * Check E — env-key consumption (C3b). Every settings.json env key must be declared:
 * `harness`-typed passes on completeness alone; a `code`-typed key needs a
 * `process.env.<KEY>` reader in the corpus (verified in full mode only — no corpus
 * means completeness-only).
 * @returns {{undeclared:string[], unconsumed:string[], harnessCount:number, total:number}}
 */
function checkEnvKeys({ settingsObj, manifest, corpus } = {}) {
  const m = manifest || emptyManifest();
  const envObj = settingsObj && settingsObj.env && typeof settingsObj.env === 'object' ? settingsObj.env : {};
  const keys = Object.keys(envObj);
  const undeclared = [];
  const unconsumed = [];
  let harnessCount = 0;
  for (const K of keys) {
    const entry = m.env[K];
    if (!entry) { undeclared.push(K); continue; }
    const consumers = Array.isArray(entry.consumers) ? entry.consumers : [];
    if (consumers.some((c) => c && c.type === 'harness')) { harnessCount++; continue; }
    if (corpus && corpus.length) {
      const re = new RegExp('process\\.env\\.' + escapeRegExp(K) + '\\b');
      const found = corpus.some((f) => f && !f.isTest && re.test(f.src));
      if (!found) unconsumed.push(K);
    }
  }
  return { undeclared: undeclared.sort(), unconsumed: unconsumed.sort(), harnessCount, total: keys.length };
}

/**
 * Check L — lever consumption (C3a). Reproduces the upstream finding: economy levers
 * declared in TIER_DEFAULTS but never wired. A lever is verified only in full mode
 * (needs the corpus):
 *   - status `declared-unbuilt`/`inert`  -> counted, never flagged (allowlist path)
 *   - a named-consumer hatch (consumers:[{type:'harness'|'code'}]) -> passes without a
 *     grep. This is the M3 escape hatch for a lever read via a getter INSIDE its
 *     definer (e.g. subagent_model via getSubagentModel()), where the \bname\b grep,
 *     with the definer excluded, would false-flag it zero-consumer.
 *   - otherwise: a corpus file (not the definer, not a test, not a gate-self file)
 *     containing `\b<lever>\b`. Grep-found readability, not proof of reading — the same
 *     epistemic stance as check-wiring-liveness Check 7.
 * `tierDefaults` (injected TIER_DEFAULTS.standard) drives undeclared detection;
 * tierDefaults=null skips it (fail-open on economy-config unavailability).
 * @returns {{undeclared:string[], zeroConsumer:string[], unbuiltCount:number, total:number}}
 */
function checkLeverConsumers({ manifest, tierDefaults, corpus } = {}) {
  const m = manifest || emptyManifest();
  const declared = Object.keys(m.levers || {});
  const undeclared = [];
  if (tierDefaults && typeof tierDefaults === 'object') {
    for (const k of Object.keys(tierDefaults)) if (!m.levers[k]) undeclared.push(k);
  }
  const zeroConsumer = [];
  let unbuiltCount = 0;
  const files = (corpus || []).filter((f) => f && !f.isTest);
  for (const L of declared) {
    const entry = m.levers[L] || {};
    if (entry.status === 'declared-unbuilt' || entry.status === 'inert') { unbuiltCount++; continue; }
    const consumers = Array.isArray(entry.consumers) ? entry.consumers : [];
    if (consumers.some((c) => c && (c.type === 'harness' || c.type === 'code'))) continue;
    if (!corpus) continue; // completeness-only (boot): no corpus, cannot grep
    const definer = entry.declaredIn;
    const re = new RegExp('\\b' + escapeRegExp(L) + '\\b');
    const hit = files.some((f) => f.rel !== definer && !GATE_SELF_FILES.has(f.rel) && re.test(f.src));
    if (!hit) zeroConsumer.push(L);
  }
  return { undeclared: undeclared.sort(), zeroConsumer: zeroConsumer.sort(), unbuiltCount, total: declared.length };
}

function fileIncludes(p, pattern, fileCache) {
  if (fileCache && fileCache.has(p)) {
    const v = fileCache.get(p);
    return v === null || v === undefined ? false : String(v).includes(pattern);
  }
  try { return fs.readFileSync(p, 'utf8').includes(pattern); } catch { return false; }
}

/**
 * Check S — fact sentinels (C2). Each declared load-bearing plain-string fact must live
 * (String.includes, no regex) in >=1 of its declared carrier surfaces. Any-of semantics:
 * rotating a fact between declared carriers passes silently; moving it to a NEW home
 * requires adding that surface to the manifest in the same commit. All surfaces missing
 * on disk -> fired (fail-open read, still detects).
 * @returns {{fired:Array<{id:string, why:string}>, liveCount:number, total:number}}
 */
function checkFactSentinels({ manifest, repoRoot, fileCache } = {}) {
  const m = manifest || emptyManifest();
  const root = repoRoot || process.cwd();
  const sentinels = Array.isArray(m.factSentinels) ? m.factSentinels : [];
  const fired = [];
  let liveCount = 0;
  for (const s of sentinels) {
    if (!s || typeof s.pattern !== 'string' || !Array.isArray(s.surfaces)) continue;
    const live = s.surfaces.some((rel) => fileIncludes(path.join(root, rel), s.pattern, fileCache));
    if (live) liveCount++;
    else fired.push({ id: s.id, why: s.why });
  }
  return { fired, liveCount, total: sentinels.length };
}

function countLines(src) {
  const m = String(src).match(/\n/g);
  return m ? m.length : 0;
}

/**
 * Check V — content-volume ratchet (C2 bulk-amputation guard, review F2 upgrade). Each
 * declared auto-read surface's current line count must be at or above its ratchet floor
 * (baseline * (1 - CONTENT_VOLUME_DROP_THRESHOLD)). Growth is free; a drop past the
 * floor is a fault unless the same commit lowers baselineLines. A declared surface
 * missing on disk is reported separately (adapter decides hard vs soft by mode).
 * @returns {{shrunk:Array<{path,baseline,current,floor}>, missing:string[], okCount:number, total:number}}
 */
function checkContentVolume({ manifest, repoRoot, fileCache } = {}) {
  const m = manifest || emptyManifest();
  const root = repoRoot || process.cwd();
  const surfaces = Array.isArray(m.autoReadSurfaces) ? m.autoReadSurfaces : [];
  const shrunk = [];
  const missing = [];
  let okCount = 0;
  for (const s of surfaces) {
    if (!s || typeof s.path !== 'string' || typeof s.baselineLines !== 'number') continue;
    const abs = path.join(root, s.path);
    let src;
    if (fileCache && fileCache.has(abs)) src = fileCache.get(abs);
    else { try { src = fs.readFileSync(abs, 'utf8'); } catch { missing.push(s.path); continue; } }
    if (src === null || src === undefined) { missing.push(s.path); continue; }
    const current = countLines(src);
    const floor = Math.floor(s.baselineLines * (1 - CONTENT_VOLUME_DROP_THRESHOLD));
    if (current < floor) shrunk.push({ path: s.path, baseline: s.baselineLines, current, floor });
    else okCount++;
  }
  return { shrunk, missing, okCount, total: surfaces.length };
}

/**
 * Build a one-shot {absPath: content|null} cache of the files the checks in this mode
 * will read, so a single runGate touches each surface at most once. Fresh per call —
 * never module-global, so unit tests that write-then-read a fixture path see current
 * content. `includeSurfaces:false` (boot) omits the ~20 auto-read content surfaces:
 * reading them all is the ~67ms-on-drvfs cost the content-volume check carries, which
 * is why content-volume runs in FULL mode only (the boot subset stays sentinel-cheap).
 */
function buildFileCache({ manifest, repoRoot, includeSurfaces = true } = {}) {
  const m = manifest || emptyManifest();
  const root = repoRoot || process.cwd();
  const cache = new Map();
  const want = new Set();
  for (const s of Array.isArray(m.factSentinels) ? m.factSentinels : []) {
    if (s && Array.isArray(s.surfaces)) for (const rel of s.surfaces) want.add(path.join(root, rel));
  }
  if (includeSurfaces) {
    for (const s of Array.isArray(m.autoReadSurfaces) ? m.autoReadSurfaces : []) {
      if (s && typeof s.path === 'string') want.add(path.join(root, s.path));
    }
  }
  for (const abs of want) {
    try { cache.set(abs, fs.readFileSync(abs, 'utf8')); } catch { cache.set(abs, null); }
  }
  return cache;
}

/**
 * Aggregate all checks for one mode. NEVER throws (fail-open). `mode:'boot'` ignores the
 * corpus even if passed (lever + artifact + env-grep checks are corpus-backed and are
 * the drvfs-expensive step the boot subset must avoid), so the boot-budget contract is
 * structural, not conventional.
 * @returns {{ok:boolean, faults:Array<{check,detail}>, counts:object, checks:Array<{check,ok,detail}>, degraded?:string}}
 */
function runGate(opts) {
  try {
    opts = opts || {};
    const { repoRoot, settingsObj, manifest, tierDefaults, corpus, mode } = opts;
    const isBoot = mode === 'boot';
    const m = manifest || emptyManifest();
    const effCorpus = isBoot ? null : corpus;
    // Boot omits the auto-read content surfaces from the read cache — the content-volume
    // check (which reads them) runs in FULL mode only, keeping boot sentinel-cheap.
    const fileCache = buildFileCache({ manifest: m, repoRoot, includeSurfaces: !isBoot });
    const checks = [];
    const degradedBits = [];
    const safe = (name, fn, fallback) => {
      try { return fn(); } catch (e) { degradedBits.push(`${name}: ${e && e.message}`); return fallback; }
    };

    const hc = safe('hooks', () => checkHookClassification({ settingsObj, manifest: m }),
      { unclassified: [], stale: [], inertCount: 0, total: 0 });
    {
      const bad = [
        ...hc.unclassified.map((h) => `wired hook '${h}' has no manifest entry — name its consumers`),
        ...hc.stale.map((h) => `manifest entry '${h}' is for an unwired hook — remove it or re-wire`),
      ];
      checks.push({ check: 'hooks', ok: bad.length === 0, detail: bad.length ? bad.join('; ') : `${hc.total} classified (${hc.inertCount} inert), 0 drift` });
    }

    const ek = safe('env', () => checkEnvKeys({ settingsObj, manifest: m, corpus: effCorpus }),
      { undeclared: [], unconsumed: [], harnessCount: 0, total: 0 });
    {
      const bad = [
        ...ek.undeclared.map((k) => `env key '${k}' undeclared — classify harness or name readers`),
        ...ek.unconsumed.map((k) => `env key '${k}' has no process.env reader in the corpus`),
      ];
      checks.push({ check: 'env', ok: bad.length === 0, detail: bad.length ? bad.join('; ') : `${ek.total} env keys (${ek.harnessCount} harness)` });
    }

    let lc = null;
    if (!isBoot) {
      lc = safe('levers', () => checkLeverConsumers({ manifest: m, tierDefaults, corpus: effCorpus }),
        { undeclared: [], zeroConsumer: [], unbuiltCount: 0, total: 0 });
      const bad = [
        ...lc.undeclared.map((l) => `lever '${l}' exists in TIER_DEFAULTS with no manifest entry`),
        ...lc.zeroConsumer.map((l) => `lever '${l}' claims live but has zero consumers — build it, or set status:'declared-unbuilt'`),
      ];
      checks.push({ check: 'levers', ok: bad.length === 0, detail: bad.length ? bad.join('; ') : `${lc.total} levers (${lc.unbuiltCount} declared-unbuilt)` });

      const ar = safe('artifacts', () => checkArtifactReaders({ manifest: m, corpus: effCorpus }), { broken: [] });
      checks.push({ check: 'artifacts', ok: ar.broken.length === 0, detail: ar.broken.length ? ar.broken.map((b) => `${b.hook}: ${b.reason}`).join('; ') : 'all artifact readers resolve' });
    }

    const sc = safe('sentinels', () => checkFactSentinels({ manifest: m, repoRoot, fileCache }),
      { fired: [], liveCount: 0, total: 0 });
    checks.push({ check: 'sentinels', ok: sc.fired.length === 0, detail: sc.fired.length ? sc.fired.map((f) => `sentinel '${f.id}' (${f.why}): no live carrier among declared surfaces`).join('; ') : `${sc.liveCount}/${sc.total} sentinels live` });

    // content-volume is FULL-only: reading all ~20 auto-read surfaces is ~67ms on drvfs,
    // over the boot budget (design R4). Its hard-fail tooth lives in CI regardless; boot
    // keeps the cheap per-fact sentinels.
    let cv = null;
    if (!isBoot) {
      cv = safe('content-volume', () => checkContentVolume({ manifest: m, repoRoot, fileCache }),
        { shrunk: [], missing: [], okCount: 0, total: 0 });
      const bad = [
        ...cv.shrunk.map((s) => `auto-read surface '${s.path}' shrank ${s.baseline} -> ${s.current} lines (below the ${s.floor} floor) — bump baselineLines in this commit if the cut is intended`),
        ...cv.missing.map((p) => `declared auto-read surface '${p}' is missing on disk — deleted? update the manifest`),
      ];
      checks.push({ check: 'content-volume', ok: bad.length === 0, detail: bad.length ? bad.join('; ') : `${cv.okCount}/${cv.total} surfaces at/above floor` });
    }

    const faults = checks.filter((c) => !c.ok).map((c) => ({ check: c.check, detail: c.detail }));
    const counts = {
      hooks: { total: hc.total, inert: hc.inertCount },
      env: { total: ek.total, harness: ek.harnessCount },
      sentinels: { live: sc.liveCount, total: sc.total },
    };
    if (lc) counts.levers = { total: lc.total, unbuilt: lc.unbuiltCount };
    if (cv) counts.surfaces = { ok: cv.okCount, total: cv.total };
    const result = { ok: faults.length === 0, faults, counts, checks };
    if (degradedBits.length) result.degraded = degradedBits.join(' | ');
    return result;
  } catch (e) {
    // Ultimate fail-open: a bug in the gate must never fault the host liveness run.
    return { ok: true, faults: [], counts: {}, checks: [], degraded: `runGate: ${e && e.message}` };
  }
}

/**
 * One-line summary for the boot brief / CI report. Never throws.
 * e.g. "89 hooks (1 inert), 6 levers (4 declared-unbuilt), 11 env, 7/7 sentinels, 33 surfaces — 0 drift"
 */
function formatGateLine(result) {
  if (!result || typeof result !== 'object') return 'context-plane: no data';
  const c = result.counts || {};
  const bits = [];
  if (c.hooks) bits.push(`${c.hooks.total} hooks (${c.hooks.inert} inert)`);
  if (c.levers) bits.push(`${c.levers.total} levers (${c.levers.unbuilt} declared-unbuilt)`);
  if (c.env) bits.push(`${c.env.total} env`);
  if (c.sentinels) bits.push(`${c.sentinels.live}/${c.sentinels.total} sentinels`);
  if (c.surfaces) bits.push(`${c.surfaces.ok}/${c.surfaces.total} surfaces`);
  const head = bits.join(', ');
  const drift = result.faults && result.faults.length ? `${result.faults.length} drift` : '0 drift';
  const deg = result.degraded ? ` [degraded: ${result.degraded}]` : '';
  return `${head ? head + ' — ' : ''}${drift}${deg}`;
}

module.exports = {
  GATE_SELF_FILES,
  CONTENT_VOLUME_DROP_THRESHOLD,
  escapeRegExp,
  defaultManifestPath,
  loadManifest,
  enumerateWiredHooks,
  checkHookClassification,
  checkArtifactReaders,
  checkEnvKeys,
  checkLeverConsumers,
  checkFactSentinels,
  checkContentVolume,
  buildFileCache,
  runGate,
  formatGateLine,
};
