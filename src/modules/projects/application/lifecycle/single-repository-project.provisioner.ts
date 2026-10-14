import { Logger, UnprocessableEntityException } from '@nestjs/common';

import { ALPHACI_API_URL, ALPHACI_REPORT_URL } from '../workflows/index';
import { resolveDeploymentWorkflowTargets } from '../workflows/deployment-workflow-targets';
import { workflowFileMetadata } from '../dashboard/project-overview.view';
import {
  extractDeploymentProvider,
  resolveSingleRepoDeploymentSlots,
  withDefaultCreateDeploymentProvisioning,
  withRepoShapeRootDirectory,
} from '../../domain/deployment-provisioning.policy';
import { normalizeRepoShape } from '../../scaffold.builder';
import type { CreateProjectDto } from '../../api/dto/create-project.dto';
import type { SetupProjectDto } from '../../api/dto/setup-project.dto';
import type {
  CreateProjectResponse,
  SetupProjectResponse,
} from './projects.service.types';
import type { ProvisionedProjectRow } from '../../infrastructure/projects.repository';
import {
  newChainLinkOptions,
  type ProjectProvisioningSupport,
} from './project-provisioning.support';
import {
  BRANCHES_CREATED_ON_PROVISION,
  PROVISIONED_BRANCHES,
} from '#kernel/config/pipeline-branches';

export class SingleRepositoryProjectProvisioner {
  private readonly logger = new Logger(SingleRepositoryProjectProvisioner.name);

  constructor(private readonly support: ProjectProvisioningSupport) {}

