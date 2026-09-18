import type { BuildProfile } from '#kernel/composition/capability-types.js';

export type TenantDeploymentMode = BuildProfile;

export type TenantMembershipRole = 'owner' | 'admin' | 'member' | 'viewer';

export interface TenantContext {
  readonly tenantId: string;
  readonly userId: string;
  readonly membershipRole: TenantMembershipRole;
  readonly deploymentMode: TenantDeploymentMode;
}

export const TENANT_CONTEXT = Symbol('TenantContext');

export interface TenantContextPort {
  /** Returns the validated context for the current request, if one exists. */
  current(): TenantContext | null;
  /** Fails explicitly instead of allowing an unscoped operation to continue. */
  require(): TenantContext;
  /** Binds a validated context to the current request scope. */
  set(context: TenantContext): void;
  /** Removes any context after an authentication or resolution failure. */
  clear(): void;
}

export const TENANT_CONTEXT_RESOLVER = Symbol('TenantContextResolver');

export interface TenantContextResolverPort {
  resolveForSession(
    userId: string,
    requestedTenantId?: string,
  ): Promise<TenantContext>;
}
