import { Injectable, Logger } from '@nestjs/common';

import {
  GithubTeamAccessProvider,
  type EnsureTeamResult,
  type VerifyPermissionResult,
} from './github-team-access.provider';

/**
 * Always-succeeds mock used when HIERARCHY_GITHUB_SYNC_MODE=stub (default in
 * every environment, plan §1.7). Runs the full state-machine and outbox
 * lifecycle against a no-op GitHub client — lets the PM/developer UI and
 * audit trail be built, reviewed, and tested before real GitHub Team API
 * calls are turned on.
 */
@Injectable()
export class GithubTeamAccessStubProvider extends GithubTeamAccessProvider {
  private readonly logger = new Logger(GithubTeamAccessStubProvider.name);

  ensureTeam(input: {
    repositoryId: string;
    repoFullName: string;
  }): Promise<EnsureTeamResult> {
    this.logger.debug(
      `[stub] ensureTeam for ${input.repoFullName} (repository ${input.repositoryId})`,
    );
    const slugSafeName = input.repoFullName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-');
    return Promise.resolve({
      githubTeamId: `stub-team-${input.repositoryId}`,
      githubTeamSlug: `${slugSafeName}-developers`,
    });
  }

  addMember(input: {
    githubTeamSlug: string;
    githubLogin: string;
  }): Promise<void> {
    this.logger.debug(
      `[stub] addMember ${input.githubLogin} -> ${input.githubTeamSlug}`,
    );
    return Promise.resolve();
  }

  removeMember(input: {
    githubTeamSlug: string;
    githubLogin: string;
  }): Promise<void> {
    this.logger.debug(
      `[stub] removeMember ${input.githubLogin} -> ${input.githubTeamSlug}`,
    );
    return Promise.resolve();
  }

  verifyEffectivePermission(): Promise<VerifyPermissionResult> {
    return Promise.resolve({
      hasAccess: true,
      permission: 'write',
      hasUnapprovedGrant: false,
    });
  }
}
