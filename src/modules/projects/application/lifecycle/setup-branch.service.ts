import { Inject, Injectable, Logger } from '@nestjs/common';

import {
  GITHUB_PROJECT_PORT,
  type GithubProjectPort,
} from '#kernel/ports/github.port';

/**
 * Setup-flow GitHub helpers for onboarding an existing repository.
 *
 * Extracted verbatim from ProjectsService: default-branch resolution, uat
 * branch creation, and best-effort secret cleanup after a failed setup.
 */
@Injectable()
export class SetupBranchService {
  private readonly logger = new Logger(SetupBranchService.name);

  constructor(
    @Inject(GITHUB_PROJECT_PORT)
    private readonly githubService: GithubProjectPort,
  ) {}
  /**
   * The branch an onboarded repository's workflows belong on.
   *
   * Asks GitHub for the repository's own default branch and falls back to
   * 'main' only when that cannot be read — a fallback, never an assumption.
   */
  async resolveSetupBranch(
    accessToken: string,
    owner: string,
    repo: string,
  ): Promise<string> {
    try {
      const repository = await this.githubService.getRepo(
        accessToken,
        owner,
        repo,
      );
      const branch = repository.defaultBranch?.trim();
      if (branch) return branch;
    } catch (error) {
      this.logger.warn(
        `setupProject: could not read the default branch for ${owner}/${repo}, assuming 'main': ${String(error)}`,
      );
    }
    return 'main';
  }

  /**
   * Creates `uat` from the repository's default branch when it is missing.
   *
   * Best-effort by design. A repository that cannot take the branch — no
   * permission, a protection rule, a name already used by a tag — still ends
   * up with a working default-branch pipeline, and failing the whole
   * onboarding over the staging half would be the worse trade.
   */
  async ensureUatBranch(
    accessToken: string,
    owner: string,
    repo: string,
    fromBranch: string,
  ): Promise<void> {
    try {
      if (
        await this.githubService.branchExists(accessToken, owner, repo, 'uat')
      ) {
        return;
      }
      await this.githubService.createBranch(
        accessToken,
        owner,
        repo,
        'uat',
        fromBranch,
      );
      this.logger.log(
        `setupProject: created uat from ${fromBranch} on ${owner}/${repo}`,
      );
    } catch (error) {
      this.logger.warn(
        `setupProject: could not create uat on ${owner}/${repo}; the staging half of the pipeline will not run until it exists: ${String(error)}`,
      );
    }
  }

  /**
   * Undoes the secrets written during a failed setup.
   *
   * Only ever removes the two secrets THIS product owns. SONAR_* is deliberately
   * excluded: installSonarSecrets leaves a repository's own Sonar configuration
   * alone, so deleting those here could destroy something we never wrote.
   *
   * Never throws — this runs inside a catch block, and losing the original
   * error to a cleanup failure would hide the reason setup failed.
   */
  async removeSetupSecrets(
    accessToken: string,
    owner: string,
    repo: string,
  ): Promise<void> {
    for (const name of ['ALPHACI_TOKEN', 'ALPHACI_REPORT_URL']) {
      try {
        await this.githubService.deleteActionsSecret(
          accessToken,
          owner,
          repo,
          name,
        );
      } catch (error) {
        this.logger.warn(
          `setupProject: could not remove ${name} from ${owner}/${repo} after a failed setup: ${String(error)}`,
        );
      }
    }
  }
}
