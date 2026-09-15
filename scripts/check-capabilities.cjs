#!/usr/bin/env node
'use strict';

/**
 * Binds the application capability catalog to real application configuration.
 *
 * The registry used to name its enablement source in prose, so a flag could be
 * renamed in AppConfig while the catalog and the generated matrix stayed
 * green. Every record now carries `configurationFlags`, which are checked
 * against the boolean leaves of AppConfig (`src/kernel/config/app.config.types.ts`)
 * in both directions.
 *
 * Checks:
 *   1. every configurationFlags entry exists as a boolean leaf in AppConfig
 *   2. every AppConfig boolean leaf is claimed by a record or explicitly exempt
 *   3. requires edges resolve to known capability keys and are acyclic
 *   4. records are structurally valid (key/context/maturity vocabulary)
 *   5. not-implemented records do not claim AppConfig flags
 *   6. each pack profile lists every registry key in registry order with
 *      status derived from maturity and edition applicability
 *
 * Usage:
 *   node ./scripts/check-capabilities.cjs
 *   node ./scripts/check-capabilities.cjs --json
 */

const fs = require('node:fs');
const path = require('node:path');
const { loadCapabilityCatalog } = require('./load-capability-catalog.cjs');

const ROOT = path.resolve(__dirname, '..');
const APP_CONFIG = path.join(ROOT, 'src/kernel/config/app.config.types.ts');

const CONTEXTS = new Set([
  'identity-access',
  'projects',
  'pipelines',
  'runtime',
  'billing',
  'platform-ops',
]);
const MATURITIES = new Set(['stable', 'limited', 'not-implemented']);
const EDITIONS = new Set(['saas', 'edu', 'enterprise']);
const PACK_STATUSES = new Set([
  'available',
  'configuration-gated',
  'not-implemented',
  'not-applicable',
]);
const PACK_PROFILES = [
  { edition: 'saas', file: 'docs/packs/saas/pack.md' },
  { edition: 'edu', file: 'docs/packs/edu/pack.md' },
  { edition: 'enterprise', file: 'docs/packs/enterprise/pack.md' },
];

/**
 * Infrastructure toggles that are deliberately not product capabilities.
 * Adding a flag here is a decision: it asserts the flag does not gate a
 * customer-visible behavior that a pack could compose.
 */
const NON_CAPABILITY_FLAGS = new Set([
  'session.secure',            // transport hardening, not a product surface
  'subscription.mockEnabled',  // local development seam
  'gcpDeployments.dedicatedProjectsEnabled', // optional provider mode, not base GCP availability
  'projectSyncSnapshots.liveGithubEnabled', // optional live adapter mode
  'projectSyncSnapshots.liveProvidersEnabled', // optional live adapter mode
  'ciRunTracking.liveGithubEnabled', // optional live adapter mode
  'deploymentHistory.liveProvidersEnabled', // optional live adapter mode
  'driftRepair.liveRepairEnabled', // optional live repair mode
  'driftLiveChecks.enabled', // optional live check mode
]);

function readCapabilityCatalog() {
  const catalog = loadCapabilityCatalog();
  if (!catalog || !Array.isArray(catalog.capabilities)) {
    throw new Error(
      'Capability catalog loader must expose the application CAPABILITIES array',
    );
  }
  if (!catalog.manifests || typeof catalog.manifests !== 'object') {
    throw new Error(
      'Capability catalog loader must expose the application PACK_MANIFESTS object',
    );
  }
  return catalog;
}

/** Boolean leaves of the AppConfig interface, as "group.flag" paths. */
function readConfigFlags() {
  const source = fs.readFileSync(APP_CONFIG, 'utf8');
  const iface = /export interface AppConfig \{[\s\S]*?\n\}/.exec(source);
  if (!iface) throw new Error('Could not locate the AppConfig interface');

  const flags = new Set();
  let group = null;
  for (const line of iface[0].split(/\r?\n/)) {
    const groupMatch = /^ {2}([A-Za-z][A-Za-z0-9]*): \{/.exec(line);
    if (groupMatch) {
      group = groupMatch[1];
      continue;
    }
    if (/^ {2}\}/.test(line)) {
      group = null;
      continue;
    }
    const leaf = /^ {4}([A-Za-z][A-Za-z0-9]*)(\?)?: boolean/.exec(line);
    if (leaf && group) flags.add(`${group}.${leaf[1]}`);
  }
  return flags;
}

