import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '#kernel/config/app.config';
import {
  GITHUB_PROJECT_PORT,
  type GithubProjectPort,
} from '#kernel/ports/github.port';

export type SonarProjectDeleteResult =
  | { status: 'deleted' | 'not_found'; sonarProjectKey: string }
  | { status: 'failed'; sonarProjectKey: string; message: string };

/**
 * Installs the SonarCloud secrets this product's Quality stage reads.
 *
 * `preserveExisting` is for ONBOARDING an existing repository. A repo that
 * already uses SonarCloud has its own SONAR_TOKEN and SONAR_PROJECT_KEY
 * pointing at its own project with its own history; silently replacing them
 * would redirect analysis to a new key and is not undoable from this UI. On
 * a repository this product just created there is nothing to preserve, so
 * that path keeps overwriting.
 */
@Injectable()
export class SonarCloudSetupService {
  private readonly logger = new Logger(SonarCloudSetupService.name);

  constructor(
    @Inject(GITHUB_PROJECT_PORT)
    private readonly githubService: GithubProjectPort,
    private readonly configService: ConfigService,
  ) {}

  async installSecrets(
    accessToken: string,
    owner: string,
    repo: string,
    preserveExisting = false,
  ): Promise<void> {
    const managed =
      this.configService?.getOrThrow<AppConfig>('app')?.envProvisioning
        ?.flowciManaged;
    const sonarToken = managed?.sonarToken?.trim();
    const sonarOrganization = managed?.sonarOrganization?.trim();
    if (!sonarToken || !sonarOrganization) {
      this.logger.warn(
        `SonarCloud secrets not installed for ${owner}/${repo}: ALPHACI_SONAR_TOKEN / ALPHACI_SONAR_ORGANIZATION are not configured`,
      );
      return;
    }

    const existingSecrets = preserveExisting
      ? await this.githubService.listActionsSecretNames(
          accessToken,
          owner,
          repo,
        )
      : new Set<string>();

    const alreadyConfigured = ['SONAR_TOKEN', 'SONAR_PROJECT_KEY'].some(
      (name) => existingSecrets.has(name),
    );

    if (alreadyConfigured) {
      this.logger.log(
        `SonarCloud secrets left untouched for ${owner}/${repo}: the repository already defines its own.`,
      );
      return;
    }

    // SonarCloud's GitHub-import convention for project keys is `${owner}_${repo}`.
    const sonarProjectKey = sonarProjectKeyFor(owner, repo);
    await this.ensureSonarCloudProject({
      sonarToken,
      sonarOrganization,
      sonarProjectKey,
      projectName: repo,
      repoFullName: `${owner}/${repo}`,
    });
    await this.githubService.setActionsSecret(
      accessToken,
      owner,
      repo,
      'SONAR_TOKEN',
      sonarToken,
    );
    await this.githubService.setActionsSecret(
      accessToken,
      owner,
      repo,
      'SONAR_ORGANIZATION',
      sonarOrganization,
    );
    await this.githubService.setActionsSecret(
      accessToken,
      owner,
      repo,
      'SONAR_PROJECT_KEY',
      sonarProjectKey,
    );
  }

