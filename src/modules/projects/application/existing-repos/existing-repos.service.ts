import { readFile } from 'node:fs/promises';

import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import yaml from 'js-yaml';

import { CatalogService } from '../catalog/catalog.service';
import {
  GITHUB_PROJECT_PORT,
  type GithubProjectPort,
} from '#kernel/ports/github.port';
import { QA_BRANCH, WORKING_BRANCH } from '#kernel/config/pipeline-branches';
import {
  APP_ROLE_LOOKUP,
  type AppRoleLookup,
} from '#kernel/ports/app-role.port';
import {
  canCreatePullRequest,
  canManageProjectLifecycle,
  selfServicePullRequestBase,
} from '#kernel/rules/persona-access.rules';
import type { DiscoverExistingRepoDto } from './dto/discover-existing-repo.dto';
import type { SetupExistingRepoPrDto } from './dto/setup-existing-repo-pr.dto';

export type ExistingRepoWarningCode =
  | 'branch_protected'
  | 'sonar_already_configured'
  | 'uat_missing'
  | 'project_type_undetected';

export interface ExistingRepoWarning {
  code: ExistingRepoWarningCode;
  message: string;
}

export interface ExistingRepoDiscoveryResponse {
  repoFullName: string;
  /** The repository's OWN default branch — not an assumption. */
  baseBranch: string;
  detectedProjectTypeId: string | null;
  recommendedWorkflowRecipeId: string;
  serviceName: string;
  servicePath: string;
  /**
   * What setup will do, and what it cannot do, said BEFORE anything is
   * written. Onboarding commits to the repository and installs secrets; a
   * person deserves to know that a protected branch will reject the push, or
   * that their SonarCloud config will be left alone, while they can still
   * change their mind.
   */
  warnings: ExistingRepoWarning[];
}

export interface ExistingRepoSetupPullRequestResponse {
  repoFullName: string;
  branchName: string;
  workflowPath: string;
  pullRequestNumber: number;
  pullRequestUrl: string;
}

@Injectable()
export class ExistingReposService {
  constructor(
    @Inject(GITHUB_PROJECT_PORT)
    private readonly githubService: GithubProjectPort,
    private readonly catalogService: CatalogService,
    // Required (not @Optional): the creator gate must never silently vanish.
    @Inject(APP_ROLE_LOOKUP)
    private readonly appRoleLookup: AppRoleLookup,
  ) {}

  async discover(
    userId: string,
    oauthAccessToken: string | null | undefined,
    dto: DiscoverExistingRepoDto,
  ): Promise<ExistingRepoDiscoveryResponse> {
    await this.assertCanOnboard(userId);
    const [owner, repo] = this.parseRepoFullName(dto.repoFullName);
    // The installation token below can read every repository the App is
    // installed on; it must only ever be used for one the CALLER can read.
    const callerRepo = await this.assertCallerCanReadRepo(
      oauthAccessToken,
      owner,
      repo,
    );
    const token = await this.resolveProvisioningToken(
      userId,
      oauthAccessToken,
      dto.repoFullName,
    );
    /*
     * Ask the repository which branch it lives on. A caller may still override
     * it, but 'main' is no longer assumed — the whole reason onboarding used to
     * fail on `master` repositories.
     */
    const baseBranch =
      dto.baseBranch ?? (callerRepo.defaultBranch?.trim() || 'main');
    const packageJson = await this.githubService.getFileContent(
      token,
      owner,
      repo,
      'package.json',
      baseBranch,
    );
    const detectedProjectTypeId = this.detectProjectType(packageJson);
    const warnings = await this.preflight(
      token,
      owner,
      repo,
      baseBranch,
      detectedProjectTypeId,
    );

    return {
      repoFullName: dto.repoFullName,
      baseBranch,
      detectedProjectTypeId,
      recommendedWorkflowRecipeId: 'standard',
      serviceName: repo,
      servicePath: '.',
      warnings,
    };
  }