function expectedPackStatus(capability, edition, manifests) {
  const manifest = manifests?.[edition];
  if (!manifest?.capabilities?.includes(capability.key)) return 'not-applicable';
  if (capability.maturity === 'stable') return 'available';
  if (capability.maturity === 'limited') return 'configuration-gated';
  return 'not-implemented';
}

function parsePackCapabilityRows(markdown) {
  const heading = /^## Capability status\s*$/m.exec(markdown);
  if (!heading) return { error: 'missing ## Capability status heading' };
  const rest = markdown.slice(heading.index + heading[0].length);
  const nextHeading = /^## /m.exec(rest);
  const section = nextHeading ? rest.slice(0, nextHeading.index) : rest;
  const rows = [];
  for (const line of section.split(/\r?\n/)) {
    const match = /^\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|\s*(.*?)\s*\|\s*$/.exec(line);
    if (match) rows.push({ key: match[1], status: match[2] });
  }
  return { rows };
}

function manifestCatalogErrors(capabilities, manifests) {
  const errors = [];
  const entries = Object.entries(manifests ?? {});
  const registryIndexes = new Map(
    capabilities.map((capability, index) => [capability.key, index]),
  );

  for (const edition of EDITIONS) {
    const matches = entries.filter(([, manifest]) => manifest?.edition === edition);
    if (matches.length !== 1) {
      errors.push(`manifest edition ${edition} must exist exactly once`);
    }
  }

  for (const [name, manifest] of entries) {
    const at = `manifest ${name}`;
    if (!EDITIONS.has(manifest?.edition)) {
      errors.push(`${at} has unknown edition: ${manifest?.edition}`);
    }
    if (!Array.isArray(manifest?.capabilities)) {
      errors.push(`${at} capabilities must be an array`);
      continue;
    }

    const seen = new Set();
    let previousIndex = -1;
    for (const key of manifest.capabilities) {
      if (seen.has(key)) {
        errors.push(`${at} contains duplicate capability key: ${key}`);
        continue;
      }
      seen.add(key);

      const index = registryIndexes.get(key);
      if (index === undefined) {
        errors.push(`${at} contains unknown capability key: ${key}`);
        continue;
      }
      if (index <= previousIndex) {
        errors.push(`${at} capabilities must follow registry order at ${key}`);
      }
      previousIndex = index;
    }
  }

  return errors;
}

function packCatalogErrors(capabilities, manifests) {
  const errors = [];
  for (const pack of PACK_PROFILES) {
    const file = path.join(ROOT, pack.file);
    if (!fs.existsSync(file)) {
      errors.push(`${pack.file}: pack profile is missing`);
      continue;
    }
    const parsed = parsePackCapabilityRows(fs.readFileSync(file, 'utf8'));
    if (parsed.error) {
      errors.push(`${pack.file}: ${parsed.error}`);
      continue;
    }
    const rows = parsed.rows;
    if (rows.length === 0) {
      errors.push(`${pack.file}: Capability status table has no capability rows`);
      continue;
    }
    const max = Math.max(rows.length, capabilities.length);
    for (let index = 0; index < max; index += 1) {
      const expected = capabilities[index];
      const actual = rows[index];
      const at = `${pack.file} row ${index + 1}`;
      if (!expected) {
        errors.push(`${at}: extra capability key ${actual.key}`);
        continue;
      }
      if (!actual) {
        errors.push(`${at}: missing capability key ${expected.key}`);
        continue;
      }
      if (actual.key !== expected.key) {
        errors.push(`${at}: expected ${expected.key} in registry order, found ${actual.key}`);
      }
      if (!PACK_STATUSES.has(actual.status)) {
        errors.push(`${at}: unknown pack status ${actual.status}`);
        continue;
      }
      const expectedStatus = expectedPackStatus(expected, pack.edition, manifests);
      if (actual.status !== expectedStatus) {
        errors.push(
          `${at}: ${expected.key} must be ${expectedStatus} for ${pack.edition} (maturity ${expected.maturity})`,
        );
      }
    }
  }
  return errors;
}

