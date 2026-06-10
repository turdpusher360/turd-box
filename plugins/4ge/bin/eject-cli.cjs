#!/usr/bin/env node
'use strict';

const { ejectComponent } = require('../lib/eject.cjs');

const type = process.argv[2];
const name = process.argv[3];

if (!type || !name) {
  process.stderr.write('Usage: node eject-cli.cjs <type> <name>\n');
  process.stderr.write('Types: hook, skill\n');
  process.exit(1);
}

const result = ejectComponent(name, type, process.cwd());
process.stdout.write(JSON.stringify(result, null, 2) + '\n');
process.exit(result.ok ? 0 : 1);