  /**
   * Everything setup is about to do that the person should know first.
   *
   * Read-only. Each check degrades to silence rather than to a false alarm: a
   * protection state we cannot read is reported as nothing at all, because a
   * preflight that invents blockers is worse than one that misses them.
   */
  private async preflight(
    token: string,
    owner: string,
    repo: string,
    baseBranch: string,
    detectedProjectTypeId: string | null,
  ): Promise<ExistingRepoWarning[]> {
    const warnings: ExistingRepoWarning[] = [];

    const protectedBranch = await this.githubService.requiresPullRequestToPush(
      token,
      owner,
      repo,
      baseBranch,
    );
    if (protectedBranch === true) {
      warnings.push({
        code: 'branch_protected',
        message: `'${baseBranch}' requires pull request reviews, so ALPHACI cannot commit the workflow files directly. Relax the rule for this push, or add the workflows through a pull request.`,
      });
    }

    const secrets = await this.githubService.listActionsSecretNames(
      token,
      owner,
      repo,
    );
    if (secrets.has('SONAR_TOKEN') || secrets.has('SONAR_PROJECT_KEY')) {
      warnings.push({
        code: 'sonar_already_configured',
        message:
          'This repository already has SonarCloud secrets. They will be left exactly as they are, and the ALPHACI quality stage will use them.',
      });
    }

    if (!(await this.githubService.branchExists(token, owner, repo, 'uat'))) {
      warnings.push({
        code: 'uat_missing',
        message: `There is no 'uat' branch yet. ALPHACI will create one from '${baseBranch}' so the staging and promotion stages have somewhere to run.`,
      });
    }

    if (!detectedProjectTypeId) {
      warnings.push({
        code: 'project_type_undetected',
        message:
          'No package.json was found on this branch, so the stack could not be detected. Choose the language and framework yourself before setting up.',
      });
    }

    return warnings;
  }

  async setupPullRequest(
    userId: string,
    oauthAccessToken: string | null | undefined,
    dto: SetupExistingRepoPrDto,
  ): Promise<ExistingRepoSetupPullRequestResponse> {
    const role = await this.assertCanOnboard(userId);
    const [owner, repo] = this.parseRepoFullName(dto.repoFullName);
    // Refuse main before any GitHub call: main is reached only by promotion.
    if (
      dto.baseBranch &&
      !canCreatePullRequest(
        role,
        dto.baseBranch,
        `alphaci/${this.sanitizeBranchSlug(dto.serviceName)}-ci`,
      )
    ) {
      throw this.mainPrRestricted();
    }
    await this.assertCallerCanReadRepo(oauthAccessToken, owner, repo);
    const token = await this.resolveProvisioningToken(
      userId,
      oauthAccessToken,
      dto.repoFullName,
    );
    const baseBranch =
      dto.baseBranch ?? (await this.defaultPullRequestBase(token, owner, repo));
    const workflowRecipeId = dto.workflowRecipeId ?? 'standard';
    const templateId = this.resolveTemplateId(
      dto.projectTypeId,
      workflowRecipeId,
    );
    const { generatedYaml, outputFileName } = await this.buildWorkflowYaml(
      templateId,
      dto.serviceName,
      dto.servicePath,
      dto.nodeVersion,
      dto.coverageThreshold,
      dto.outputFileName,
    );
    const branchName = `alphaci/${this.sanitizeBranchSlug(dto.serviceName)}-ci`;
    const workflowPath = `.github/workflows/${outputFileName}`;

    await this.githubService.createBranch(
      token,
      owner,
      repo,
      branchName,
      baseBranch,
    );
    await this.githubService.putFileContent(
      token,
      owner,
      repo,
      workflowPath,
      generatedYaml,
      branchName,
      'ci: add ALPHACI workflow',
    );
    const pullRequest = await this.githubService.createPullRequest(
      token,
      owner,
      repo,
      {
        title: 'Add ALPHACI workflow',
        head: branchName,
        base: baseBranch,
        body: [
          'This PR adds an ALPHACI workflow for this existing repository.',
          '',
          `Service: ${dto.serviceName}`,
          `Workflow: ${workflowPath}`,
        ].join('\n'),
      },
    );

    return {
      repoFullName: dto.repoFullName,
      branchName,
      workflowPath,
      pullRequestNumber: pullRequest.number,
      pullRequestUrl: pullRequest.htmlUrl,
    };
  }

