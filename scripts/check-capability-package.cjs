#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  PACKAGE_DIR,
  PACKAGE_NAME,
  buildPackage,
} = require('./package-capability-catalog.cjs');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function collect() {
  const expected = buildPackage();
  const errors = [];
  const packageJsonPath = path.join(PACKAGE_DIR, 'package.json');
  const indexPath = path.join(PACKAGE_DIR, 'index.js');

  if (!fs.existsSync(packageJsonPath) || !fs.existsSync(indexPath)) {
    return [`${PACKAGE_NAME}: generated package output is missing; run npm run package:capability-catalog`];
  }

  const metadata = readJson(packageJsonPath);
  if (metadata.name !== PACKAGE_NAME) {
    errors.push(`${PACKAGE_NAME}: package name is ${metadata.name ?? '<missing>'}`);
  }
  if (metadata.version !== expected.version) {
    errors.push(`${PACKAGE_NAME}: package version is not stable across source and output`);
  }

  delete require.cache[require.resolve(indexPath)];
  const actual = require(indexPath);
  if (JSON.stringify(actual.catalog) !== JSON.stringify(expected.catalog)) {
    errors.push(`${PACKAGE_NAME}: catalog.json is stale or differs from the kernel registry`);
  }
  if (JSON.stringify(actual.manifests) !== JSON.stringify(expected.manifests)) {
    errors.push(`${PACKAGE_NAME}: manifests.json is stale or differs from the kernel manifests`);
  }
  if (typeof actual.version !== 'string' || actual.version !== expected.version) {
    errors.push(`${PACKAGE_NAME}: index.js does not expose its package version`);
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
    `Capability package OK (${PACKAGE_NAME}@${buildPackage().version}, generated from kernel composition).`,
  );
}

module.exports = { collect };
