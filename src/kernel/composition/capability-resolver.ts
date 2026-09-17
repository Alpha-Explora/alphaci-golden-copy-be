import { CAPABILITIES } from './capability-registry.js';
import type {
  CapabilityKey,
  CapabilityManifest,
  CapabilityRecord,
  CapabilitySet,
  ResolveCapabilitiesInput,
} from './capability-types.js';
import { assertManifestWithinBuildProfile } from './build-profile.js';

export function resolveCapabilities({
  registry = CAPABILITIES,
  manifest,
  config,
}: ResolveCapabilitiesInput): CapabilitySet {
  const recordsByKey = validateRegistryAndManifest(registry, manifest);
  assertManifestWithinBuildProfile(config.composition.profile, manifest);
  const active = new Set<CapabilityKey>();

  for (const key of manifest.capabilities) {
    const record = recordsByKey.get(key);
    if (
      record &&
      record.maturity !== 'not-implemented' &&
      record.configurationFlags.every((flag) => readBooleanPath(config, flag))
    ) {
      active.add(record.key as CapabilityKey);
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const key of [...active]) {
      const record = recordsByKey.get(key);
      if (
        record &&
        record.requires.some(
          (dependency) => !active.has(dependency as CapabilityKey),
        )
      ) {
        active.delete(key);
        changed = true;
      }
    }
  }

  return new Set(
    registry
      .filter(({ key }) => active.has(key as CapabilityKey))
      .map(({ key }) => key as CapabilityKey),
  );
}

function validateRegistryAndManifest(
  registry: readonly CapabilityRecord[],
  manifest: CapabilityManifest,
): Map<string, CapabilityRecord> {
  const recordsByKey = new Map<string, CapabilityRecord>();
  for (const record of registry) {
    if (recordsByKey.has(record.key)) {
      throw new Error(`duplicate registry capability: ${record.key}`);
    }
    recordsByKey.set(record.key, record);
  }

  const registryPositions = new Map<string, number>();
  registry.forEach(({ key }, index) => registryPositions.set(key, index));

  const manifestKeys = new Set<string>();
  let previousPosition = -1;
  for (const key of manifest.capabilities) {
    if (!recordsByKey.has(key)) {
      throw new Error(`unknown manifest capability: ${key}`);
    }
    if (manifestKeys.has(key)) {
      throw new Error(`duplicate manifest capability: ${key}`);
    }
    manifestKeys.add(key);

    const position = registryPositions.get(key);
    if (position === undefined || position <= previousPosition) {
      throw new Error(`manifest is not in registry order: ${key}`);
    }
    previousPosition = position;
  }

  for (const record of registry) {
    for (const dependency of record.requires) {
      if (!recordsByKey.has(dependency)) {
        throw new Error(`unknown required capability: ${dependency}`);
      }
    }
  }

  const states = new Map<string, 'visiting' | 'visited'>();
  const visit = (key: string): void => {
    const state = states.get(key);
    if (state === 'visiting') {
      throw new Error(`requires cycle: ${key}`);
    }
    if (state === 'visited') return;

    states.set(key, 'visiting');
    const record = recordsByKey.get(key);
    if (record) {
      for (const dependency of record.requires) visit(dependency);
    }
    states.set(key, 'visited');
  };

  for (const record of registry) visit(record.key);

  return recordsByKey;
}

function readBooleanPath(value: AppConfigValue, path: string): boolean {
  let current: unknown = value;
  for (const segment of path.split('.')) {
    if (
      typeof current !== 'object' ||
      current === null ||
      !(segment in current)
    ) {
      return false;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current === true;
}

type AppConfigValue = ResolveCapabilitiesInput['config'];
