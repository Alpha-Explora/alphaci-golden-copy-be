import { UnprocessableEntityException } from '@nestjs/common';

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
});
