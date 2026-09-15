#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { loadCapabilityCatalog } = require('./load-capability-catalog.cjs');

const ROOT = path.resolve(__dirname, '..');
const PACKAGE_DIR = path.join(ROOT, 'packages', 'capability-catalog');
const PACKAGE_NAME = '@alphaci/capability-catalog';
const DEFAULT_VERSION = '0.1.0';
const EDITIONS = ['saas', 'edu', 'enterprise'];

function packageVersion() {
  const packageJson = path.join(PACKAGE_DIR, 'package.json');
  if (!fs.existsSync(packageJson)) return DEFAULT_VERSION;
  return JSON.parse(fs.readFileSync(packageJson, 'utf8')).version ?? DEFAULT_VERSION;
}

function publicCatalog(capabilities, manifests) {
  const editionsByKey = new Map(
    EDITIONS.map((edition) => [
      edition,
      new Set(manifests[edition]?.capabilities ?? []),
    ]),
  );

  return capabilities.map((capability) => ({
    key: capability.key,
    maturity: capability.maturity,
    editions: EDITIONS.filter((edition) => editionsByKey.get(edition).has(capability.key)),
    requires: [...capability.requires],
  }));
}

function publicManifests(manifests) {
  return Object.fromEntries(
    EDITIONS.map((edition) => [edition, [...(manifests[edition]?.capabilities ?? [])]]),
  );
}

function declaration(catalog) {
  const keyUnion = catalog
    .map((record) => `  | ${JSON.stringify(record.key)}`)
    .join('\n');
  return `export type Edition = "saas" | "edu" | "enterprise";
export type CapabilityMaturity = "stable" | "limited" | "not-implemented";
export type CapabilityKey =
${keyUnion};

export interface CapabilityCatalogRecord {
  readonly key: CapabilityKey;
  readonly maturity: CapabilityMaturity;
  readonly editions: readonly Edition[];
  readonly requires: readonly CapabilityKey[];
}

export type CapabilityManifest = readonly CapabilityKey[];

export interface CapabilityCatalogPackage {
  readonly version: string;
  readonly catalog: readonly CapabilityCatalogRecord[];
  readonly manifests: Readonly<Record<Edition, CapabilityManifest>>;
}

export const version: string;
export const catalog: readonly CapabilityCatalogRecord[];
export const manifests: Readonly<Record<Edition, CapabilityManifest>>;
`;
}

function buildPackage() {
  const { capabilities, manifests } = loadCapabilityCatalog();
  const catalog = publicCatalog(capabilities, manifests);
  const publicManifestMap = publicManifests(manifests);
  const version = packageVersion();

  return {
    version,
    metadata: {
      name: PACKAGE_NAME,
      version,
      description: 'Public AlphaCI capability keys, maturity, pack applicability, and dependencies.',
      main: 'index.js',
      types: 'index.d.ts',
      exports: {
        '.': {
          types: './index.d.ts',
          require: './index.js',
          default: './index.js',
        },
      },
      files: ['catalog.json', 'manifests.json', 'index.js', 'index.d.ts'],
      license: 'UNLICENSED',
    },
    catalog,
    manifests: publicManifestMap,
    indexJs: `/* eslint-disable @typescript-eslint/no-require-imports */
'use strict';

const catalog = require('./catalog.json');
const manifests = require('./manifests.json');
const { version } = require('./package.json');

module.exports = Object.freeze({
  version,
  catalog: Object.freeze(catalog),
  manifests: Object.freeze(manifests),
});
`,
    indexDts: declaration(catalog),
  };
}

function writePackage() {
  const output = buildPackage();
  fs.mkdirSync(PACKAGE_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(PACKAGE_DIR, 'package.json'),
    `${JSON.stringify(output.metadata, null, 2)}\n`,
    'utf8',
  );
  fs.writeFileSync(
    path.join(PACKAGE_DIR, 'catalog.json'),
    `${JSON.stringify(output.catalog, null, 2)}\n`,
    'utf8',
  );
  fs.writeFileSync(
    path.join(PACKAGE_DIR, 'manifests.json'),
    `${JSON.stringify(output.manifests, null, 2)}\n`,
    'utf8',
  );
  fs.writeFileSync(path.join(PACKAGE_DIR, 'index.js'), output.indexJs, 'utf8');
  fs.writeFileSync(path.join(PACKAGE_DIR, 'index.d.ts'), output.indexDts, 'utf8');
  console.log(
    `Packaged ${output.catalog.length} capability records as ${PACKAGE_NAME}@${output.version}.`,
  );
}

if (require.main === module) writePackage();

module.exports = {
  DEFAULT_VERSION,
  EDITIONS,
  PACKAGE_DIR,
  PACKAGE_NAME,
  buildPackage,
  publicCatalog,
  publicManifests,
};
