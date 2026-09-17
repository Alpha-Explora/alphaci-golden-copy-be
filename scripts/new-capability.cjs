#!/usr/bin/env node
'use strict';

/**
 * Add a capability to the catalog in one command.
 *
 * Adding a capability used to mean editing the registry, up to three
 * manifests, three pack tables, and a frontend surface list, then
 * regenerating two sets of documentation and remembering the ledger. Every
 * one of those is derivable from the record itself, so the command writes the
 * record and derives the rest.
 *
 *   npm run capability:new -- --key projects.example --description "..." \
 *     --editions enterprise --summary "Added the example capability."
 *
 * What it cannot derive is the code: an AppConfig flag named by the record
 * still has to exist, and the command says so rather than pretending.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const source = require('./lib/composition-source.cjs');

const ROOT = path.resolve(__dirname, '..');
const NOT_IMPLEMENTED_CONFIGURATION = 'Not implemented in this backend. No AppConfig flag.';
const CONTEXT_BY_PREFIX = {
  identity: 'identity-access',
  platform: 'platform-ops',
  billing: 'billing',
  runtime: 'runtime',
  projects: 'projects',
  pipelines: 'pipelines',
};
const PACK_FILES = {
  saas: 'docs/packs/saas/pack.md',
  edu: 'docs/packs/edu/pack.md',
  enterprise: 'docs/packs/enterprise/pack.md',
};
const STATUS_BY_MATURITY = {
  stable: 'available',
  limited: 'configuration-gated',
  'not-implemented': 'not-implemented',
};

function option(name, fallback) {
  const index = process.argv.indexOf('--' + name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function list(name) {
  return (option(name, '') ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

function fail(message) {
  console.error('Cannot add the capability: ' + message);
  process.exit(1);
}

function packRow(record, edition) {
  const status = record.editions.includes(edition)
    ? STATUS_BY_MATURITY[record.maturity]
    : 'not-applicable';
  let evidence = 'Not part of this pack composition.';
  if (status === 'not-implemented') {
    evidence = record.description + ' Not implemented in this backend.';
  } else if (status !== 'not-applicable') {
    evidence = record.description + ' Configuration: ' + record.configuration + '.';
  }
  return '| `' + record.key + '` | `' + status + '` | ' + evidence + ' |';
}

/** Insert the row at the capability's registry position, keeping tables comparable by row. */
function withPackRow(markdown, file, row, index) {
  const lines = markdown.split('\n');
  const heading = lines.findIndex((line) => line.trim() === '## Capability status');
  if (heading < 0) fail(file + ' has no Capability status table');
  const separator = lines.findIndex(
    (line, position) => position > heading && /^\|\s*-+/.test(line.trim()),
  );
  if (separator < 0) fail(file + ' has no Capability status table rows');

  let end = separator + 1;
  while (end < lines.length && lines[end].trim().startsWith('|')) end += 1;
  const at = Math.min(separator + 1 + index, end);
  lines.splice(at, 0, row);
  return lines.join('\n');
}

const key = option('key');
const description = option('description');
const summary = option('summary');
const reference = option('reference', 'CHANGELOG.md');
const maturity = option('maturity', 'not-implemented');
const editions = list('editions');

if (typeof key !== 'string' || !key.includes('.')) fail('--key must be context.name');
if (typeof description !== 'string' || description.trim() === '') fail('--description is required');
if (typeof summary !== 'string' || summary.trim() === '') fail('--summary is required for the ledger entry');
if (!source.MATURITIES.includes(maturity)) fail('--maturity must be one of ' + source.MATURITIES.join(', '));
if (editions.length === 0) fail('--editions must name the packs that include this capability');

const context = option('context', CONTEXT_BY_PREFIX[key.split('.')[0]]);
if (typeof context !== 'string') fail('--context could not be derived from the key');

const configuration = option(
  'configuration',
  maturity === 'not-implemented' ? NOT_IMPLEMENTED_CONFIGURATION : undefined,
);
if (typeof configuration !== 'string') fail('--configuration is required unless the capability is not-implemented');

const record = {
  key,
  context,
  description: description.trim(),
  maturity,
  configuration,
  configurationFlags: list('flags'),
  requires: list('requires'),
  editions: source.EDITIONS.filter((edition) => editions.includes(edition)),
  surface: {
    apiField: option('api-field', null) ?? null,
    viewFlag: option('view-flag', null) ?? null,
    domains: list('domains'),
    routes: list('routes'),
    featureBarrels: list('barrels'),
    artifactSymbols: list('artifact-symbols'),
  },
};

const document = source.loadSource();
if (document.capabilities.some((entry) => entry.key === key)) fail(key + ' already exists');

let insertAt = document.capabilities.length;
for (let index = document.capabilities.length - 1; index >= 0; index -= 1) {
  if (document.capabilities[index].context === context) {
    insertAt = index + 1;
    break;
  }
}
document.capabilities.splice(insertAt, 0, record);

const errors = source.validateSource(document);
if (errors.length > 0) {
  console.error('The capability was not added: ' + errors.length + ' error(s).');
  for (const error of errors) console.error('  ' + error);
  process.exit(1);
}

const packUpdates = Object.entries(PACK_FILES).map(([edition, file]) => {
  const full = path.join(ROOT, file);
  const markdown = fs.readFileSync(full, 'utf8');
  return [full, withPackRow(markdown, file, packRow(record, edition), insertAt)];
});

fs.writeFileSync(source.SOURCE_PATH, JSON.stringify(document, null, 2) + '\n');
for (const [file, contents] of packUpdates) fs.writeFileSync(file, contents, 'utf8');

const steps = [
  ['scripts/generate-composition-source.mjs'],
  [
    'scripts/record-capability-ledger.cjs',
    '--change',
    'added',
    '--keys',
    key,
    '--summary',
    summary,
    '--reference',
    reference,
  ],
];
for (const args of steps) {
  const result = spawnSync(process.execPath, [path.join(ROOT, ...args[0].split('/')), ...args.slice(1)], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: 'inherit',
  });
  if (result.status !== 0) fail('the follow-up step ' + args[0] + ' failed; the source was written and needs review');
}

console.log('Added ' + key + ' to ' + record.editions.join(', ') + '.');
if (record.configurationFlags.length > 0) {
  console.log(
    'Still to do by hand: add ' +
      record.configurationFlags.join(', ') +
      ' to AppConfig, because a configuration flag is code rather than catalog data.',
  );
}
