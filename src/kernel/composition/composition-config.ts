import type { AppConfig } from '#kernel/config/app.config.types.js';
import {
  assertManifestWithinBuildProfile,
  parseBuildProfile,
} from './build-profile.js';
import type { Edition } from './capability-types.js';
import { PACK_MANIFESTS } from './manifests.js';

const EDITION_BY_ENV_VALUE: Record<string, Edition> = {
  saas: 'saas',
  edu: 'edu',
  enterprise: 'enterprise',
};

export function parseEdition(value: unknown): Edition {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (raw === '') return 'enterprise';

  const edition = EDITION_BY_ENV_VALUE[raw];
  if (!edition) {
    throw new Error(
      `[config] Invalid ALPHACI_EDITION: '${String(value)}'. ` +
        'Allowed values: saas, edu, enterprise. Default when unset: enterprise.',
    );
  }
  return edition;
}

export function parseCompositionConfig(
  env: NodeJS.ProcessEnv,
): AppConfig['composition'] {
  const edition = parseEdition(env['ALPHACI_EDITION']);
  const profile = parseBuildProfile(env['ALPHACI_BUILD_PROFILE']);
  const manifest = PACK_MANIFESTS[edition];

  assertManifestWithinBuildProfile(profile, manifest);
  return { edition, profile };
}
