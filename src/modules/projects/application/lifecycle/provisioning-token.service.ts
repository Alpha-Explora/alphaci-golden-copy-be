import {
  Inject,
  Injectable,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';

import {
  GITHUB_PROJECT_PORT,
  type GithubProjectPort,
} from '#kernel/ports/github.port';
import type { CreateProjectDto } from '../../dto/create-project.dto';

/**
 * GitHub token resolution for repository provisioning flows.
 *
 * Extracted verbatim from ProjectsService. Owns the three token strategies:
 * personal OAuth fallback, selected-org installation, and the enforced-org
 * override that routes every repository into the enforced organization.
 */
@Injectable()
export class ProvisioningTokenService {
  constructor(
    @Inject(GITHUB_PROJECT_PORT)
    private readonly githubService: GithubProjectPort,
  ) {}

  /**
   * Token used to CREATE a repository. Personal accounts require the user's
   * OAuth token; GitHub App installation tokens cannot call POST /user/repos,
   * so an installation token is only a fallback when the session has no OAuth
   * token.
   */
  async resolveProvisioningToken(
    userId: string,
    oauthAccessToken: string | null | undefined,
  ): Promise<string> {
    // Repository creation for personal accounts requires a user OAuth token.
    // GitHub App installation tokens cannot call POST /user/repos, so only use
    // one as a fallback when the session has no OAuth token.
    if (oauthAccessToken) {
      return oauthAccessToken;
    }

    const installationToken =
      await this.githubService.getInstallationAccessTokenForUser(userId);

    if (installationToken) {
      return installationToken;
    }

    throw new UnauthorizedException(
      'No usable GitHub token found. Link the GitHub App installation or re-authenticate via GitHub OAuth.',
    );
  }

  async resolveSetupProvisioningToken(
    userId: string,
    oauthAccessToken: string | null | undefined,
    repoFullName: string,
  ): Promise<string> {
    const installationToken =
      await this.githubService.getInstallationAccessTokenForUserRepo(
        userId,
        repoFullName,
      );

    if (installationToken) {
      return installationToken;
    }

    if (oauthAccessToken) {
      return oauthAccessToken;
    }

    throw new UnauthorizedException(
      'No usable GitHub token found. Link the GitHub App installation or re-authenticate via GitHub OAuth.',
    );
  }

  async resolveRepositoryProvisioning(
    userId: string,
    oauthAccessToken: string | null | undefined,
    dto: CreateProjectDto,
  ): Promise<{
    repositoryCreationToken: string;
    provisioningToken: string;
    provisioningOwnerLogin: string | undefined;
  }> {
    // When the deployment enforces a destination org, every repository is
    // created there regardless of the request's ownerType/installationId, and
    // the org's own GitHub App installation token does the creating.
    //
    // This used to use the signed-in user's OAuth token, on the belief that
    // GitHub forbids a server-to-server installation token from creating org
    // repositories. It does not: POST /orgs/{org}/repos is available to a
    // GitHub App holding organization `administration: write`. Going through
    // the App instead removes three failure modes that had nothing to do with
    // the product — an OAuth App unapproved under the org's third-party access
    // policy, a signed-in user who is not a member of the enforced org, and a
    // session minted before the current GITHUB_SCOPE — each of which surfaced
    // as an unexplained 403 at repository creation.
    const enforcedOrg = this.githubService.getEnforcedOrg();
    if (enforcedOrg) {
      const context =
        await this.githubService.getOrganizationProvisioningContextByLogin(
          enforcedOrg,
        );

      return {
        repositoryCreationToken: context.accessToken,
        provisioningToken: context.accessToken,
        provisioningOwnerLogin: context.ownerLogin,
      };
    }

    const ownerType = dto.ownerType ?? 'personal';

    if (ownerType === 'organization') {
      if (!dto.installationId) {
        throw new UnprocessableEntityException(
          'installationId is required when creating a repository in an organization.',
        );
      }

      const context =
        await this.githubService.getOrganizationProvisioningContext(
          userId,
          dto.installationId,
        );
      // Same reasoning as the enforced-org branch above: the selected
      // installation creates the repository as well as provisioning it. Fixed
      // together so the corrected premise cannot survive in one branch and not
      // the other.
      return {
        repositoryCreationToken: context.accessToken,
        provisioningToken: context.accessToken,
        provisioningOwnerLogin: context.ownerLogin,
      };
    }

    if (dto.installationId) {
      throw new UnprocessableEntityException(
        'installationId can only be used with an organization repository owner.',
      );
    }
    if (!oauthAccessToken) {
      throw new UnauthorizedException(
        'A GitHub OAuth token is required to create a personal repository. Sign out and sign back in with GitHub.',
      );
    }

    return {
      repositoryCreationToken: oauthAccessToken,
      provisioningToken: oauthAccessToken,
      provisioningOwnerLogin: undefined,
    };
  }
}
