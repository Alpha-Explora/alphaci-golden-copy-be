export type PlatformAppRole = 'admin' | 'lead' | 'member';
export type PlatformAppRoleSource = 'github_team' | 'manual';

/**
 * Single swap point for GitHub's future out-of-process role synchronization.
 * The pipelines context depends on this contract, not identity storage.
 */
export interface PlatformAdminPort {
  findAppRoleWithSource(
    userId: string,
  ): Promise<{ role: PlatformAppRole; source: PlatformAppRoleSource }>;
  setAppRole(
    userId: string,
    role: PlatformAppRole,
    source?: PlatformAppRoleSource,
  ): Promise<void>;
  listGithubTeamSyncedUsers(): Promise<
    Array<{ id: string; login: string; appRole: PlatformAppRole }>
  >;
  findUserIdByGithubLogin(login: string): Promise<string | null>;
}

export const PLATFORM_ADMIN_PORT = Symbol('PLATFORM_ADMIN_PORT');
