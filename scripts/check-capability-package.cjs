#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  CANONICAL_PACKAGE_FILES,
  PACKAGE_DIR,
  PACKAGE_NAME,
  buildPackage,
} = require('./package-capability-catalog.cjs');
const {
  PROVENANCE_FILE,
  artifactDigestFromDirectory,
  provenanceShapeErrors,
} = require('./lib/capability-package-provenance.cjs');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function collect(packageDirectory = PACKAGE_DIR) {
  const expected = buildPackage();
  const errors = [];
  const packageJsonPath = path.join(packageDirectory, 'package.json');
  const indexPath = path.join(packageDirectory, 'index.js');
  const declarationPath = path.join(packageDirectory, 'index.d.ts');
  const provenancePath = path.join(packageDirectory, PROVENANCE_FILE);

  const requiredFiles = [...CANONICAL_PACKAGE_FILES, PROVENANCE_FILE];
  const missingFiles = requiredFiles.filter(
    (file) => !fs.existsSync(path.join(packageDirectory, file)),
  );
  if (missingFiles.length > 0) {
    return [
      `${PACKAGE_NAME}: generated package output is missing (${missingFiles.join(', ')}); run npm run package:capability-catalog`,
    ];
  }

  const metadata = readJson(packageJsonPath);
  const provenance = readJson(provenancePath);
  if (metadata.name !== PACKAGE_NAME) {
    errors.push(`${PACKAGE_NAME}: package name is ${metadata.name ?? '<missing>'}`);
  }
  if (metadata.version !== expected.version) {
    errors.push(`${PACKAGE_NAME}: package version is not stable across source and output`);
  }

  delete require.cache[require.resolve(indexPath)];
  const actual = require(indexPath);
  if (JSON.stringify(actual.catalog) !== JSON.stringify(expected.catalog)) {
    errors.push(`${PACKAGE_NAME}: catalog.json is stale or differs from catalog.source.json`);
  }
  if (JSON.stringify(actual.manifests) !== JSON.stringify(expected.manifests)) {
    errors.push(`${PACKAGE_NAME}: manifests.json is stale or differs from catalog.source.json`);
  }
  if (fs.readFileSync(declarationPath, 'utf8') !== expected.indexDts) {
    errors.push(`${PACKAGE_NAME}: index.d.ts is stale or does not describe the published catalog`);
  }
  if (typeof actual.version !== 'string' || actual.version !== expected.version) {
    errors.push(`${PACKAGE_NAME}: index.js does not expose its package version`);
  }

  errors.push(...provenanceShapeErrors(provenance, expected.version));
  if (JSON.stringify(provenance) !== JSON.stringify(expected.provenance)) {
    errors.push(`${PACKAGE_NAME}: provenance.json is stale or tampered`);
  }
  try {
    const actualArtifactDigest = artifactDigestFromDirectory(packageDirectory);
    if (actualArtifactDigest !== provenance.artifactDigest) {
      errors.push(`${PACKAGE_NAME}: canonical package artifact digest does not match provenance.json`);
    }
  } catch (error) {
    errors.push(`${PACKAGE_NAME}: could not recompute canonical package artifact digest: ${error.message}`);
  }

  return errors;
}

const errors = collect();
if (errors.length > 0) {
  console.error(`Capability package check failed: ${errors.length} problem(s).`);
  errors.forEach((error) => console.error(`  ${error}`));
  process.exitCode = 1;
} else {
  console.log(
    `Capability package OK (${PACKAGE_NAME}@${buildPackage().version}, provenance and canonical artifact verified).`,
  );
}

module.exports = { collect };
