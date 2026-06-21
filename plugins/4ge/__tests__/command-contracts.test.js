import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const pluginRoot = path.resolve(import.meta.dirname, '..');

function readPluginFile(relativePath) {
  return fs.readFileSync(path.join(pluginRoot, relativePath), 'utf8');
}

function readManifest() {
  return JSON.parse(readPluginFile('.claude-plugin/plugin.json'));
}

describe('4ge command contracts', () => {
  it('documents /recall as the canonical guided Knowledge hub; /recon redirects into it', () => {
    const manifest = readManifest();
    const readme = readPluginFile('README.md');
    const recallCommand = readPluginFile('commands/recall.md');
    const reconCommand = readPluginFile('commands/recon.md');

    // /recall now owns the canonical memory-search implementation (inlined from /recon)
    expect(recallCommand).toContain('mcp__dev-memory__memory_search');
    expect(recallCommand).toContain('Default Mode (bare query)');
    expect(recallCommand).toContain('Guided Knowledge Hub');
    expect(recallCommand).toContain('AskUserQuestion');

    // /recon is now a redirect into /recall (preserved, not deleted, so old refs still resolve)
    expect(reconCommand).toContain('[REDIRECT]');
    expect(reconCommand).toContain('/recall');

    // manifest: /recall is a Knowledge hub linked to dev-memory; /recon advertises the redirect
    expect(manifest.commands.recall.description).toContain('Knowledge hub');
    expect(manifest.commands.recall.description).toContain('dev-memory');
    expect(manifest.commands.recon.description).toContain('[REDIRECT]');

    // README: hub framing in the command table; /recall now runs search directly (no forward)
    expect(readme).toContain('| `/recall` | Free | Guided Knowledge hub');
    expect(readme).toContain('`/recall` runs dev-memory search directly');
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
});
