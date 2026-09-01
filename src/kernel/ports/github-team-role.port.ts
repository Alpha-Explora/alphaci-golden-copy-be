import type { PlatformAppRole } from './platform-admin.port';

/**
 * Identity Access consumes GitHub team-derived role decisions through this
 * narrow port. The Pipelines context owns the implementation and remains the
 * only place that knows how GitHub team membership is read.
 */
export interface GithubTeamRolePort {
  resolveSeedRole(
    login: string,
    token: string,
    isOrgOwner: boolean,
  ): Promise<PlatformAppRole | null>;
  syncRoleForUser(input: {
    userId: string;
    login: string;
    token: string;
    isOrgOwner?: boolean;
    trigger: string;
  }): Promise<unknown>;
}

export const GITHUB_TEAM_ROLE_PORT = Symbol('GithubTeamRolePort');
