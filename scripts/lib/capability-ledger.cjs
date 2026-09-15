'use strict';

/**
 * Capability ledger: the history the generated matrix cannot carry.
 *
 * The matrix answers "what does the catalog contain today". The ledger answers
 * "when did that change, who changed it, and under which decision". It is
 * hand-written, because a ledger derived from commit history can record what
 * changed but never why.
 *
 * The gate is a hash rather than a diff against a merge base: the last entry
 * carries the composition hash it describes, so any edit to the registry or
 * the manifests without a new entry fails, with no dependency on Git state.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { loadCapabilityCatalog } = require('../load-capability-catalog.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const LEDGER_PATH = path.join(ROOT, 'docs', 'capabilities', 'ledger.json');
const LEDGER_DOC = 'docs/capabilities/capability-ledger.generated.md';

const CHANGE_TYPES = [
  'baseline',
  'added',
  'removed',
  'renamed',
  'maturity-changed',
  'membership-changed',
];

/** Change types whose keys may no longer exist in the registry. */
const RETIRING_CHANGES = new Set(['removed', 'renamed']);

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

/**
 * The catalog facts a ledger entry is accountable for.
 *
 * Descriptions and wording are deliberately excluded: a typo fix should not
 * demand a ledger entry, while a key, maturity, dependency, configuration
 * flag, or edition membership change should.
 */
function compositionState() {
  const { capabilities, manifests } = loadCapabilityCatalog();
  const editions = Object.keys(manifests).sort();

  return {
    capabilities: capabilities.map((record) => ({
      key: record.key,
      maturity: record.maturity,
      requires: [...record.requires],
      configurationFlags: [...record.configurationFlags],
      editions: editions.filter((edition) =>
        manifests[edition].capabilities.includes(record.key),
      ),
    })),
  };
}

function compositionHash(state) {
  const canonical = JSON.stringify(state.capabilities);
  return 'sha256:' + crypto.createHash('sha256').update(canonical).digest('hex');
}

function readLedger(file = LEDGER_PATH) {
  if (!fs.existsSync(file)) {
    throw new Error('docs/capabilities/ledger.json is missing');
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeLedger(ledger, file = LEDGER_PATH) {
  fs.writeFileSync(file, JSON.stringify(ledger, null, 2) + '\n');
}

/**
 * Validate the ledger against the catalog it claims to describe.
 *
 * Only the newest entry is checked against the current hash. Earlier hashes
 * are historical statements and are kept as written.
 */
function validateLedger(ledger, currentHash, knownKeys) {
  const errors = [];
  if (ledger === null || typeof ledger !== 'object' || Array.isArray(ledger)) {
    return ['ledger.json must contain an object with an entries array'];
  }

  const entries = ledger.entries;
  if (!Array.isArray(entries) || entries.length === 0) {
    return ['ledger.json must contain at least one entry'];
  }

  entries.forEach((entry, index) => {
    const at = 'entry ' + index;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(at + ': must be an object');
      return;
    }
    if (typeof entry.date !== 'string' || !DATE_PATTERN.test(entry.date)) {
      errors.push(at + ': date must be YYYY-MM-DD');
    }
    if (!CHANGE_TYPES.includes(entry.change)) {
      errors.push(
        at + ': change must be one of ' + CHANGE_TYPES.join(', '),
      );
    }
    if (typeof entry.summary !== 'string' || entry.summary.trim() === '') {
      errors.push(at + ': summary is required');
    }
    if (typeof entry.reference !== 'string' || entry.reference.trim() === '') {
      errors.push(at + ': reference is required');
    }
    if (typeof entry.compositionHash !== 'string' || !HASH_PATTERN.test(entry.compositionHash)) {
      errors.push(at + ': compositionHash must be sha256:<64 hex>');
    }
    if (!Array.isArray(entry.keys)) {
      errors.push(at + ': keys must be an array');
      return;
    }
    if (entry.change !== 'baseline' && entry.keys.length === 0) {
      errors.push(at + ': a non-baseline entry must name at least one key');
    }
    if (RETIRING_CHANGES.has(entry.change)) return;
    for (const key of entry.keys) {
      if (!knownKeys.has(key)) {
        errors.push(at + ": names unknown capability '" + key + "'");
      }
    }
  });

  for (let index = 1; index < entries.length; index += 1) {
    const previous = entries[index - 1];
    const current = entries[index];
    if (typeof previous.date === 'string' && typeof current.date === 'string') {
      if (current.date < previous.date) {
        errors.push('entry ' + index + ': dates must not move backwards');
      }
    }
    if (current.change === 'baseline') {
      errors.push('entry ' + index + ': only the first entry may be a baseline');
    }
  }

  if (entries[0].change !== 'baseline') {
    errors.push('entry 0: the first entry must be a baseline');
  }

  const newest = entries[entries.length - 1];
  if (newest.compositionHash !== currentHash) {
    errors.push(
      'the capability catalog changed without a ledger entry. Current hash ' +
        currentHash +
        ', newest entry ' +
        String(newest.compositionHash) +
        '. Run npm run ledger:record to append the change.',
    );
  }

  return errors;
}

function renderLedger(ledger, state, currentHash) {
  const rows = [...ledger.entries]
    .reverse()
    .map(
      (entry) =>
        '| ' +
        [
          entry.date,
          entry.change,
          entry.keys.length > 0
            ? entry.keys.map((key) => '`' + key + '`').join(', ')
            : 'catalog',
          entry.summary,
          entry.reference,
        ].join(' | ') +
        ' |',
    );

  return [
    '---',
    'type: "Capability Map"',
    'title: "Capability ledger"',
    'description: "Generated history of capability lifecycle changes recorded against the application capability catalog."',
    'tags: [capabilities, map, packs]',
    'status: stable',
    'sources:',
    '  - id: "capability-ledger"',
    '    resource: "docs/capabilities/ledger.json"',
    '    title: "Capability ledger entries"',
    '  - id: "capability-registry"',
    '    resource: "src/kernel/composition/capability-registry.ts"',
    '    title: "Application capability registry"',
    '  - id: "ledger-gate"',
    '    resource: "scripts/check-capability-ledger.cjs"',
    '    title: "Capability ledger gate"',
    '---',
    '',
    '# Capability ledger',
    '',
    'This ledger records how the capability catalog reached its current shape. ' +
      'The [capability matrix](capability-matrix.generated.md) describes the catalog as it stands; ' +
      'this file describes what changed, when, and under which record.',
    '',
    'Entries are newest first. A ledger entry is required whenever a capability key, ' +
      'maturity, dependency edge, configuration flag, or edition membership changes. ' +
      'Wording and description edits do not require one.',
    '',
    '| Date | Change | Keys | Summary | Reference |',
    '|---|---|---|---|---|',
    ...rows,
    '',
    '## Current catalog',
    '',
    '- Capabilities: **' + state.capabilities.length + '**',
    '- Composition hash: `' + currentHash + '`',
    '',
    'The hash covers every capability key, maturity, dependency edge, configuration flag, ' +
      'and edition membership in registry order. ' +
      '`npm run check:capability-ledger` recomputes it and rejects a catalog that moved ' +
      'without a ledger entry. `npm run ledger:record` appends an entry with the correct hash.',
    '',
  ].join('\n');
}

module.exports = {
  CHANGE_TYPES,
  LEDGER_DOC,
  LEDGER_PATH,
  compositionHash,
  compositionState,
  readLedger,
  renderLedger,
  validateLedger,
  writeLedger,
};