  async createStandaloneProject(
    userId: string,
    userLogin: string,
    repositoryCreationToken: string,
    provisioningToken: string,
    provisioningOwnerLogin: string | undefined,
    dto: CreateProjectDto,
  ): Promise<CreateProjectResponse> {
    const repoShape = normalizeRepoShape(dto.repoShape);
    // 1. Resolve templateId from projectTypeId + workflowRecipeId
    const templateId = this.support.resolveTemplateId(
      dto.projectTypeId,
      dto.workflowRecipeId,
    );
    const effectiveDeploymentProvisioning = withRepoShapeRootDirectory(
      withDefaultCreateDeploymentProvisioning({
        request: dto.deploymentProvisioning,
        projectTypeId: dto.projectTypeId,
        serviceName: dto.serviceName,
        repoName: dto.repoName,
        servicePath: dto.servicePath,
        deploymentProvisioningDefaults:
          this.support.deploymentProvisioningDefaults,
      }),
      dto.repoShape,
    );

    // 2. Load template and build workflow YAML
    const { workflowFiles, outputFileName } =
      await this.support.buildWorkflowBundle({
        templateId,
        serviceName: dto.serviceName,
        servicePath: dto.servicePath,
        nodeVersion: dto.nodeVersion,
        coverageThreshold: dto.coverageThreshold,
        customOutputFileName: dto.outputFileName,
        // The standalone scaffold ships tests/ at the repo root; the monorepo
        // keeps tests under packages/*, so the root-level guard stays off.
        hasTestsDirectory: repoShape === 'standalone',
        deploymentProvider: extractDeploymentProvider(
          effectiveDeploymentProvisioning,
          'backend',
        ),
        deploymentTargets: resolveDeploymentWorkflowTargets(
          effectiveDeploymentProvisioning,
          ['standalone', 'backend', 'frontend'],
          dto.servicePath,
          this.support.workflowFragmentRegistry,
        ),
      });

    // 3. Create the GitHub repository (auto_init: true creates main branch)
    const { repoUrl, ownerLogin, repoName } =
      await this.support.githubService.createRepo(
        repositoryCreationToken,
        {
          repoName: dto.repoName,
          private: dto.visibility === 'private',
        },
        provisioningOwnerLogin,
      );

    const repoFullName = `${ownerLogin}/${repoName}`;
    const workflowPath =
      workflowFiles[0]?.path ?? `.github/workflows/${outputFileName}`;

    // Once the repo exists, wrap the remaining steps so a mid-flow failure
    // compensates by deleting the half-created repo + DB row instead of leaving
    // an orphan that would 422 on the next attempt.
    let row: ProvisionedProjectRow | undefined;
    let provisioningComplete = false;
    try {
      // 3.5 Push scaffold + README to main so all downstream branches inherit them
      await this.support.pushStarterFiles(
        provisioningToken,
        ownerLogin,
        repoName,
        {
          projectName: dto.serviceName,
          stack: dto.projectTypeId,
          repoShape,
          ...(dto.tests?.['docker'] !== undefined && {
            includeDocker: dto.tests['docker'],
          }),
        },
      );

      // 4. Persist the project, issue the CI token, and install the Actions
      // secrets BEFORE any workflow YAML exists. The access-gate workflow runs
      // the instant a workflow file is pushed (and again on branch creation),
      // so the secrets must already be present or that first run fails for lack
      // of ALPHACI_TOKEN. Secrets are installed strictly so a token without
      // `secrets:write` aborts provisioning here rather than producing a repo
      // whose pipelines can never authenticate.
      ({ row } = await this.support.createProjectRow(
        {
          userId,
          workspaceId:
            await this.support.workspaceGate.resolveWorkspaceIdForCreate(
              userId,
              dto.workspaceId,
              dto.deliveryProjectId,
              { requireFeatures: false },
            ),
          repoFullName,
          templateId,
          serviceName: dto.serviceName,
          workflowPath,
          status: 'provisioned',
          repoUrl,
          visibility: dto.visibility,
          repoShape,
          projectTypeId: dto.projectTypeId,
          workflowRecipeId: dto.workflowRecipeId ?? null,
          projectOptions: {
            ...this.support.repositoryOwnershipMetadata(dto, ownerLogin),
            ...(dto.tests ? { tests: dto.tests } : {}),
            workflowFiles: workflowFileMetadata(workflowFiles),
          },
        },
        { ...newChainLinkOptions(dto), accessGrant: 'new-repository' },
      ));

      const ciToken = await this.support.ciService.issueProjectToken(row.id);
      await this.support.githubService.setActionsSecretStrict(
        provisioningToken,
        ownerLogin,
        repoName,
        'ALPHACI_TOKEN',
        ciToken.token,
      );
      await this.support.githubService.setActionsSecretStrict(
        provisioningToken,
        ownerLogin,
        repoName,
        'ALPHACI_REPORT_URL',
        ALPHACI_REPORT_URL,
      );
      await this.support.githubService.setActionsSecretStrict(
        provisioningToken,
        ownerLogin,
        repoName,
        'ALPHACI_API_URL',
        ALPHACI_API_URL,
      );
      await this.support.sonar.installSecrets(
        provisioningToken,
        ownerLogin,
        repoName,
      );

      // 5. Push workflow YAML to main now that the secrets exist, then record
      // the resulting commit on the project row.
      const { commitSha, commitUrl } = await this.support.pushWorkflowFiles(
        provisioningToken,
        ownerLogin,
        repoName,
        workflowFiles,
      );
      await this.support.projectsRepository.updateStatus(
        row.id,
        'provisioned',
        commitSha,
        commitUrl,
      );

      // 6. Create the non-default tiers (dev, uat) from main.
      for (const branch of BRANCHES_CREATED_ON_PROVISION) {
        await this.support.githubService.createBranch(
          provisioningToken,
          ownerLogin,
          repoName,
          branch,
          'main',
        );
      }

      // 7. Require a pull request on dev, uat and main. Runs after every
      // initial commit above, and is best effort: the repo is already usable.
      await this.support.protectPipelineBranches({
        token: provisioningToken,
        owner: ownerLogin,
        repo: repoName,
        userId,
        projectId: row.id,
        workspaceId: row.workspace_id ?? null,
      });

      // Repo is now fully usable; failures past this point must not delete it.
      provisioningComplete = true;

      // Create the requested hosting targets on the centralized platform
      // accounts and install their Render/Vercel Actions secrets.
      const deploymentProvisioning =
        await this.support.provisionDeploymentTargets({
          projectId: row.id,
          userId,
          repoFullName,
          githubAccessToken: provisioningToken,
          request: effectiveDeploymentProvisioning,
          slots: resolveSingleRepoDeploymentSlots(
            effectiveDeploymentProvisioning,
          ),
        });

      await this.support.notifyProjectCreated({
        workspaceId: row.workspace_id ?? null,
        creatorUserId: userId,
        creatorLogin: userLogin,
        projectId: row.id,
        repoFullName,
        metadata: { repoShape, projectTypeId: dto.projectTypeId },
      });

      return {
        id: row.id,
        repoFullName,
        repoUrl,
        status: 'provisioned',
        branchesCreated: [...PROVISIONED_BRANCHES],
        workflowPath,
        workflowFiles: workflowFileMetadata(workflowFiles),
        githubCommitSha: commitSha,
        githubCommitUrl: commitUrl,
        projectTypeId: dto.projectTypeId,
        workflowRecipeId: dto.workflowRecipeId ?? '',
        deploymentProvisioning,
      };
    } catch (error) {
      if (!provisioningComplete) {
        await this.support.compensateFailedProvision(
          provisioningToken,
          ownerLogin,
          repoName,
          row?.id,
          userId,
        );
      }
      throw error;
    }
  }

