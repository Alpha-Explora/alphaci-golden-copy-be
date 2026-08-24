/**
 * Env provisioning — public API.
 *
 * Unlike notifications/index.ts, this file is NOT yet the module's entire
 * surface: most of env-provisioning is still reached by direct file imports
 * from `projects` and those are grandfathered in the dependency-cruiser
 * baseline. This barrel is being grown migrate-on-touch — when a consumer
 * needs something new from this module, it gets exported here rather than
 * deep-imported, so the baseline shrinks instead of growing.
 *
 * Treat an entry below as a contract other modules depend on. Add to it only
 * when a second module genuinely needs the thing.
 */

// Provider URL conventions. Shared so that "where does this service answer?"
// has exactly one answer in the backend — the target listing and the
// deployment history both need it, and a provider changing its hostname
// format should be a one-line edit.
export { providerPublicUrl } from './provider-public-url';

// Contracts: the shapes crossing this boundary. Which provider hosts a thing
// is stamped on every deployment and preview payload the projects module
// returns, so it is part of this module's public vocabulary.
export type { EnvProvider } from './env-provisioning.types';
