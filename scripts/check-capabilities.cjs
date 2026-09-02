#!/usr/bin/env node
'use strict';

/**
 * Binds the documentation capability registry to real application configuration.
 *
 * The registry used to name its enablement source in prose, so a flag could be
 * renamed in AppConfig while the registry and the generated matrix stayed
 * green. Every record now carries `configurationFlags`, which are checked
 * against the boolean leaves of AppConfig (`src/kernel/config/app.config.types.ts`)
 * in both directions.
 *
 * Checks:
 *   1. every configurationFlags entry exists as a boolean leaf in AppConfig
 *   2. every AppConfig boolean leaf is claimed by a record or explicitly exempt
 *   3. requires edges resolve to known capability keys, are acyclic, and
 *      never point at a capability with a narrower edition set
 *   4. records are structurally valid (key/context/maturity vocabulary)
 *
 * Usage:
 *   node ./scripts/check-capabilities.cjs
 *   node ./scripts/check-capabilities.cjs --json
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const REGISTRY = path.join(ROOT, 'docs/capabilities/registry.ts');
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

/**
 * Infrastructure toggles that are deliberately not product capabilities.
 * Adding a flag here is a decision: it asserts the flag does not gate a
 * customer-visible behavior that a pack could compose.
 */
const NON_CAPABILITY_FLAGS = new Set([
  'session.secure',            // transport hardening, not a product surface
  'subscription.mockEnabled',  // local development seam
]);

function readRegistry() {
  const source = fs.readFileSync(REGISTRY, 'utf8');
  const match = /export const CAPABILITIES = (\[[\s\S]*?\])\s+as const;\s*$/m.exec(source);
  if (!match) {
    throw new Error('registry.ts must export a JSON-shaped CAPABILITIES array');
  }
  return JSON.parse(match[1]);
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
  const capabilities = readRegistry();
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
    for (const edition of capability.editions ?? []) {
      if (!EDITIONS.has(edition)) {
        errors.push(`${at} unknown edition: ${edition}`);
      }
    }
    if (!Array.isArray(capability.configurationFlags) || capability.configurationFlags.length === 0) {
      errors.push(`${at} must declare at least one configurationFlags entry`);
    }

    // 1. declared flags must exist in AppConfig
    for (const flag of capability.configurationFlags ?? []) {
      if (!configFlags.has(flag)) {
        errors.push(`${at} configuration flag not found in AppConfig: ${flag}`);
      }
    }

    // 3. requires edges resolve, and cannot widen an edition set
    for (const dependency of capability.requires ?? []) {
      const target = byKey.get(dependency);
      if (!target) {
        errors.push(`${at} requires unknown capability: ${dependency}`);
        continue;
      }
      const missing = (capability.editions ?? []).filter(
        (edition) => !(target.editions ?? []).includes(edition),
      );
      if (missing.length > 0) {
        errors.push(
          `${at} is applicable in [${missing.join(', ')}] but its dependency ${dependency} is not; a capability cannot outlive what it requires`,
        );
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
  `Capability registry OK (${result.capabilityCount} capabilities, ${result.claimedFlagCount}/${result.configFlagCount} AppConfig flags owned, ${result.exemptFlagCount} exempt, ${result.requiresEdgeCount} requires edge(s)).`,
);

module.exports = { collect };
