#!/usr/bin/env node
'use strict';

const { compact } = require('../lib/context-phoenix.cjs');
const path = require('path');

const projectRoot = process.argv[2]
  ? path.resolve(process.argv[2])
  : process.cwd();

try {
  const result = compact({ projectRoot });
  process.stdout.write('Context Phoenix complete.\n');
  process.stdout.write(`Output: ${result.outputPath}\n`);
  process.stdout.write(`Words compacted: ${result.wordCount}\n`);
} catch (err) {
  process.stderr.write(`Context Phoenix failed: ${err.message}\n`);
  process.exit(1);
}