function detectCycle(byKey) {
  const state = new Map();
  let cycle = null;

  function walk(key, trail) {
    if (state.get(key) === 'done') return;
    if (state.get(key) === 'open') {
      cycle = [...trail.slice(trail.indexOf(key)), key];
      return;
    }
    state.set(key, 'open');
    for (const next of byKey.get(key).requires ?? []) {
      if (byKey.has(next) && !cycle) walk(next, [...trail, key]);
    }
    state.set(key, 'done');
  }

  for (const key of byKey.keys()) {
    if (!cycle) walk(key, []);
  }
  return cycle;
}

function collect() {
  const { capabilities, manifests } = readCapabilityCatalog();
  const configFlags = readConfigFlags();
  const errors = [];
  const byKey = new Map();

  for (const capability of capabilities) {
    if (byKey.has(capability.key)) {
      errors.push(`duplicate capability key: ${capability.key}`);
    }
    byKey.set(capability.key, capability);
  }

  for (const capability of capabilities) {
    const at = `[${capability.key}]`;

    if (!CONTEXTS.has(capability.context)) {
      errors.push(`${at} unknown owning context: ${capability.context}`);
    }
    if (!MATURITIES.has(capability.maturity)) {
      errors.push(`${at} unknown maturity: ${capability.maturity}`);
    }
    if (!Array.isArray(capability.configurationFlags)) {
      errors.push(`${at} configurationFlags must be an array`);
    } else if (capability.maturity === 'not-implemented') {
      if (capability.configurationFlags.length > 0) {
        errors.push(
          `${at} not-implemented capabilities must not claim AppConfig flags until the behavior exists`,
        );
      }
    } else if (capability.configurationFlags.length === 0) {
      errors.push(`${at} must declare at least one configurationFlags entry`);
    }

    // 1. declared flags must exist in AppConfig
    for (const flag of capability.configurationFlags ?? []) {
      if (!configFlags.has(flag)) {
        errors.push(`${at} configuration flag not found in AppConfig: ${flag}`);
      }
    }

    // 3. requires edges resolve
    for (const dependency of capability.requires ?? []) {
      const target = byKey.get(dependency);
      if (!target) {
        errors.push(`${at} requires unknown capability: ${dependency}`);
      }
    }
  }

  // 2. every AppConfig boolean leaf is claimed or exempt
  const claimed = new Set(
    capabilities.flatMap((capability) => capability.configurationFlags ?? []),
  );
  const unclaimed = [...configFlags]
    .filter((flag) => !claimed.has(flag) && !NON_CAPABILITY_FLAGS.has(flag))
    .sort();
  for (const flag of unclaimed) {
    errors.push(
      `AppConfig flag is not owned by any capability record: ${flag} (add a record, or add it to NON_CAPABILITY_FLAGS with a reason)`,
    );
  }

  const staleExempt = [...NON_CAPABILITY_FLAGS]
    .filter((flag) => !configFlags.has(flag))
    .sort();
  for (const flag of staleExempt) {
    errors.push(`NON_CAPABILITY_FLAGS names a flag that no longer exists: ${flag}`);
  }

  const cycle = detectCycle(byKey);
  if (cycle) errors.push(`requires cycle: ${cycle.join(' -> ')}`);

  errors.push(...manifestCatalogErrors(capabilities, manifests));
  errors.push(...packCatalogErrors(capabilities, manifests));

  return {
    capabilityCount: capabilities.length,
    configFlagCount: configFlags.size,
    claimedFlagCount: claimed.size,
    exemptFlagCount: NON_CAPABILITY_FLAGS.size,
    requiresEdgeCount: capabilities.reduce(
      (total, capability) => total + (capability.requires?.length ?? 0),
      0,
    ),
    errors,
  };
}

const result = collect();

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.errors.length > 0 ? 1 : 0);
}

if (result.errors.length > 0) {
  console.error(`Capability registry check failed: ${result.errors.length} problem(s).`);
  for (const error of result.errors) console.error(`  ${error}`);
  process.exit(1);
}

console.log(
  `Capability registry OK (${result.capabilityCount} capabilities, ${result.claimedFlagCount}/${result.configFlagCount} AppConfig flags owned, ${result.exemptFlagCount} exempt, ${result.requiresEdgeCount} requires edge(s), pack catalogs complete).`,
);

module.exports = { collect, expectedPackStatus, parsePackCapabilityRows };
