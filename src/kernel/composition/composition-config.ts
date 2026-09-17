import type { AppConfig } from '#kernel/config/app.config.types.js';
import {
  assertManifestWithinBuildProfile,
  parseBuildProfile,
} from './build-profile.js';
import type { Edition } from './capability-types.js';
import { parseClientId } from './client-policy.js';
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
  return { edition, profile, client: parseClientConfig(env) };
}

function parseClientConfig(
  env: NodeJS.ProcessEnv,
): AppConfig['composition']['client'] {
  const rawPath = env['ALPHACI_CLIENT_CONFIG'];
  const configPath =
    typeof rawPath === 'string' && rawPath.trim() !== ''
      ? rawPath.trim()
      : null;

  const id = parseClientId(env['ALPHACI_CLIENT']);
  return { id, configPath, enabled: id !== null || configPath !== null };
}
