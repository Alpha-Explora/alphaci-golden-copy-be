import { Inject, Injectable, Logger } from '@nestjs/common';

import {
  GITHUB_PROJECT_PORT,
  type GithubProjectPort,
} from '#kernel/ports/github.port';

/**
 * Which GitHub credential to use for one repository.
 *
 * Same sources as ProjectWorkspaceService.context() and
 * QaCommitResolutionService.resolveReadToken() (enforced-org installation
 * token, the caller's per-user-repo installation token, the caller's own OAuth
 * token), exposed here as two orderings because the callers differ:
 *
 *   installationFirst  repository administration and background-style reads
 *                      (the Audit trail sync, branch protection). Scoped to
 *                      the repository and independent of the caller's OAuth
 *                      grant, which is stored once at sign-in and goes stale.
 *   userFirst          the Commits list: the person's own view of the
 *                      repository, falling back to the App when their sign-in
 *                      is gone.
 *
 * Both are lazy: the installation lookups are only run when reached.
 */
@Injectable()
export class ProjectGithubTokenResolver {
  private readonly logger = new Logger(ProjectGithubTokenResolver.name);

  constructor(
    @Inject(GITHUB_PROJECT_PORT)
    private readonly githubService: GithubProjectPort,
  ) {}

  async installationFirst(
    repoFullName: string,
    userId: string,
    oauthToken: string | null,
  ): Promise<string | null> {
    return (
      (await this.installationToken(repoFullName, userId)) ?? oauthToken ?? null
    );
  }

  /** Candidate tokens in order; the caller stops at the first that works. */
  userFirst(
    repoFullName: string,
    userId: string,
    oauthToken: string | null,
  ): Array<() => Promise<string | null>> {
    const candidates: Array<() => Promise<string | null>> = [];
    if (oauthToken) {
      candidates.push(() => Promise.resolve(oauthToken));
    }
    candidates.push(() => this.installationToken(repoFullName, userId));
    return candidates;
  }

  async installationToken(
    repoFullName: string,
    userId: string,
  ): Promise<string | null> {
    const enforced = await this.enforcedOrgToken(repoFullName);
    if (enforced) return enforced;
    try {
      return await this.githubService.getInstallationAccessTokenForUserRepo(
        userId,
        repoFullName,
      );
    } catch (error) {
      this.logger.debug(
        `No installation token for ${repoFullName}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  private async enforcedOrgToken(repoFullName: string): Promise<string | null> {
    const enforcedOrg = this.githubService.getEnforcedOrg();
    if (!enforcedOrg) return null;
    const owner = repoFullName.split('/')[0];
    if (owner?.toLowerCase() !== enforcedOrg.toLowerCase()) return null;
    try {
      const context =
        await this.githubService.getOrganizationProvisioningContextByLogin(
          enforcedOrg,
        );
      return context.accessToken;
    } catch (error) {
      this.logger.warn(
        `Could not resolve the ${enforcedOrg} installation for ${repoFullName}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }
}
