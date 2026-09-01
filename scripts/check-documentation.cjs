#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { validateBundle } = require('./check-okf-bundle.cjs');

const ROOT = path.resolve(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const REQUIRED_FILES = [
  'docs/index.md',
  'docs/log.md',
  'docs/constitution.md',
  'docs/executive/index.md',
  'docs/executive/golden-copy-executive-report.md',
  'docs/architecture/index.md',
  'docs/architecture/current-architecture.md',
  'docs/architecture/context-map.generated.md',
  'docs/architecture/context-contracts.md',
  'docs/architecture/events-map.generated.md',
  'docs/architecture/provider-map.generated.md',
  'docs/architecture/route-map.generated.md',
  'docs/architecture/schema-ownership.generated.md',
  'docs/architecture/architecture-checks.generated.md',
  'docs/architecture/decisions/index.md',
  'docs/architecture/decisions/adr-0001-six-context-modular-monolith.md',
  'docs/architecture/decisions/adr-0002-orthogonal-product-axes.md',
  'docs/architecture/decisions/adr-0003-composition-packs-and-entitlements.md',
  'docs/architecture/decisions/adr-0004-provider-and-port-boundaries.md',
  'docs/architecture/decisions/adr-0005-postgresql-outbox-delivery.md',
  'docs/capabilities/index.md',
  'docs/capabilities/capability-contract.md',
  'docs/capabilities/capability-matrix.generated.md',
  'docs/capabilities/registry.ts',
  'docs/packs/index.md',
  'docs/packs/pack-contract.md',
  'docs/packs/pack-template.md',
  'docs/packs/saas/index.md',
  'docs/packs/saas/pack.md',
  'docs/packs/edu/index.md',
  'docs/packs/edu/pack.md',
  'docs/packs/enterprise/index.md',
  'docs/packs/enterprise/pack.md',
  'docs/runbooks/index.md',
  'docs/runbooks/runbook-local-verification.md',
  'docs/runbooks/runbook-outbox-relay.md',
  'docs/runbooks/runbook-database-migrations.md',
  'docs/runbooks/runbook-migration-reconciliation.md',
  'docs/runbooks/runbook-deployment-provisioning.md',
  'docs/runbooks/runbook-deployment-provisioning-live-smoke.md',
  'docs/runbooks/runbook-auth-custom-domain-cutover.md',
  'docs/runbooks/runbook-performance-smoke.md',
  'CHANGELOG.md',
];

const CANONICAL_NAME = /^(?:[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9-]+)*)\.md$/;
const RESERVED_NAMES = new Set(['index.md', 'log.md']);
const PROHIBITED_DOCUMENTATION_PATTERNS = [
  /conversation/i,
  /\bchat\b/i,
  /worktree/i,
  /remediation trunk/i,
  /old plan/i,
  /as discussed/i,
  /we decided/i,
  /future state/i,
  /future topology/i,
  /future tree/i,
  /microservice/i,
  /extract later/i,
  /module consolidation plan/i,
  /FUTURE_STATE/i,
  /MODULE_CONSOLIDATION_PLAN/i,
];

function filesUnder(directory) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(full));
    else files.push(full);
  }
  return files;
}

function relative(file) {
  return path.relative(ROOT, file).replace(/\\/g, '/');
}

function namingErrors() {
  const errors = [];
  for (const file of filesUnder(DOCS)) {
    const rel = relative(file);
    if (path.extname(file).toLowerCase() !== '.md') continue;
    const name = path.basename(file);
    if (RESERVED_NAMES.has(name)) continue;
    if (!CANONICAL_NAME.test(name)) {
      errors.push(`${rel}: canonical documentation filenames must be lower-kebab-case`);
    }
  }
  return errors;
}

function requiredFileErrors() {
  return REQUIRED_FILES.filter((file) => !fs.existsSync(path.join(ROOT, file))).map(
    (file) => `${file}: required documentation file is missing`,
  );
}

function staleClaimErrors() {
  const errors = [];
  const files = [
    ...filesUnder(DOCS).filter((file) => file.endsWith('.md')),
    path.join(ROOT, 'README.md'),
  ];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const rel = relative(file);
    const text = fs.readFileSync(file, 'utf8');
    for (const pattern of PROHIBITED_DOCUMENTATION_PATTERNS) {
      if (pattern.test(text)) {
        errors.push(`${rel}: contains plan- or conversation-specific text matching ${pattern}`);
      }
    }
  }
  return errors;
}

function sourceBranchErrors() {
  const errors = [];
  for (const file of filesUnder(path.join(ROOT, 'src')).filter((item) => item.endsWith('.ts'))) {
    const text = fs.readFileSync(file, 'utf8');
    if (/\bedition\s*(===|!==)/.test(text)) {
      errors.push(`${relative(file)}: edition branches are not allowed; use composition data`);
    }
  }
  return errors;
}

function changelogErrors() {
  const file = path.join(ROOT, 'CHANGELOG.md');
  if (!fs.existsSync(file)) return ['CHANGELOG.md: repository changelog is required'];
  const text = fs.readFileSync(file, 'utf8');
  return /^##\s+\[Unreleased\]\s*$/m.test(text)
    ? []
    : ['CHANGELOG.md: an ## [Unreleased] section is required'];
}

function generatedMapErrors() {
  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, 'generate-architecture-maps.mjs'), '--check'],
    { cwd: ROOT, encoding: 'utf8' },
  );
  if (result.status === 0) return [];
  return [
    `generated maps are stale or cannot be regenerated: ${(result.stderr || result.stdout).trim()}`,
  ];
}

function main() {
  const errors = [
    ...requiredFileErrors(),
    ...namingErrors(),
    ...staleClaimErrors(),
    ...sourceBranchErrors(),
    ...changelogErrors(),
    ...generatedMapErrors(),
    ...validateBundle(DOCS),
  ];

  if (errors.length > 0) {
    console.error(`Documentation check failed: ${errors.length} error(s).`);
    errors.forEach((error) => console.error(`  ${error}`));
    process.exitCode = 1;
    return;
  }
  console.log('Documentation checks passed: OKF v0.2, naming, policy, and generated maps.');
}

if (require.main === module) main();

module.exports = {
  CANONICAL_NAME,
  namingErrors,
  requiredFileErrors,
  staleClaimErrors,
  sourceBranchErrors,
};
