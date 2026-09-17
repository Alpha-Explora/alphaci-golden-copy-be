import type { BuildProfile } from './capability-types.js';
import type { ClientPolicyPack } from './client-policy-pack.port.js';

/** Build-profile keyed module paths; hosted has no policy pack to load. */
export const CLIENT_POLICY_PACK_MODULE_SPECIFIERS = {
  hosted: null,
  enterprise: '../../packs/enterprise/index.js',
} as const satisfies Record<BuildProfile, string | null>;

export interface ClientPolicyPackLoaderDeps {
  readonly loadModule?: (specifier: string) => Promise<unknown>;
}

// Keep the default seam compatible with ts-jest and compiled CommonJS output.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const commonJsRequire = require as (specifier: string) => unknown;

/**
 * Load only the pack owned by the selected build profile.
 *
 * The module path is passed to a variable CommonJS loader instead of being a
 * static import edge. That lets hosted TypeScript compilation exclude the
 * Enterprise source tree and guarantees the hosted branch never evaluates the
 * loader.
 */
export async function loadClientPolicyPack(
  profile: BuildProfile,
  deps: ClientPolicyPackLoaderDeps = {},
): Promise<ClientPolicyPack | null> {
  const specifier = CLIENT_POLICY_PACK_MODULE_SPECIFIERS[profile];
  if (specifier === null) return null;

  const loadModule =
    deps.loadModule ??
    ((value: string) => Promise.resolve(commonJsRequire(value)));
  const moduleValue = await loadModule(specifier);
  const pack =
    typeof moduleValue === 'object' && moduleValue !== null
      ? (moduleValue as Record<string, unknown>)['default']
      : undefined;

  if (!isClientPolicyPack(pack)) {
    throw new Error(
      '[composition] Loaded client policy pack is invalid. ' +
        'It must default-export a pack with edition and createSource.',
    );
  }
  return pack;
}

function isClientPolicyPack(value: unknown): value is ClientPolicyPack {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['edition'] === 'string' &&
    typeof candidate['createSource'] === 'function'
  );
}
