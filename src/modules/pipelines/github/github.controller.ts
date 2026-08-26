import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';

import { SessionAuthGuard } from '#kernel/auth/session-auth.guard';
import { CreateRepoDto } from './dto/create-repo.dto.js';
import { LinkInstallationDto } from './dto/link-installation.dto';
import { GithubService } from './github.service';

@Controller('github')
@UseGuards(SessionAuthGuard)
export class GithubController {
  constructor(private readonly githubService: GithubService) {}

  // ─── GitHub App endpoints ───────────────────────────────────────────────

  /** GET /github/app/install-url — returns the GitHub App installation URL */
  @Get('app/install-url')
  getAppInstallUrl() {
    return {
      installUrl: this.githubService.getAppInstallUrl(),
      appSlug: this.githubService.getAppSlug(),
    };
  }

  /** POST /github/installations — link a GitHub App installation to the current user */
  @Post('installations')
  async linkInstallation(
    @Req() req: Request,
    @Body() body: LinkInstallationDto,
  ) {
    // SessionAuthGuard guarantees req.session.user is populated before this runs.
    const userId = req.session.user!.id;
    return this.githubService.linkInstallation(userId, body.installationId);
  }

  /** GET /github/installations/repos — list repos linked via GitHub App */
  @Get('installations/repos')
  async listLinkedRepos(@Req() req: Request) {
    // SessionAuthGuard guarantees req.session.user is populated before this runs.
    const userId = req.session.user!.id;
    const repos = await this.githubService.listLinkedRepos(userId);
    return { repos };
  }

  /** GET /github/installations/accounts — list GitHub App installation accounts */
  @Get('installations/accounts')
  async listInstallationAccounts(@Req() req: Request) {
    // SessionAuthGuard guarantees req.session.user is populated before this runs.
    const userId = req.session.user!.id;
    const installations =
      await this.githubService.listInstallationAccounts(userId);
    const accounts = installations.map((inst) => ({
      installationId: inst.installationId,
      accountLogin: inst.accountLogin,
      accountId: inst.accountId,
      accountType: inst.accountType,
      repositorySelection: inst.repositorySelection,
    }));
    return { accounts };
  }

  // ─── Token diagnostics ─────────────────────────────────────────────────

  /** GET /github/token-scopes — returns the scopes on the current OAuth token */
  @Get('token-scopes')
  async tokenScopes(@Req() req: Request) {
    const accessToken = req.session.githubAccessToken;
    if (!accessToken) {
      return { hasToken: false, scopes: null };
    }

    const res = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'cicd-workflow-product',
      },
    });

    const scopes =
      res.headers.get('x-oauth-scopes') ?? res.headers.get('X-OAuth-Scopes');
    return {
      hasToken: true,
      scopes: scopes ? scopes.split(',').map((s) => s.trim()) : [],
      status: res.status,
      hasRepoScope: scopes
        ? scopes
            .split(',')
            .map((s) => s.trim())
            .some((s) => s === 'repo')
        : false,
    };
  }

  // ─── OAuth repos (existing) ─────────────────────────────────────────────

  @Get('repos')
  async repos(@Req() req: Request) {
    const accessToken = req.session.githubAccessToken;
    if (!accessToken) {
      return { repos: [] };
    }

    const repos = await this.githubService.listRepos(accessToken);
    return { repos };
  }

  /** POST /github/repos — create a new GitHub repository with branch structure */
  @Post('repos')
  async createRepo(@Req() req: Request, @Body() body: CreateRepoDto) {
    const accessToken = req.session.githubAccessToken;
    if (!accessToken) {
      return {
        error:
          'GitHub access token not found. Re-authenticate via GitHub OAuth.',
      };
    }

    const { repoUrl, cloneUrl, ownerLogin, repoName } =
      await this.githubService.createRepo(accessToken, body);

    // `develop` remains available for integration work but is intentionally
    // unprotected and does not trigger generated workflows.
    const branchesCreated: string[] = ['main'];
    for (const branch of ['develop', 'uat'] as const) {
      await this.githubService.createBranch(
        accessToken,
        ownerLogin,
        repoName,
        branch,
        'main',
      );
      branchesCreated.push(branch);
    }

    for (const branch of ['uat', 'main'] as const) {
      await this.githubService.applyBranchProtection(
        accessToken,
        ownerLogin,
        repoName,
        branch,
      );
    }

    return {
      repoUrl,
      cloneUrl,
      defaultBranch: 'main',
      branchesCreated,
    };
  }
}
