import type { PlatformAppRole } from '#kernel/ports/platform-admin.port';

/**
 * Re-applying branch protection changes what every developer on the repository
 * can do, so it is lead|admin only. An allow-list, not "anyone but member":
 * a new role must not inherit this by omission.
 */
export function canRepairBranchProtection(role: PlatformAppRole): boolean {
  return role === 'lead' || role === 'admin';
}
