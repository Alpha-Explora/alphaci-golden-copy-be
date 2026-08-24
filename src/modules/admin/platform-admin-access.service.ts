import { Injectable } from '@nestjs/common';

import {
  PlatformAdminsRepository,
  type AppRole,
  type AppRoleSource,
  type PlatformRole,
} from './platform-admins.repository';

/**
 * Public identity policy port for consumers that need platform/admin roles.
 * SQL storage stays behind the Admin context; GitHub, Auth and Hierarchy do
 * not receive the repository itself.
 */
@Injectable()
export class PlatformAdminAccessService {
  constructor(private readonly repository: PlatformAdminsRepository) {}

  findRole(userId: string): Promise<PlatformRole | null> {
    return this.repository.findRole(userId);
  }

  findAppRole(userId: string): Promise<AppRole> {
    return this.repository.findAppRole(userId);
  }

  findAppRoleWithSource(
    userId: string,
  ): Promise<{ role: AppRole; source: AppRoleSource }> {
    return this.repository.findAppRoleWithSource(userId);
  }

  setAppRole(
    userId: string,
    role: AppRole,
    source?: AppRoleSource,
  ): Promise<void> {
    return this.repository.setAppRole(userId, role, source);
  }

  setAppRoleSource(userId: string, source: AppRoleSource): Promise<void> {
    return this.repository.setAppRoleSource(userId, source);
  }

  listGithubTeamSyncedUsers(): ReturnType<
    PlatformAdminsRepository['listGithubTeamSyncedUsers']
  > {
    return this.repository.listGithubTeamSyncedUsers();
  }

  findUserIdByGithubLogin(login: string): Promise<string | null> {
    return this.repository.findUserIdByGithubLogin(login);
  }
}

export type {
  AppRole,
  AppRoleSource,
  PlatformRole,
} from './platform-admins.repository';
