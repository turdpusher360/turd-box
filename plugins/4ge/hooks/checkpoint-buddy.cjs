'use strict';

if (require.main === module) {
  (async () => {
    const { readStdinJson } = require('./hook-utils.cjs');
    const path = require('path');
    const fs = require('fs');
    const { execFile } = require('child_process');
    const { promisify } = require('util');
    const execFileAsync = promisify(execFile);

    // Resolve plugin lib/ via CLAUDE_PLUGIN_ROOT so requires survive PLUGIN_DATA migration
    const _pluginRoot = process.env.CLAUDE_PLUGIN_DATA || process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..');
    const pluginLib = (rel) => path.join(_pluginRoot, rel);

    const data = await readStdinJson();
    const { extractWins, formatSessionSummary, saveWin } = require(pluginLib('lib/checkpoint-buddy.cjs'));

    const cwd = data.cwd || process.cwd();

    try {
      const { stdout: diffStat } = await execFileAsync('git', ['diff', '--stat', 'HEAD~1'], { cwd, encoding: 'utf8', timeout: 2000, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
      const lastLine = diffStat.trim().split('\n').pop() || '';
      const wins = extractWins(lastLine);

      if (wins.files_changed > 0) {
        // Fix: agents_used was hardcoded [] (silent-dead in every win row).
        // Backfill from this session's slice of the spawn log so the attribution records.
        let agentsUsed = [];
        try {
          const sid = data.session_id || 'unknown';
          const spawnsPath = path.join(cwd, '_runs', 'subagent-spawns.jsonl');
          if (fs.existsSync(spawnsPath)) {
            const seen = new Set();
            for (const line of fs.readFileSync(spawnsPath, 'utf8').split('\n')) {
              if (!line) continue;
              let r; try { r = JSON.parse(line); } catch { continue; }
              if (r.session === sid && r.agent) seen.add(r.agent);
            }
            agentsUsed = [...seen];
          }
        } catch { /* best effort — never block the win write */ }
        const entry = {
          session_id: data.session_id || 'unknown',
          ...wins,
          agents_used: agentsUsed,
        };
        saveWin(cwd, entry);

        // Increment trust score on successful session (files committed)
        try {
          const { TrustScore } = require(pluginLib('lib/trust-score.cjs'));
          const dataDir = process.env.CLAUDE_PLUGIN_DATA || path.join(_pluginRoot, '.data');
          const trustPath = path.join(dataDir, 'forge', 'trust-score.json');
          const ts = TrustScore.load(trustPath);
          const prevLevel = ts.getLevel();
          ts.recordSuccess();
          ts.save(trustPath);
          if (ts.getLevel() !== prevLevel) {
            process.stdout.write(`[checkpoint-buddy] Trust level up: ${prevLevel} -> ${ts.getLevel()} (score: ${ts.getScore()})\n`);
          }
        } catch { /* trust score is best-effort */ }

        const summary = formatSessionSummary(entry);
        process.stdout.write(`[checkpoint-buddy] ${summary}\n`);
      }
    } catch { /* best effort */ }

    process.exit(0);
  })();
}