  /**
   * Deletes the SonarCloud project this product created for a repository.
   *
   * Scoped to the managed organization: the key is looked up there first, so
   * a repository that brought its own SonarCloud project (same key convention,
   * different organization) is reported as absent rather than touched.
   */
  async deleteProject(
    owner: string,
    repo: string,
  ): Promise<SonarProjectDeleteResult> {
    const managed =
      this.configService?.getOrThrow<AppConfig>('app')?.envProvisioning
        ?.flowciManaged;
    const sonarToken = managed?.sonarToken?.trim();
    const sonarOrganization = managed?.sonarOrganization?.trim();
    const sonarProjectKey = sonarProjectKeyFor(owner, repo);
    if (!sonarToken || !sonarOrganization) {
      return {
        status: 'failed',
        sonarProjectKey,
        message:
          'ALPHACI_SONAR_TOKEN / ALPHACI_SONAR_ORGANIZATION are not configured.',
      };
    }

    const headers = {
      Authorization: `Basic ${Buffer.from(`${sonarToken}:`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    };

    try {
      const search = await fetch(
        `https://sonarcloud.io/api/projects/search?${new URLSearchParams({
          organization: sonarOrganization,
          projects: sonarProjectKey,
        }).toString()}`,
        { headers },
      );
      if (!search.ok) {
        return {
          status: 'failed',
          sonarProjectKey,
          message: `SonarCloud project lookup failed (${String(search.status)}): ${(await search.text()).slice(0, 300)}`,
        };
      }
      const found = (await search.json()) as {
        components?: Array<{ key?: string }>;
      };
      if (!found.components?.some((c) => c.key === sonarProjectKey)) {
        return { status: 'not_found', sonarProjectKey };
      }

      const response = await fetch(
        'https://sonarcloud.io/api/projects/delete',
        {
          method: 'POST',
          headers,
          body: new URLSearchParams({ project: sonarProjectKey }),
        },
      );
      if (response.ok || response.status === 404) {
        this.logger.log(
          `SonarCloud project deleted for ${owner}/${repo} (${sonarProjectKey})`,
        );
        return { status: 'deleted', sonarProjectKey };
      }
      return {
        status: 'failed',
        sonarProjectKey,
        message: `SonarCloud project delete failed (${String(response.status)}): ${(await response.text()).slice(0, 300)}`,
      };
    } catch (error) {
      return {
        status: 'failed',
        sonarProjectKey,
        message: `SonarCloud project delete failed: ${String(error)}`,
      };
    }
  }

  private async ensureSonarCloudProject(input: {
    sonarToken: string;
    sonarOrganization: string;
    sonarProjectKey: string;
    projectName: string;
    repoFullName: string;
  }): Promise<void> {
    try {
      const body = new URLSearchParams({
        organization: input.sonarOrganization,
        project: input.sonarProjectKey,
        name: input.projectName,
      });
      const response = await fetch(
        'https://sonarcloud.io/api/projects/create',
        {
          method: 'POST',
          headers: {
            Authorization: `Basic ${Buffer.from(
              `${input.sonarToken}:`,
            ).toString('base64')}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body,
        },
      );

      if (response.ok) {
        this.logger.log(
          `SonarCloud project ensured for ${input.repoFullName} (${input.sonarProjectKey})`,
        );
        return;
      }

      const responseBody = await response.text();
      if (response.status === 400 && /already|exist|key/i.test(responseBody)) {
        this.logger.log(
          `SonarCloud project already exists for ${input.repoFullName} (${input.sonarProjectKey})`,
        );
        return;
      }

      this.logger.warn(
        `SonarCloud project was not created for ${input.repoFullName} (${String(response.status)}): ${responseBody.slice(0, 500)}`,
      );
    } catch (error) {
      this.logger.warn(
        `SonarCloud project was not created for ${input.repoFullName}: ${String(error)}`,
      );
    } finally {
      await this.ensureSonarCloudProjectLink(input);
    }
  }

  private async ensureSonarCloudProjectLink(input: {
    sonarToken: string;
    sonarProjectKey: string;
    repoFullName: string;
  }): Promise<void> {
    try {
      const body = new URLSearchParams({
        projectKey: input.sonarProjectKey,
        name: 'GitHub',
        url: `https://github.com/${input.repoFullName}`,
      });
      const response = await fetch(
        'https://sonarcloud.io/api/project_links/create',
        {
          method: 'POST',
          headers: {
            Authorization: `Basic ${Buffer.from(
              `${input.sonarToken}:`,
            ).toString('base64')}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body,
        },
      );

      if (response.ok) {
        return;
      }

      const responseBody = await response.text();
      if (
        response.status === 400 &&
        /already|exist|duplicate/i.test(responseBody)
      ) {
        return;
      }

      this.logger.warn(
        `SonarCloud GitHub link was not created for ${input.repoFullName} (${String(response.status)}): ${responseBody.slice(0, 500)}`,
      );
    } catch (error) {
      this.logger.warn(
        `SonarCloud GitHub link was not created for ${input.repoFullName}: ${String(error)}`,
      );
    }
  }
}

export function sonarProjectKeyFor(owner: string, repo: string): string {
  return `${owner}_${repo}`;
}
