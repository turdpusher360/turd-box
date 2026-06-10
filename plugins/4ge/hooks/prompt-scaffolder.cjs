'use strict';

if (require.main === module) {
  (async () => {
    try {
      const { readStdinJson } = require('./hook-utils.cjs');
      const data = await readStdinJson();

      const prompt = (data.tool_input && data.tool_input.prompt) || data.user_prompt || '';
      if (!prompt || prompt.startsWith('/')) process.exit(0);

      const path = require('path');
      const fs = require('fs');

      // Auto-title: save first non-slash prompt as session title
      try {
        const metaPath = path.join(process.cwd(), '_runs', 'os', 'session-meta.json');
        if (fs.existsSync(metaPath)) {
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
          if (!meta.session_title) {
            const title = prompt.replace(/\s+/g, ' ').trim().slice(0, 60);
            meta.session_title = title;
            fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
            // Also update session-history in _runs/os/ (co-located with session-meta.json)
            const histPath = path.join(process.cwd(), '_runs', 'os', 'session-history.json');
            if (fs.existsSync(histPath)) {
              const hist = JSON.parse(fs.readFileSync(histPath, 'utf8'));
              const entry = (hist.sessions || []).find(s => s.number === meta.session_number);
              if (entry) { entry.title = title; fs.writeFileSync(histPath, JSON.stringify(hist, null, 2)); }
            }
          }
        }
      } catch { /* non-fatal */ }

      const _pluginRoot = process.env.CLAUDE_PLUGIN_DATA || process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..');
      const { suggestImprovements } = require(path.join(_pluginRoot, 'lib', 'prompt-scorer.cjs'));
      const result = suggestImprovements(prompt);

      if (result.suggestions.length > 0) {
        process.stdout.write([
          `[prompt-scaffolder] Score: ${result.score}/10`,
          ...result.suggestions.map(s => `  - ${s}`),
        ].join('\n') + '\n');
      }
    } catch {
      // Hooks never crash — prompt-scorer load failure or any runtime error exits cleanly
    }

    process.exit(0);
  })();
}
