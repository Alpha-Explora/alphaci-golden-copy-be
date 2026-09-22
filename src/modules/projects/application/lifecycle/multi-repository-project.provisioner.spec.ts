import { UnprocessableEntityException } from '@nestjs/common';

import { WorkflowFragmentRegistry } from '#kernel/ports/workflow-fragment.port';
import { DeploymentProvisioningDefaultsService } from '#modules/runtime/application/deployment-provisioning-defaults.service';
import { DeploymentProviderPolicyRegistry } from '#modules/runtime/domain/deployment-provider.policy';
import { RenderDeploymentPolicy } from '#modules/runtime/infrastructure/providers/render/render-deployment.policy';
import type { RenderCostPolicyService } from '#modules/runtime/infrastructure/providers/render/render-cost-policy.service';
import { renderWorkflowFragment } from '#modules/runtime/infrastructure/providers/render/render-workflow.fragment';
import { VercelDeploymentPolicy } from '#modules/runtime/infrastructure/providers/vercel/vercel-deployment.policy';
import { vercelWorkflowFragment } from '#modules/runtime/infrastructure/providers/vercel/vercel-workflow.fragment';

import { MultiRepositoryProjectProvisioner } from './multi-repository-project.provisioner';

function fakeSupport() {
  return {
    deploymentProvisioningDefaults: undefined,
    workflowFragmentRegistry: undefined,
    resolveTemplateId: jest.fn().mockReturnValue('tpl'),
    buildWorkflowBundle: jest.fn().mockResolvedValue({
      workflowFiles: [],
      outputFileName: 'ci.yml',
    }),
    githubService: {
      createRepo: jest.fn(),
      setActionsSecretStrict: jest.fn().mockResolvedValue(undefined),
      createBranch: jest.fn().mockResolvedValue(undefined),
      applyBranchProtection: jest.fn().mockResolvedValue(undefined),
    },
    pushStarterFiles: jest.fn().mockResolvedValue(undefined),
    createProjectRow: jest.fn().mockResolvedValue({ id: 'proj-be' }),
    workspaceGate: {
      resolveWorkspaceIdForCreate: jest.fn().mockResolvedValue('ws-1'),
    },
    repositoryOwnershipMetadata: jest.fn().mockReturnValue({}),
    ciService: {
      issueProjectToken: jest.fn().mockResolvedValue({ token: 'ci-token' }),
    },
    sonar: { installSecrets: jest.fn().mockResolvedValue(undefined) },
    pushWorkflowFiles: jest.fn().mockResolvedValue({
      commitSha: 'sha',
      commitUrl: 'https://github.com/org/orders-be/commit/sha',
    }),
    projectsRepository: {
      updateStatus: jest.fn().mockResolvedValue(undefined),
    },
    compensateFailedProvision: jest.fn().mockResolvedValue(undefined),
    provisionDeploymentTargets: jest.fn().mockResolvedValue({
      status: 'skipped',
      targets: [],
    }),
    projectDeploymentProvisioningService: {
      crossLinkServiceUrls: jest.fn().mockResolvedValue(undefined),
    },
  };
}

const multiRepoDto = {
  repoName: 'orders',
  visibility: 'private',
  repoShape: 'multi-repo',
  projectTypeId: 'nestjs-api',
  workflowRecipeId: 'backend-api-ci',
  serviceName: 'orders-be',
  multiRepoConfig: {
    backend: {
      projectTypeId: 'nestjs-api',
      workflowRecipeId: 'backend-api-ci',
      serviceName: 'orders-be',
      servicePath: '.',
    },
    frontend: {
      projectTypeId: 'react-app',
      workflowRecipeId: 'frontend-ci',
      serviceName: 'orders-fe',
      servicePath: '.',
    },
  },
};

describe('MultiRepositoryProjectProvisioner', () => {
  it('rejects multi-repo shape without multiRepoConfig', async () => {
    const support = fakeSupport();
    const provisioner = new MultiRepositoryProjectProvisioner(support as never);

    await expect(
      provisioner.createMultiRepoProject(
        'user-1',
        'tone',
        'token',
        'prov-token',
        undefined,
        {
          repoName: 'orders',
          visibility: 'private',
          repoShape: 'multi-repo',
          projectTypeId: 'nestjs-api',
          workflowRecipeId: 'backend-api-ci',
          serviceName: 'orders-be',
        } as never,
      ),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);

    expect(support.githubService.createRepo).not.toHaveBeenCalled();
  });

  it('keeps the backend project when frontend createRepo fails', async () => {
    const support = fakeSupport();
    support.githubService.createRepo
      .mockResolvedValueOnce({
        repoUrl: 'https://github.com/org/orders-be',
        cloneUrl: 'https://github.com/org/orders-be.git',
        ownerLogin: 'org',
        repoName: 'orders-be',
      })
      .mockRejectedValueOnce(new Error('GitHub 500'));
    const provisioner = new MultiRepositoryProjectProvisioner(support as never);

    await expect(
      provisioner.createMultiRepoProject(
        'user-1',
        'tone',
        'token',
        'prov-token',
        'org',
        multiRepoDto as never,
      ),
    ).resolves.toMatchObject({
      id: 'proj-be',
      repoFullName: 'org/orders-be',
      status: 'provisioned',
    });

    expect(support.compensateFailedProvision).not.toHaveBeenCalled();
  });

  it('gives the frontend repository Vercel hosting when no hosting was chosen', async () => {
    const support = {
      ...fakeSupport(),
      deploymentProvisioningDefaults: new DeploymentProvisioningDefaultsService(
        new DeploymentProviderPolicyRegistry([
          new RenderDeploymentPolicy({} as RenderCostPolicyService),
          new VercelDeploymentPolicy(),
        ]),
      ),
      workflowFragmentRegistry: new WorkflowFragmentRegistry([
        renderWorkflowFragment,
        vercelWorkflowFragment,
      ]),
    };
    support.githubService.createRepo
      .mockResolvedValueOnce({
        repoUrl: 'https://github.com/org/orders-be',
        ownerLogin: 'org',
        repoName: 'orders-be',
      })
      .mockResolvedValueOnce({
        repoUrl: 'https://github.com/org/orders-fe',
        ownerLogin: 'org',
        repoName: 'orders-fe',
      });
    support.createProjectRow
      .mockResolvedValueOnce({ id: 'proj-be' })
      .mockResolvedValueOnce({ id: 'proj-fe' });
    const provisioner = new MultiRepositoryProjectProvisioner(support as never);

    await provisioner.createMultiRepoProject(
      'user-1',
      'tone',
      'token',
      'prov-token',
      'org',
      multiRepoDto as never,
    );

    const frontendProvisioning = support.provisionDeploymentTargets.mock.calls
      .map(
        ([call]) =>
          call as {
            projectId: string;
            slots: string[];
            request: { targets: unknown[] };
          },
      )
      .find((call) => call.slots.includes('frontend'));
    expect(frontendProvisioning).toMatchObject({
      projectId: 'proj-fe',
      repoFullName: 'org/orders-fe',
    });
    expect(frontendProvisioning?.request.targets).toContainEqual(
      expect.objectContaining({
        slot: 'frontend',
        provider: 'vercel',
        projectName: 'orders-fe',
      }),
    );

    const frontendBundle = support.buildWorkflowBundle.mock.calls
      .map(
        ([call]) =>
          call as {
            serviceName: string;
            deploymentTargets: Array<{ provider: string }>;
          },
      )
      .find((call) => call.serviceName === 'orders-fe');
    expect(
      frontendBundle?.deploymentTargets.map((target) => target.provider),
    ).toEqual(['vercel']);
  });
});
