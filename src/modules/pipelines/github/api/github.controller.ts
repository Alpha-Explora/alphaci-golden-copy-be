import {
  Body,
  Controller,
  Get,
  Inject,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';

import { SessionAuthGuard } from '#kernel/auth/session-auth.guard';
import {
  APP_ROLE_LOOKUP,
  type AppRoleLookup,
} from '#kernel/ports/app-role.port';
import {
  projectRequired,
  repositoryCreateForbidden,
} from '#kernel/rules/persona-access.errors';
import {
  canCreateRepository,
  repositoryCreateRequiresProject,
} from '#kernel/rules/persona-access.rules';
import { CreateRepoDto } from './dto/create-repo.dto.js';
import { LinkInstallationDto } from './dto/link-installation.dto';
import { GithubService } from '../infrastructure/github.service';
import {
  BRANCHES_CREATED_ON_PROVISION,
  DEFAULT_BRANCH,
  PROTECTED_BRANCHES,
} from '#kernel/config/pipeline-branches';

@Controller('github')
@UseGuards(SessionAuthGuard)
export class GithubController {
  constructor(
    private readonly githubService: GithubService,
    // Required (not @Optional): the creator gate must never silently vanish.
    @Inject(APP_ROLE_LOOKUP)
    private readonly appRoleLookup: AppRoleLookup,
  ) {}

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
    // The caller's own OAuth token must be able to see the installation;
    // the App's credentials alone would accept any installation id.
    return this.githubService.linkInstallationForUser(
      userId,
      body.installationId,
      req.session.githubAccessToken,
    );
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
    // Creating a bare repository has no Project to file it under, so only an
    // admin may do it; Developers create repositories inside a Project and
    // Product owners create Projects. Unresolved role -> 'qa' (least
    // privileged): refused, fail closed.
    const role =
      (await this.appRoleLookup.findAppRole(req.session.user!.id)) ?? 'qa';
    if (!canCreateRepository(role)) {
      throw repositoryCreateForbidden();
    }
    if (repositoryCreateRequiresProject(role)) {
      throw projectRequired();
    }

    const accessToken = req.session.githubAccessToken;
    if (!accessToken) {
      return {
        error:
          'GitHub access token not found. Re-authenticate via GitHub OAuth.',
      };
    }

    const { repoUrl, cloneUrl, ownerLogin, repoName } =
      await this.githubService.createRepo(accessToken, body);

    // dev is where developers push and is intentionally unprotected; uat and
    // main are reached by promotion. Both lists come from the branch model so
    // they cannot drift from the triggers the generated workflows carry.
    const branchesCreated: string[] = [DEFAULT_BRANCH];
    for (const branch of BRANCHES_CREATED_ON_PROVISION) {
      await this.githubService.createBranch(
        accessToken,
        ownerLogin,
        repoName,
        branch,
        'main',
      );
      branchesCreated.push(branch);
    }

    for (const branch of PROTECTED_BRANCHES) {
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
