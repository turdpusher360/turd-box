import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const pluginRoot = path.resolve(import.meta.dirname, '..');
const repoRoot = path.resolve(pluginRoot, '../..');

function readPluginFile(relativePath) {
  return fs.readFileSync(path.join(pluginRoot, relativePath), 'utf8');
}

function readManifest() {
  return JSON.parse(readPluginFile('.claude-plugin/plugin.json'));
}

describe('4ge command contracts', () => {
  it('documents /recall as the canonical guided Knowledge hub (self-contained; /recon retired)', () => {
    const manifest = readManifest();
    const readme = readPluginFile('README.md');
    const recallCommand = readPluginFile('commands/recall.md');

    // /recall owns the canonical memory-search implementation directly
    expect(recallCommand).toContain('mcp__dev-memory__memory_search');
    expect(recallCommand).toContain('Default Mode (bare query)');
    expect(recallCommand).toContain('Guided Knowledge Hub');
    expect(recallCommand).toContain('AskUserQuestion');

    // /recon was a pure redirect stub retired from the public surface — must not
    // resurface in the manifest or as a command file
    expect(manifest.commands.recon).toBeUndefined();
    expect(fs.existsSync(path.join(pluginRoot, 'commands/recon.md'))).toBe(false);

    // manifest: /recall is a Knowledge hub linked to dev-memory
    expect(manifest.commands.recall.description).toContain('Knowledge hub');
    expect(manifest.commands.recall.description).toContain('dev-memory');

    // README: hub framing in the command table; /recall now runs search directly (no forward)
    expect(readme).toContain('| `/recall` | Free | Guided Knowledge hub');
    expect(readme).toContain('`/recall` runs dev-memory search directly');
  });

  it('keeps the four retired redirect stubs (/commit /map /recon /resp4wn) out of the plugin surface', () => {
    // Redirect-stub retirement is the canonical MAJOR-bump justification for
    // 3.0.0 (docs/plugin-versioning.md §2/§5.6). This contract guards the
    // retirement against the stubs creeping back into the manifest, README,
    // or commands/ directory. Their non-stub targets (/ship, /recall,
    // /respawn) are asserted elsewhere and must remain untouched.
    const manifest = readManifest();
    const readme = readPluginFile('README.md');
    const retired = ['commit', 'map', 'recon', 'resp4wn'];

    for (const name of retired) {
      expect(manifest.commands[name]).toBeUndefined();
      expect(fs.existsSync(path.join(pluginRoot, `commands/${name}.md`))).toBe(false);
      expect(readme).not.toMatch(new RegExp('\\`/' + name + '\\`'));
    }

    expect(manifest.commands.ship).toBeDefined();
    expect(manifest.commands.recall).toBeDefined();
    expect(manifest.commands.respawn).toBeDefined();
  });

  it('keeps /public-portfolio out of the public plugin surface (privacy scrub, S399)', () => {
    const manifest = readManifest();
    const readme = readPluginFile('README.md');

    // 762fc80f (S399 privacy scrub): /public-portfolio is internal control-plane
    // tooling, removed from the published plugin entirely — command, skill,
    // manifest entry, and README. This contract guards the scrub against the
    // surface creeping back into the public product.
    expect(manifest.commands['public-portfolio']).toBeUndefined();
    expect(readme).not.toContain('public-portfolio');
    expect(fs.existsSync(path.join(pluginRoot, 'commands/public-portfolio.md'))).toBe(false);
    expect(fs.existsSync(path.join(pluginRoot, 'skills/public-portfolio'))).toBe(false);
  });

  it('routes /4ge run/resume/park to the installed 4ge forge skill namespace', () => {
    const command = readPluginFile('commands/4ge.md');

    expect(command).toContain('Invoke the `4ge:forge` skill with `"run <task>"`');
    expect(command).toContain('Invoke the `4ge:forge` skill with `"resume"`');
    expect(command).toContain('Invoke the `4ge:forge` skill with `"park"`');
    expect(command).toContain('For `run`/`resume`/`park`: invoke the `4ge:forge` skill directly.');
    expect(command).not.toContain('`forge:forge`');
  });

  it('routes /debug through 4ge debug-investigate before any Superpowers fallback', () => {
    const command = readPluginFile('commands/debug.md');

    expect(command).toContain('INVOKE debug-investigate');
    expect(command).toContain('internal sub-protocol/fallback');
    expect(command).not.toMatch(/INVOKE\s+superpowers:systematic-debugging/);
  });

  it('keeps DFE synthesis disk-first with the tools the DFE agent actually has', () => {
    const command = readPluginFile('commands/dfe.md');
    const skill = readPluginFile('skills/dfe-review/SKILL.md');

    expect(command).toContain('the `DFE` agent does not have the Write tool');
    expect(command).toContain('via Bash heredoc');
    expect(command).toContain('before any optional reflection, consultation, advisor/server-side tool use, or inline summary');
    expect(command).toContain('not to perform nested fan-out');
    expect(command).not.toContain('using Write tool\n8. Instruction to return executive summary inline');

    expect(skill).toContain('You do not have the Write tool. Write the report via Bash heredoc');
    expect(skill).toContain('Do not call advisor/server-side consultation before the disk report exists.');
    expect(skill).toContain('Do not perform nested fan-out; the 5 minion reports are already complete.');
  });

  it('keeps DFE minion report writes compatible with approved minion tools', () => {
    const command = readPluginFile('commands/dfe.md');
    const skill = readPluginFile('skills/dfe-review/SKILL.md');

    expect(command).toContain('Write findings to `_runs/review/dfe-{pass}-$DATE.md` via Bash heredoc');
    expect(command).toContain('Minions are source-read-only scanners. They may use Bash only');
    expect(command).not.toContain('Minions are source-read-only scanners. They may use Write only');

    expect(skill).toContain('Write findings to _runs/review/dfe-existence-$DATE.md via Bash heredoc');
    expect(skill).toContain('Minions are source-read-only scanners. They may use Bash only');
    expect(skill).not.toContain('Write findings to _runs/review/dfe-existence-$DATE.md using the Write tool');
  });

  it('keeps /dfe diagnostics mode packaged, fail-loud, and indexed', () => {
    const manifest = readManifest();
    const command = readPluginFile('commands/dfe.md');
    const skill = readPluginFile('skills/dfe-review/SKILL.md');

    expect(manifest.commands.dfe.argumentHint).toContain('--diagnostics');
    expect(fs.existsSync(path.join(pluginRoot, 'lib/dfe/diff-scoper.cjs'))).toBe(true);
    expect(fs.existsSync(path.join(pluginRoot, 'lib/dfe/diagnostics-profile.cjs'))).toBe(true);
    expect(fs.existsSync(path.join(pluginRoot, 'lib/dfe/diagnostics-index.cjs'))).toBe(true);
    expect(readPluginFile('lib/dfe/diff-scoper.cjs')).toBe(
      fs.readFileSync(path.join(repoRoot, 'lib/dfe/diff-scoper.cjs'), 'utf8'),
    );
    expect(readPluginFile('lib/dfe/diagnostics-profile.cjs')).toBe(
      fs.readFileSync(path.join(repoRoot, 'lib/dfe/diagnostics-profile.cjs'), 'utf8'),
    );
    expect(readPluginFile('lib/dfe/diagnostics-index.cjs')).toBe(
      fs.readFileSync(path.join(repoRoot, 'lib/dfe/diagnostics-index.cjs'), 'utf8'),
    );

    for (const source of [command, skill]) {
      expect(source).toContain('${CLAUDE_PLUGIN_ROOT}/lib/dfe/diff-scoper.cjs');
      expect(source).toContain('test -f "${CLAUDE_PLUGIN_ROOT}/lib/dfe/diagnostics-profile.cjs"');
      expect(source).toContain('[dfe] --diagnostics requires lib/dfe/diagnostics-profile.cjs');
      expect(source).toContain('node "${CLAUDE_PLUGIN_ROOT}/lib/dfe/diagnostics-index.cjs" _runs/review');
      expect(source).toContain('_runs/review/dfe-existence-$DATE.md');
      expect(source).toContain('_runs/review/dfe-adversarial-$DATE.md');
      expect(source).toContain('_runs/review/index.json');
      expect(source).not.toContain('node lib/dfe/');
      expect(source).not.toContain('test -f lib/dfe/');
    }
  });

  it('keeps /signoff rig context advisory-only before cartridge enrichment', () => {
    const command = readPluginFile('commands/signoff.md');

    expect(command).toContain('## Step 0: Rig Health Advisory');
    expect(command).toContain('lib/os/kernel/rig-advisory.cjs');
    expect(command).toContain('_runs/os/rig-context.json');
    expect(command).toContain('Advisory only');
    expect(command).toContain('Do not abort, block, stage, commit, mutate runtime state, or change signing behavior because of rig warnings.');
    expect(command).toContain('include relevant rig warnings in `momentum.blockers`');

    const step0 = command.indexOf('## Step 0: Rig Health Advisory');
    const step1 = command.indexOf('## Step 1: Read Current State');
    expect(step0).toBeGreaterThanOrEqual(0);
    expect(step1).toBeGreaterThan(step0);
  });

  it('keeps /signoff cartridge writes parse-checked and atomic', () => {
    const command = readPluginFile('commands/signoff.md');

    expect(command).toContain('JSON.parse(raw)');
    expect(command).toContain('[signoff] invalid existing cartridge JSON');
    expect(command).toContain('tmp="_runs/session-cartridge.json.$$.$RANDOM.tmp"');
    expect(command).toContain('JSON.parse(require(\'fs\').readFileSync(process.argv[1], \'utf8\'))');
    expect(command).toContain('mv "$tmp" _runs/session-cartridge.json');
    expect(command).toContain('leave the prior `_runs/session-cartridge.json` untouched');
    expect(command).not.toContain('cat > _runs/session-cartridge.json <<');
  });

  it('keeps /signoff from preserving stale prior-session cartridge fields', () => {
    const command = readPluginFile('commands/signoff.md');

    expect(command).toContain('If `session_id` exists and does not match the current session ID');
    expect(command).toContain('Always rebuild session-scoped fields from current live state');
    expect(command).toContain('Never preserve prior-session `git`, `modified_files`, `decisions`, or `tasks`');
    expect(command).not.toContain('preserve all fields from it and overwrite only `momentum`, `enriched`, and `enriched_at`');
  });
});
