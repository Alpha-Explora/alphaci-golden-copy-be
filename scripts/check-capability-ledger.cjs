#!/usr/bin/env node
'use strict';

const {
  compositionHash,
  compositionState,
  readLedger,
  validateLedger,
} = require('./lib/capability-ledger.cjs');

const state = compositionState();
const hash = compositionHash(state);
const knownKeys = new Set(state.capabilities.map((record) => record.key));

let ledger = null;
let errors = [];
try {
  ledger = readLedger();
  errors = validateLedger(ledger, hash, knownKeys);
} catch (error) {
  errors = [error instanceof Error ? error.message : String(error)];
}

if (errors.length > 0) {
  console.error('Capability ledger check failed: ' + errors.length + ' error(s).');
  for (const error of errors) console.error('  ' + error);
  process.exit(1);
}

const count = ledger.entries.length;
console.log(
  'Capability ledger OK (' +
    count +
    (count === 1 ? ' entry' : ' entries') +
    ', catalog hash ' +
    hash +
    ').',
);