  async setupProject(
    userId: string,
    oauthAccessToken: string | null | undefined,
    dto: SetupProjectDto,
  ): Promise<SetupProjectResponse> {
    // Settle the owning team first - this path mutates an existing repository
    // (branches, secrets, a workflow commit) before the row is written, and none
    // of that should happen for a request with nowhere to put the project.
    await this.support.workspaceGate.resolveWorkspaceIdForCreate(
      userId,
      dto.workspaceId,
      dto.deliveryProjectId,
    );

    // 1. Build workflow YAML from the given templateId
    const { workflowFiles, outputFileName } =
      await this.support.buildWorkflowBundle({
        templateId: dto.templateId,
        serviceName: dto.serviceName,
        servicePath: dto.servicePath,
        nodeVersion: dto.nodeVersion,
        coverageThreshold: dto.coverageThreshold,
        customOutputFileName: dto.outputFileName,
        enhancements: dto.enhancements,
        deploymentProvider: extractDeploymentProvider(
          dto.deploymentProvisioning,
          'backend',
        ),
        deploymentTargets: resolveDeploymentWorkflowTargets(
          dto.deploymentProvisioning,
          ['standalone', 'backend', 'frontend'],
          dto.servicePath,
          this.support.workflowFragmentRegistry,
        ),
      });

    // 2. Derive owner and repo from repoFullName (format: "owner/repo")
    const [owner, repo] = this.support.parseRepoFullName(dto.repoFullName);

    // Product decision: going forward, Setup-flow attachments are restricted
    // to the enforced org, same as brand-new repository creation. Already
    // attached external repos in the DB are untouched — this only blocks new
    // attachments. Enforced defense-in-depth: the FE repo picker is filtered
    // too, but the FE is not a trust boundary. Mirrors the `if (enforcedOrg)`
    // guard in resolveRepositoryProvisioning — an unconfigured/empty enforced
    // org means no restriction is active.
    const enforcedOrg = this.support.githubService.getEnforcedOrg();
    if (enforcedOrg && owner.toLowerCase() !== enforcedOrg.toLowerCase()) {
      throw new UnprocessableEntityException(
        `repoFullName must belong to the ${enforcedOrg} organization. '${owner}' is not allowed for new Setup-flow attachments.`,
      );
    }

    const accessToken = await this.support.tokens.resolveSetupProvisioningToken(
      userId,
      oauthAccessToken,
      dto.repoFullName,
    );

    /*
     * 2b. ASK THE REPOSITORY WHICH BRANCH IT LIVES ON.
     *
     * This used to be hardcoded to 'main' at the push, so every existing repo
     * on `master` or `develop` failed — after its secrets had already been
     * written. The repository is the authority on its own default branch.
     */
    const targetBranch = await this.support.setupBranch.resolveSetupBranch(
      accessToken,
      owner,
      repo,
    );

    // 3. Persist the project, issue the CI token, and install the Actions
    // secrets BEFORE pushing the workflow file so the access-gate's first run
    // on the existing repo can authenticate. Secrets are installed strictly so
    // a token without `secrets:write` aborts setup with a clear error.
    const workflowPath =
      workflowFiles[0]?.path ?? `.github/workflows/${outputFileName}`;

    const { row } = await this.support.createProjectRow(
      {
        userId,
        workspaceId:
          await this.support.workspaceGate.resolveWorkspaceIdForCreate(
            userId,
            dto.workspaceId,
            dto.deliveryProjectId,
            { requireFeatures: false },
          ),
        repoFullName: dto.repoFullName,
        templateId: dto.templateId,
        serviceName: dto.serviceName,
        workflowPath,
        status: 'provisioned',
        projectOptions: {
          workflowFiles: workflowFileMetadata(workflowFiles),
        },
      },
      newChainLinkOptions(dto),
    );

    let commitSha = '';
    let commitUrl: string | null = null;
    try {
      const ciToken = await this.support.ciService.issueProjectToken(row.id);
      await this.support.githubService.setActionsSecretStrict(
        accessToken,
        owner,
        repo,
        'ALPHACI_TOKEN',
        ciToken.token,
      );
      await this.support.githubService.setActionsSecretStrict(
        accessToken,
        owner,
        repo,
        'ALPHACI_REPORT_URL',
        ALPHACI_REPORT_URL,
      );
      // preserveExisting: this is somebody's existing repository, and it may
      // already be wired to its own SonarCloud project.
      await this.support.sonar.installSecrets(accessToken, owner, repo, true);

      // 4. Push the workflow files to the repository's OWN default branch now
      // that the secrets exist, then record the commit.
      ({ commitSha, commitUrl } = await this.support.pushWorkflowFiles(
        accessToken,
        owner,
        repo,
        workflowFiles,
        targetBranch,
      ));

      /*
       * 5. Give the promotion model somewhere to run.
       *
       * The generated pipeline only knows `uat` and `main`: everything gated on
       * uat — the staging deploy and the promotion pull request — simply never
       * fires without that branch, and skipped jobs look identical to
       * not-applicable ones in the Actions UI. Creating it here is what stops
       * an onboarded repo from running at half power for reasons nobody can
       * see. Best-effort: a repo that cannot take the branch still has a
       * working main-branch pipeline, which is better than failing the setup.
       */
      await this.support.setupBranch.ensureUatBranch(
        accessToken,
        owner,
        repo,
        targetBranch,
      );
      await this.support.projectsRepository.updateStatus(
        row.id,
        'provisioned',
        commitSha,
        commitUrl,
      );
    } catch (error) {
      /*
       * The repo is the user's own existing repo — never delete it. Remove the
       * half-created tracking row AND the secrets we wrote, so a failed setup
       * leaves nothing behind.
       *
       * Previously only the row was removed, so a repo that rejected the push
       * (wrong default branch, protected branch) was left holding an
       * ALPHACI_TOKEN and report URL belonging to a project that no longer
       * existed — credentials with no owner, invisible from this UI.
       */
      try {
        await this.support.projectsRepository.deleteByIdAndUser(row.id, userId);
      } catch (cleanupError) {
        this.logger.warn(
          `setupProject: failed to delete project row ${row.id}: ${String(cleanupError)}`,
        );
      }
      await this.support.setupBranch.removeSetupSecrets(
        accessToken,
        owner,
        repo,
      );
      throw error;
    }

    // The workflow commit above is the last direct write ALPHACI makes to the
    // repository; from here on every change goes through a pull request.
    await this.support.protectPipelineBranches({
      token: accessToken,
      owner,
      repo,
      userId,
      projectId: row.id,
      workspaceId: row.workspace_id ?? null,
    });

    const deploymentProvisioning =
      await this.support.provisionDeploymentTargets({
        projectId: row.id,
        userId,
        repoFullName: dto.repoFullName,
        githubAccessToken: accessToken,
        request: dto.deploymentProvisioning,
        slots: resolveSingleRepoDeploymentSlots(dto.deploymentProvisioning),
      });

    // setupProject is not handed the session login, so read it back from the
    // user record rather than threading a new argument through five layers.
    const creatorLogin = await this.resolveCreatorLogin(userId);
    await this.support.notifyProjectCreated({
      workspaceId: row.workspace_id ?? null,
      creatorUserId: userId,
      creatorLogin,
      projectId: row.id,
      repoFullName: dto.repoFullName,
      metadata: { repoShape: 'existing', templateId: dto.templateId },
    });

    return {
      id: row.id,
      repoFullName: dto.repoFullName,
      status: 'provisioned',
      workflowPath,
      workflowFiles: workflowFileMetadata(workflowFiles),
      githubCommitSha: commitSha,
      githubCommitUrl: commitUrl,
      deploymentProvisioning,
    };
  }

  private async resolveCreatorLogin(userId: string): Promise<string> {
    try {
      return (
        (await this.support.projectsRepository.findUserLogin(userId)) ??
        'a teammate'
      );
    } catch (error) {
      this.logger.warn(
        `Could not read the creator login for ${userId}: ${String(error)}`,
      );
      return 'a teammate';
    }
  }
}
