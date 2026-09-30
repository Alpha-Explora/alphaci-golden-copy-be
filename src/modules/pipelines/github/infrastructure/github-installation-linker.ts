import {
  BadGatewayException,
  ForbiddenException,
  UnauthorizedException,
  type Logger,
} from '@nestjs/common';

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

  /**
   * Proves the SIGNED-IN USER is entitled to `installationId`, using only what
   * an OAuth App token can do (GET /user/installations rejects OAuth App
   * tokens). The App JWT reads the installation's account; then:
   *   - account.type 'User': the caller's login (GET /user) must equal
   *     account.login, case-insensitively;
   *   - account.type 'Organization': GET /user/memberships/orgs/{login} must
   *     return state 'active' (needs read:org).
   * The App-level calls in linkInstallation succeed for ANY installation id,
   * so without this a caller could link another tenant's installation by id.
   *
   * 401: no token, or GitHub rejects it. 502: GitHub 5xx. 403
   * INSTALLATION_NOT_ACCESSIBLE: everything else, including unreadable
   * metadata or an unknown account/type (fail closed). Nothing is linked by
   * this method either way.
   */
  async assertInstallationAccessibleToUser(
    installationId: number,
    githubAccessToken: string | null | undefined,
  ): Promise<void> {
    if (!githubAccessToken) {
      throw new UnauthorizedException(
        'GitHub access token not found. Re-authenticate via GitHub OAuth.',
      );
    }

    const metadataResponse = await this.deps.http.fetchWithRetry(
      `https://api.github.com/app/installations/${String(installationId)}`,
      {
        headers: {
          Authorization: `Bearer ${this.deps.createAppJwt()}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'cicd-workflow-product',
        },
      },
    );
    this.throwIfGithubFailure(metadataResponse.status);
    if (!metadataResponse.ok) throw this.installationNotAccessible();
    const account = (
      (await metadataResponse.json()) as GitHubInstallationMetadataResponse
    ).account;
    const accountLogin = account?.login?.trim();
    if (!accountLogin || !account?.type) throw this.installationNotAccessible();

    if (account.type === 'User') {
      const userResponse = await this.userGet(githubAccessToken, '/user');
      this.throwIfGithubFailure(userResponse.status);
      if (!userResponse.ok) throw this.installationNotAccessible();
      const login = ((await userResponse.json()) as { login?: string }).login;
      if (!login || login.toLowerCase() !== accountLogin.toLowerCase()) {
        throw this.installationNotAccessible();
      }
      return;
    }

    if (account.type === 'Organization') {
      const membership = await this.userGet(
        githubAccessToken,
        `/user/memberships/orgs/${encodeURIComponent(accountLogin)}`,
      );
      this.throwIfGithubFailure(membership.status);
      if (!membership.ok) throw this.installationNotAccessible();
      const state = ((await membership.json()) as { state?: string }).state;
      if (state !== 'active') throw this.installationNotAccessible();
      return;
    }

    throw this.installationNotAccessible();
  }

  private userGet(accessToken: string, path: string) {
    return this.deps.http.fetchWithRetry(`https://api.github.com${path}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'cicd-workflow-product',
      },
    });
  }

  /** 401 -> sign in again; 5xx -> gateway error. Other failures are the caller's to map. */
  private throwIfGithubFailure(status: number | undefined): void {
    if (status === 401) {
      throw new UnauthorizedException(
        'GitHub rejected your sign-in. Re-authenticate via GitHub OAuth.',
      );
    }
    if (status !== undefined && status >= 500) {
      throw new BadGatewayException(
        `GitHub request failed (${String(status)})`,
      );
    }
  }

  private installationNotAccessible(): ForbiddenException {
    return new ForbiddenException({
      statusCode: 403,
      error: 'Forbidden',
      code: 'INSTALLATION_NOT_ACCESSIBLE',
      message:
        'That GitHub App installation is not accessible to your GitHub account.',
    });
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
