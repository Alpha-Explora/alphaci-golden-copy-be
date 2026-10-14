import type { PlatformAppRole } from '#kernel/ports/platform-admin.port';

/** Explicit release approval uses the global persona and fails closed. */
export function canPromoteRelease(
  role: PlatformAppRole | null | undefined,
  destinationRole: 'production' | 'non_production',
): boolean {
  return (
    role === 'admin' ||
    role === 'lead' ||
    (role === 'member' && destinationRole === 'non_production')
  );
}
