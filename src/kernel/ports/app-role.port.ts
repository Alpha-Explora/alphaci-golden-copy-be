import type { PlatformAppRole } from './platform-admin.port';

/**
 * Cross-context lookup of a user's effective global persona (app_role).
 *
 * Projects owns `identity.app_users.app_role` and the platform_admins
 * override that folds any platform-admin row into 'admin' regardless of the
 * stored app_role column — see ProjectsRepository.findAppRole, the single
 * source of truth this port re-exposes. Runtime (env-vars, deployment
 * secrets) needs the same answer to decide who may manage deployment
 * configuration, so this is a read-only port into Projects rather than a
 * second, divergent implementation.
 *
 * Bound globally by ProjectVisibilityModule, the same @Global()
 * port-without-import-edge pattern as PROJECT_VISIBILITY_LOOKUP and
 * DEPLOYMENT_PROJECT_REFERENCE_LOOKUP — Projects already imports Runtime
 * (RuntimeModule, for CI/deployment features on the project surface), so
 * Runtime importing Projects back would be a cross-context cycle
 * dependency-cruiser's no-cross-context-cycles rule forbids.
 */
export interface AppRoleLookup {
  findAppRole(userId: string): Promise<PlatformAppRole>;
}

export const APP_ROLE_LOOKUP = Symbol('AppRoleLookup');