  /**
   * Onboarding an existing repository installs CI on it with the App's
   * installation token, so it is a Lead/Admin action: the same global
   * app_role gate as project creation (WorkspaceGateService.
   * assertCanCreateProjects / isGlobalProjectCreator). Returns the role so
   * callers can apply the pull-request rule; an unresolved role falls back to
   * 'member' and is refused (fail closed).
   */
  private async assertCanOnboard(userId: string) {
    const role = (await this.appRoleLookup.findAppRole(userId)) ?? 'member';
    if (!canManageProjectLifecycle(role)) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        code: 'PROJECT_ROLE_FORBIDDEN',
        message:
          'Only a Lead or Admin can onboard an existing repository. Ask a team lead to do it for you.',
      });
    }
    return role;
  }

  private mainPrRestricted(): ForbiddenException {
    return new ForbiddenException({
      statusCode: 403,
      error: 'Forbidden',
      code: 'MAIN_PR_RESTRICTED',
      message:
        'Pull requests into main are opened only by the promotion flow. Target dev instead.',
    });
  }

  /**
   * Proves the SIGNED-IN USER can read the repository with their own OAuth
   * token before the (broader) installation token is used on it. Fail closed:
   * no OAuth token is 401; a repository GitHub will not show that token is 403
   * REPO_NOT_ACCESSIBLE (404 and 403 from GitHub look the same to the caller,
   * so the answer does not confirm the repository exists).
   */
  private async assertCallerCanReadRepo(
    oauthAccessToken: string | null | undefined,
    owner: string,
    repo: string,
  ) {
    if (!oauthAccessToken) {
      throw new UnauthorizedException(
        'GitHub access token not found. Re-authenticate via GitHub OAuth.',
      );
    }
    try {
      return await this.githubService.getRepo(oauthAccessToken, owner, repo);
    } catch (error) {
      const status = /\((\d{3})\)/.exec(
        error instanceof Error ? error.message : '',
      )?.[1];
      if (status === '401') {
        throw new UnauthorizedException(
          'GitHub rejected your sign-in. Re-authenticate via GitHub OAuth.',
        );
      }
      if (status === '403' || status === '404') {
        throw new ForbiddenException({
          statusCode: 403,
          error: 'Forbidden',
          code: 'REPO_NOT_ACCESSIBLE',
          message: 'That repository is not accessible to your GitHub account.',
        });
      }
      throw error;
    }
  }

  /**
   * dev, else uat; never main. Neither present is a 409 rather than a silent
   * fall back to the production branch.
   */
  private async defaultPullRequestBase(
    token: string,
    owner: string,
    repo: string,
  ): Promise<string> {
    const existing: string[] = [];
    for (const candidate of [WORKING_BRANCH, QA_BRANCH]) {
      if (
        await this.githubService.branchExists(token, owner, repo, candidate)
      ) {
        existing.push(candidate);
      }
    }
    const base = selfServicePullRequestBase(existing);
    if (!base) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: 'PR_BASE_BRANCH_MISSING',
        message:
          "This repository has no 'dev' or 'uat' branch to open the setup pull request against. Create one first.",
      });
    }
    return base;
  }

  private async resolveProvisioningToken(
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

  private parseRepoFullName(repoFullName: string): [string, string] {
    const parts = repoFullName.split('/');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new UnprocessableEntityException(
        `Invalid repoFullName '${repoFullName}'. Expected format: "owner/repo"`,
      );
    }

    return [parts[0], parts[1]];
  }

  private detectProjectType(packageJsonRaw: string | null): string | null {
    if (!packageJsonRaw) {
      return null;
    }

    let parsed: {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    try {
      parsed = JSON.parse(packageJsonRaw) as typeof parsed;
    } catch {
      return null;
    }

    const dependencies = {
      ...(parsed.dependencies ?? {}),
      ...(parsed.devDependencies ?? {}),
    };

    if (dependencies.next) return 'nextjs';
    if (dependencies['@nestjs/core']) return 'nestjs';
    if (dependencies.react) return 'react';
    if (dependencies.express || dependencies.fastify) return 'nodejs';

    return null;
  }

  private resolveTemplateId(
    projectTypeId: string,
    workflowRecipeId: string,
  ): string {
    const { recipes } = this.catalogService.getProjectOptions();
    const recipe = recipes.find((item) => item.id === workflowRecipeId);
    const mapped = recipe?.templateByProjectType[projectTypeId];
    return mapped ?? `${projectTypeId}-${workflowRecipeId}`;
  }

  private async buildWorkflowYaml(
    templateId: string,
    serviceName: string,
    servicePath?: string,
    nodeVersion?: string,
    coverageThreshold?: number,
    customOutputFileName?: string,
  ): Promise<{ generatedYaml: string; outputFileName: string }> {
    const template = await this.catalogService.getTemplateById(templateId);
    if (!template) {
      throw new NotFoundException(`Template '${templateId}' not found`);
    }

    const source = await readFile(template.workflowPath, 'utf8');
    const parsed = yaml.load(source, { schema: yaml.DEFAULT_SCHEMA }) as Record<
      string,
      unknown
    > | null;

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new UnprocessableEntityException(
        'Workflow template could not be parsed',
      );
    }

    parsed.name = `${serviceName} - ${template.name}`;

    const onConfig = this.ensureObject(parsed, 'on');
    const dispatchConfig = this.ensureObject(onConfig, 'workflow_dispatch');
    const inputConfig = this.ensureObject(dispatchConfig, 'inputs');

    this.setInputDefault(inputConfig, 'service_name', serviceName, 'string');
    if (servicePath !== undefined) {
      this.setInputDefault(inputConfig, 'service_path', servicePath, 'string');
    }
    if (nodeVersion !== undefined) {
      this.setInputDefault(inputConfig, 'node_version', nodeVersion, 'string');
    }
    if (coverageThreshold !== undefined) {
      this.setInputDefault(
        inputConfig,
        'coverage_threshold',
        coverageThreshold,
        'number',
      );
    }

    return {
      generatedYaml: yaml.dump(parsed, {
        lineWidth: -1,
        noRefs: true,
        sortKeys: false,
      }),
      outputFileName:
        customOutputFileName ??
        this.deriveOutputFileName(serviceName, templateId),
    };
  }

  private ensureObject(
    parent: Record<string, unknown>,
    key: string,
  ): Record<string, unknown> {
    const existing = parent[key];
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
      const next: Record<string, unknown> = {};
      parent[key] = next;
      return next;
    }

    return existing as Record<string, unknown>;
  }

  private setInputDefault(
    inputs: Record<string, unknown>,
    key: string,
    value: string | number,
    type: 'string' | 'number',
  ): void {
    const existing = inputs[key];
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
      inputs[key] = {
        description: `Auto-generated default for ${key}`,
        required: false,
        type,
        default: value,
      };
      return;
    }

    const record = existing as Record<string, unknown>;
    record.default = value;
    if (!record.type) {
      record.type = type;
    }
  }

  private deriveOutputFileName(
    serviceName: string,
    templateId: string,
  ): string {
    return `${this.sanitizeBranchSlug(serviceName) || 'service'}-${templateId}.yml`;
  }

  private sanitizeBranchSlug(value: string): string {
    return value
      .toLowerCase()
      .replaceAll(/[^a-z0-9-]+/g, '-')
      .replaceAll(/^-+|-+$/g, '');
  }
}
