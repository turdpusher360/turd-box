'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { scan } = require('../lib/wizard-scan.cjs');
const { mergeConfig } = require('../lib/wizard-config.cjs');
const { renderQuickReport, setColorEnabled } = require('../lib/wizard-output.cjs');

const USAGE = `Usage: node wizard-cli.cjs [--quick] [--json] [--no-color] [project-root]

Flags:
  --quick      Score-only report (scan + triage, no fixes)
  --json       Output raw scan result as JSON
  --no-color   Disable ANSI color output

Exit codes:
  0  All categories PASS (>= 80%)
  1  Any category WARN (50-79%)
  2  Any category FAIL (< 50%)`;

function main() {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter(a => a.startsWith('--')));
  const positional = args.filter(a => !a.startsWith('--'));

  if (flags.has('--help') || flags.has('-h')) {
    process.stdout.write(USAGE + '\n');
    process.exit(0);
  }

  // Color control: disable if --no-color, --json, or NO_COLOR env var
  if (flags.has('--no-color') || flags.has('--json') || process.env.NO_COLOR) {
    setColorEnabled(false);
  }

  const projectRoot = positional[0] || process.cwd();

  // Load threshold defaults from the skill references directory
  const pluginRoot = path.resolve(__dirname, '..');
  const tdPath = path.join(pluginRoot, 'skills', 'wizard-engine', 'references', 'threshold-defaults.json');
  const td = require(tdPath);

  // Load plugin defaults (documented category weighting + security floors).
  // Without this the deterministic path scored every category at the fallback
  // weight 1.0 and never applied the documented "security weighs 1.5x" claim.
  let pluginDefaults = {};
  const defaultsPath = path.join(pluginRoot, 'defaults', 'wizard-defaults.json');
  try {
    pluginDefaults = JSON.parse(fs.readFileSync(defaultsPath, 'utf-8'));
  } catch (err) {
    process.stderr.write(`wizard-cli: could not load plugin defaults (${err.message})\n`);
  }

  // Load project config (optional). Distinguish "no config" (ENOENT, use
  // defaults silently) from "broken config" (syntax error, warn — do not drop
  // the user's config silently per config-schema.md).
  let projectConfig = {};
  const projectConfigPath = path.join(projectRoot, '.4ge-wizard.json');
  try {
    projectConfig = JSON.parse(fs.readFileSync(projectConfigPath, 'utf-8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      process.stderr.write(
        `wizard-cli: failed to parse ${projectConfigPath} (${err.message}); using defaults only\n`,
      );
    }
    // ENOENT → no project config, defaults only (no warning)
  }

  // Route through the full config merge: plugin defaults -> project config ->
  // (mode frontmatter, none at CLI). mergeConfig applies enforceSecurityFloors
  // internally, so documented weights and non-bypassable floors are now live in
  // the deterministic entrypoint.
  const config = mergeConfig(pluginDefaults, projectConfig, null);

  const result = scan(projectRoot, config, td);

  if (flags.has('--json')) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    process.stdout.write(renderQuickReport(result) + '\n');
  }

  // Exit code based on worst category status
  const worstScore = Math.min(
    ...Object.values(result.categories)
      .filter(c => !c.skipped)
      .map(c => c.raw),
  );
  const worstPct = (worstScore / 20) * 100;

  if (worstPct < 50) process.exit(2);
  if (worstPct < 80) process.exit(1);
  process.exit(0);
}

main();
