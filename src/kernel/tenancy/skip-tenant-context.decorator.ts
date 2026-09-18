import { SetMetadata } from '@nestjs/common';

/**
 * Marks an authenticated route as global rather than tenant-owned.
 *
 * Authentication still runs, but the request is not required to have a
 * membership-backed TenantContext. Use this only for explicitly global
 * identity, account, or platform operations.
 */
export const SKIP_TENANT_CONTEXT = Symbol('skipTenantContext');

export const SkipTenantContext = () => SetMetadata(SKIP_TENANT_CONTEXT, true);
