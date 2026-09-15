import type {
  BuildProfile,
  CapabilityKey,
  CapabilityManifest,
  Edition,
} from './capability-types.js';
import { PACK_MANIFESTS } from './manifests.js';

export type { BuildProfile } from './capability-types.js';

export interface PackArtifactInventory {
  /** Source roots reserved for pack-owned implementation code. */
  readonly sourceRoots: readonly string[];
  /** Stable symbol markers reserved for pack-owned implementation code. */
  readonly symbols: readonly string[];
}

export type PackArtifactInventoryMap = Readonly<
  Record<Edition, PackArtifactInventory>
>;

/**
 * These are reserved pack-only roots and symbol markers, not implementation
 * code. They make the current absence check explicit: future pack code must
 * use one of these declarations before it can be composed safely.
 */
export const PACK_ARTIFACT_INVENTORY = {
  saas: {
    sourceRoots: ['src/packs/saas'],
    symbols: ['SaasOnlyCapabilityMarker'],
  },
  edu: {
    sourceRoots: ['src/packs/edu'],
    symbols: ['EduOnlyCapabilityMarker'],
  },
  enterprise: {
    sourceRoots: ['src/packs/enterprise'],
    symbols: ['EnterpriseOnlyCapabilityMarker'],
  },
} as const satisfies PackArtifactInventoryMap;

export const BUILD_PROFILES = {
  hosted: {
    editions: ['saas', 'edu'],
    excludedEditions: ['enterprise'],
  },
  enterprise: {
    editions: ['enterprise'],
    excludedEditions: ['saas', 'edu'],
  },
} as const satisfies Record<
  BuildProfile,
  { editions: readonly Edition[]; excludedEditions: readonly Edition[] }
>;

export const BUILD_PROFILE_CAPABILITY_CEILINGS: Readonly<
  Record<BuildProfile, ReadonlySet<CapabilityKey>>
> = {
  hosted: capabilityCeiling(BUILD_PROFILES.hosted.editions),
  enterprise: capabilityCeiling(BUILD_PROFILES.enterprise.editions),
};

export function parseBuildProfile(value: unknown): BuildProfile {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (raw === '') return 'enterprise';

  const profileByValue: Record<string, BuildProfile> = {
    hosted: 'hosted',
    enterprise: 'enterprise',
  };
  const profile = profileByValue[raw];
  if (!profile) {
    throw new Error(
      `[config] Invalid ALPHACI_BUILD_PROFILE: '${String(value)}'. ` +
        'Allowed values: hosted, enterprise. Default when unset: enterprise.',
    );
  }
  return profile;
}

export function buildProfileAllowsEdition(
  profile: BuildProfile,
  edition: Edition,
): boolean {
  return new Set(BUILD_PROFILES[profile].editions).has(edition);
}

export function buildProfileCapabilityCeiling(
  profile: BuildProfile,
): ReadonlySet<CapabilityKey> {
  return BUILD_PROFILE_CAPABILITY_CEILINGS[profile];
}

export function artifactExclusionsFor(
  profile: BuildProfile,
  inventory: PackArtifactInventoryMap = PACK_ARTIFACT_INVENTORY,
): PackArtifactInventory {
  const excludedEditions = BUILD_PROFILES[profile].excludedEditions;
  return {
    sourceRoots: deduplicate(
      excludedEditions.flatMap((edition) => inventory[edition].sourceRoots),
    ),
    symbols: deduplicate(
      excludedEditions.flatMap((edition) => inventory[edition].symbols),
    ),
  };
}

export function assertManifestWithinBuildProfile(
  profile: BuildProfile,
  manifest: CapabilityManifest,
): void {
  if (!buildProfileAllowsEdition(profile, manifest.edition)) {
    throw new Error(
      `edition '${manifest.edition}' is not allowed by build profile '${profile}'`,
    );
  }

  const ceiling = buildProfileCapabilityCeiling(profile);
  const outsideCeiling = manifest.capabilities.filter(
    (key) => !ceiling.has(key),
  );
  if (outsideCeiling.length > 0) {
    throw new Error(
      `manifest for '${manifest.edition}' contains capability(s) outside build profile '${profile}': ${outsideCeiling.join(', ')}`,
    );
  }
}

function capabilityCeiling(
  editions: readonly Edition[],
): ReadonlySet<CapabilityKey> {
  return new Set(
    editions.flatMap((edition) => PACK_MANIFESTS[edition].capabilities),
  );
}

function deduplicate(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}
