import { BadGatewayException, type Logger } from '@nestjs/common';

import type { GithubHttp } from './github-http';
import type { GithubInstallationsRepository } from './github-installations.repository';

interface GitHubInstallationMetadataResponse {
  account?: {
    login?: string | null;
    id?: number | null;
    type?: 'Organization' | 'User' | null;
  };
  repository_selection?: 'all' | 'selected';
}

interface GitHubInstallationRepositoriesResponse {
  repositories?: Array<{ full_name?: string }>;
}

export interface GithubInstallationLinkerDeps {
  logger: Logger;
  http: GithubHttp;
  installations: GithubInstallationsRepository | null;
  createAppJwt(): string;
  createInstallationAccessToken(installationId: number): Promise<string>;
}

export class GithubInstallationLinker {
  constructor(private readonly deps: GithubInstallationLinkerDeps) {}

  async linkInstallation(
    userId: string,
    installationId: number,
  ): Promise<{ reposLinked: number; repositorySelection: 'all' | 'selected' }> {
    let reposLinked = 0;
    let repositorySelection: 'all' | 'selected' = 'selected';
    let accountLogin: string | null = null;
    let accountId: number | null = null;
    let accountType: 'Organization' | 'User' | null = null;
    let repoFullNames: string[] = [];

    try {
      const metadata = await this.fetchInstallationMetadata(installationId);
      accountLogin = metadata.account?.login ?? null;
      accountId = metadata.account?.id ?? null;
      accountType = metadata.account?.type ?? null;
      repositorySelection = metadata.repository_selection ?? 'selected';

      const installationToken =
        await this.deps.createInstallationAccessToken(installationId);
      repoFullNames =
        await this.fetchInstallationRepositories(installationToken);
      reposLinked = repoFullNames.length;
    } catch (error) {
      this.deps.logger.warn(
        `Could not fully inspect installation ${installationId}: ${(error as Error).message}`,
      );
    }

    if (this.deps.installations) {
      try {
        const saved = await this.deps.installations.upsert(
          userId,
          installationId,
          accountLogin,
          accountId,
          accountType,
          repositorySelection,
          reposLinked,
        );

        if (repoFullNames.length > 0) {
          await this.deps.installations.replaceRepos(
            installationId,
            repoFullNames,
          );
        }

        reposLinked = saved.reposLinked;
        repositorySelection = saved.repositorySelection;
      } catch (error) {
        this.deps.logger.warn(
          `Could not persist installation ${installationId}: ${(error as Error).message}`,
        );
      }
    }

    return { reposLinked, repositorySelection };
  }

  async fetchInstallationRepositories(accessToken: string): Promise<string[]> {
    const response = await this.deps.http.fetchWithRetry(
      'https://api.github.com/installation/repositories?per_page=100',
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'cicd-workflow-product',
        },
      },
    );

    if (!response.ok) {
      const body = await response.text();
      throw new BadGatewayException(
        `GitHub installation repositories request failed (${String(response.status)}): ${body}`,
      );
    }

    const payload =
      (await response.json()) as GitHubInstallationRepositoriesResponse;
    return (payload.repositories ?? [])
      .map((repo) => repo.full_name)
      .filter((repoFullName): repoFullName is string => Boolean(repoFullName));
  }

  private async fetchInstallationMetadata(
    installationId: number,
  ): Promise<GitHubInstallationMetadataResponse> {
    const response = await this.deps.http.fetchWithRetry(
      `https://api.github.com/app/installations/${String(installationId)}`,
      {
        headers: {
          Authorization: `Bearer ${this.deps.createAppJwt()}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'cicd-workflow-product',
        },
      },
    );

    if (!response.ok) {
      const body = await response.text();
      throw new BadGatewayException(
        `GitHub installation metadata request failed (${String(response.status)}): ${body}`,
      );
    }

    return (await response.json()) as GitHubInstallationMetadataResponse;
  }
}
