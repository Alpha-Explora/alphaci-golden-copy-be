#!/usr/bin/env node
'use strict';

/**
 * Append a capability ledger entry for the catalog as it stands.
 *
 * The hash is computed rather than typed, because a hash a human maintains by
 * hand is a hash that drifts. Everything a reader needs and a tool cannot know
 * still has to be written: what changed, and which record decided it.
 *
 *   node scripts/record-capability-ledger.cjs \
 *     --change added --keys projects.example \
 *     --summary "Added the example capability to Enterprise." \
 *     --reference adr-0009-client-capability-policies.md
 */

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  CHANGE_TYPES,
  compositionHash,
  compositionState,
  readLedger,
  writeLedger,
} = require('./lib/capability-ledger.cjs');

const ROOT = path.resolve(__dirname, '..');

function option(name) {
  const index = process.argv.indexOf('--' + name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function fail(message) {
  console.error('Cannot record a ledger entry: ' + message);
  process.exit(1);
}

const change = option('change');
const summary = option('summary');
const reference = option('reference') ?? 'CHANGELOG.md';
const date = option('date') ?? new Date().toISOString().slice(0, 10);
const keys = (option('keys') ?? '')
  .split(',')
  .map((key) => key.trim())
  .filter((key) => key !== '');

if (!CHANGE_TYPES.includes(change) || change === 'baseline') {
  fail(
    '--change must be one of ' +
      CHANGE_TYPES.filter((type) => type !== 'baseline').join(', '),
  );
}
if (typeof summary !== 'string' || summary.trim() === '') {
  fail('--summary is required and says what changed and why');
}
if (keys.length === 0) {
  fail('--keys must name at least one capability key');
}

const state = compositionState();
const ledger = readLedger();
const entry = {
  date,
  change,
  keys,
  summary: summary.trim(),
  reference,
  compositionHash: compositionHash(state),
};

ledger.entries.push(entry);
writeLedger(ledger);

const generated = spawnSync(
  process.execPath,
  [path.join(ROOT, 'scripts', 'generate-architecture-maps.mjs')],
  { cwd: ROOT, encoding: 'utf8', stdio: 'inherit' },
);
if (generated.status !== 0) {
  fail('the generated maps could not be refreshed after the entry was written');
}

console.log('Recorded ledger entry: ' + entry.change + ' ' + entry.keys.join(', '));
