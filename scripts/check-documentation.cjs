#!/usr/bin/env node
'use strict';

// Documentation gate. It checks what a reader would trip over: broken links and
// frontmatter (OKF), file naming, session-only phrases in current-state docs,
// stale generated maps, and a missing changelog section. It also rejects
// edition branches in source. Capability, composition, and ledger gates run as
// their own steps in `npm run check`, so they are not repeated here.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { validateBundle } = require('./check-okf-bundle.cjs');

const ROOT = path.resolve(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');

const CANONICAL_NAME = /^(?:[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9-]+)*)\.md$/;
const RESERVED_NAMES = new Set(['index.md', 'log.md']);
// Dated plans, specs, and reports may reference sessions and history; the
// phrase check applies to current-state docs only.
const STALE_CLAIM_SKIP_DIRECTORIES = new Set(['superpowers']);
// Phrases that only make sense inside a planning session. Ordinary technical
// words stay allowed so architecture docs can name what the code contains.
const PROHIBITED_DOCUMENTATION_PATTERNS = [
  /remediation trunk/i,
  /old plan/i,
  /as discussed/i,
  /we decided/i,
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
    if (path.extname(file).toLowerCase() !== '.md') continue;
    const name = path.basename(file);
    if (RESERVED_NAMES.has(name)) continue;
    if (!CANONICAL_NAME.test(name)) {
      errors.push(
        `${relative(file)}: documentation filenames must be lower-kebab-case`,
      );
    }
  }
  return errors;
}

function staleClaimErrors() {
  const errors = [];
  const files = [
    ...filesUnder(DOCS).filter(
      (file) =>
        file.endsWith('.md') &&
        !STALE_CLAIM_SKIP_DIRECTORIES.has(relative(file).split('/')[1]),
    ),
    path.join(ROOT, 'README.md'),
  ];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const pattern of PROHIBITED_DOCUMENTATION_PATTERNS) {
      if (pattern.test(text)) {
        errors.push(
          `${relative(file)}: contains session-specific text matching ${pattern}`,
        );
      }
    }
  }
  return errors;
}

function sourceBranchErrors() {
  const errors = [];
  // Comparing an edition to a literal is a product branch. Comparing two
  // edition values to each other is validation, such as rejecting a client
  // policy written for a different edition, and stays allowed.
  const patterns = [
    /\bedition\s*(===|!==)\s*['"`]/,
    /['"`](saas|edu|enterprise)['"`]\s*(===|!==)/,
  ];
  for (const file of filesUnder(path.join(ROOT, 'src')).filter((item) =>
    item.endsWith('.ts'),
  )) {
    const text = fs.readFileSync(file, 'utf8');
    if (patterns.some((pattern) => pattern.test(text))) {
      errors.push(
        `${relative(file)}: edition branches are not allowed; use composition data`,
      );
    }
  }
  return errors;
}

function changelogErrors() {
  const file = path.join(ROOT, 'CHANGELOG.md');
  if (!fs.existsSync(file))
    return ['CHANGELOG.md: repository changelog is required'];
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
  console.log(
    'Documentation checks passed: OKF links and frontmatter, naming, phrases, and generated maps.',
  );
}

if (require.main === module) main();

module.exports = {
  CANONICAL_NAME,
  namingErrors,
  staleClaimErrors,
  sourceBranchErrors,
};
