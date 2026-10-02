import { UnprocessableEntityException } from '@nestjs/common';

import { MicroservicesProjectProvisioner } from './microservices-project.provisioner';

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
      createRepo: jest.fn().mockResolvedValue({
        repoUrl: 'https://github.com/org/orders',
        cloneUrl: 'https://github.com/org/orders.git',
        ownerLogin: 'org',
        repoName: 'orders',
      }),
      setActionsSecretStrict: jest.fn().mockResolvedValue(undefined),
      createBranch: jest.fn().mockResolvedValue(undefined),
      ensurePullRequestProtection: jest
        .fn()
        .mockResolvedValue({ status: 'applied' }),
    },
    protectPipelineBranches: jest.fn().mockResolvedValue(undefined),
    pushStarterFiles: jest.fn().mockResolvedValue(undefined),
    createProjectRow: jest.fn().mockResolvedValue({
      row: { id: 'proj-be', workspace_id: 'ws-1' },
      deliveryProjectId: null,
    }),
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
      commitUrl: 'https://github.com/org/orders/commit/sha',
    }),
    projectsRepository: {
      updateStatus: jest.fn().mockResolvedValue(undefined),
    },
    compensateFailedProvision: jest.fn().mockResolvedValue(undefined),
    provisionDeploymentTargets: jest.fn().mockResolvedValue({
      status: 'skipped',
      targets: [],
    }),
    notifyProjectCreated: jest.fn().mockResolvedValue(undefined),
  };
}

const packedShapeDto = {
  repoName: 'orders',
  visibility: 'private',
  repoShape: 'microservices',
  projectTypeId: 'nestjs-api',
  workflowRecipeId: 'backend-api-ci',
  serviceName: 'orders-be',
  microservicesConfig: {
    backend: {
      projectTypeId: 'nestjs-api',
      workflowRecipeId: 'backend-api-ci',
      serviceName: 'orders-be',
      servicePath: 'backend',
    },
    frontend: {
      projectTypeId: 'react-app',
      workflowRecipeId: 'frontend-ci',
      serviceName: 'orders-fe',
      servicePath: 'frontend',
    },
  },
};

describe('MicroservicesProjectProvisioner', () => {
  it('rejects packed shape without microservicesConfig', async () => {
    const support = fakeSupport();
    const provisioner = new MicroservicesProjectProvisioner(support as never);

    await expect(
      provisioner.createMicroservicesProject(
        'user-1',
        'tone',
        'token',
        'prov-token',
        undefined,
        {
          repoName: 'orders',
          visibility: 'private',
          repoShape: 'microservices',
          projectTypeId: 'nestjs-api',
          workflowRecipeId: 'backend-api-ci',
          serviceName: 'orders-be',
        } as never,
      ),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);

    expect(support.githubService.createRepo).not.toHaveBeenCalled();
  });

  it('compensates when createRepo succeeds and a later GitHub write fails', async () => {
    const support = fakeSupport();
    support.pushWorkflowFiles.mockRejectedValueOnce(new Error('GitHub 500'));
    const provisioner = new MicroservicesProjectProvisioner(support as never);

    await expect(
      provisioner.createMicroservicesProject(
        'user-1',
        'tone',
        'token',
        'prov-token',
        'org',
        packedShapeDto as never,
      ),
    ).rejects.toThrow('GitHub 500');

    expect(support.compensateFailedProvision).toHaveBeenCalledWith(
      'prov-token',
      'org',
      'orders',
      'proj-be',
      'user-1',
    );
  });

  it('creates one shared chain for the pair, named after the shared repo, and links both slots to it', async () => {
    const support = fakeSupport();
    support.createProjectRow.mockResolvedValueOnce({
      row: { id: 'proj-be', workspace_id: 'ws-1' },
      deliveryProjectId: 'dp-shared',
    });
    const provisioner = new MicroservicesProjectProvisioner(support as never);

    await provisioner.createMicroservicesProject(
      'user-1',
      'tone',
      'token',
      'prov-token',
      'org',
      packedShapeDto as never,
    );

    expect(support.createProjectRow).toHaveBeenCalledTimes(2);
    // Backend slot: no deliveryProjectId on the request, so it auto-creates
    // the chain, named after the one shared repo both slots live in.
    expect(support.createProjectRow.mock.calls[0]?.[1]).toEqual({
      chainName: 'orders',
    });
    // Frontend slot: reuses the delivery project the backend slot's link
    // just created, instead of creating a second, independent chain.
    expect(support.createProjectRow.mock.calls[1]?.[1]).toEqual({
      deliveryProjectId: 'dp-shared',
    });
  });

  it('names the shared chain after projectName (enforced unique)', async () => {
    const support = fakeSupport();
    support.createProjectRow.mockResolvedValueOnce({
      row: { id: 'proj-be', workspace_id: 'ws-1' },
      deliveryProjectId: 'dp-shared',
    });
    const provisioner = new MicroservicesProjectProvisioner(support as never);

    await provisioner.createMicroservicesProject(
      'user-1',
      'tone',
      'token',
      'prov-token',
      'org',
      { ...packedShapeDto, projectName: 'Order Platform' } as never,
    );

    expect(support.createProjectRow.mock.calls[0]?.[1]).toEqual({
      chainName: 'Order Platform',
      enforceUniqueChainName: true,
    });
    expect(support.createProjectRow.mock.calls[1]?.[1]).toEqual({
      deliveryProjectId: 'dp-shared',
    });
  });

  it('ignores projectName when an explicit deliveryProjectId is given', async () => {
    const support = fakeSupport();
    const provisioner = new MicroservicesProjectProvisioner(support as never);

    await provisioner.createMicroservicesProject(
      'user-1',
      'tone',
      'token',
      'prov-token',
      'org',
      {
        ...packedShapeDto,
        projectName: 'Ignored',
        deliveryProjectId: 'dp-given',
      } as never,
    );

    expect(support.createProjectRow.mock.calls[0]?.[1]).toEqual({
      deliveryProjectId: 'dp-given',
    });
  });

  it('links both slots to an explicit deliveryProjectId instead of auto-creating a chain', async () => {
    const support = fakeSupport();
    support.createProjectRow.mockResolvedValueOnce({
      row: { id: 'proj-be', workspace_id: 'ws-1' },
      deliveryProjectId: 'dp-given',
    });
    const provisioner = new MicroservicesProjectProvisioner(support as never);

    await provisioner.createMicroservicesProject(
      'user-1',
      'tone',
      'token',
      'prov-token',
      'org',
      { ...packedShapeDto, deliveryProjectId: 'dp-given' } as never,
    );

    expect(support.createProjectRow.mock.calls[0]?.[1]).toEqual({
      deliveryProjectId: 'dp-given',
    });
    expect(support.createProjectRow.mock.calls[1]?.[1]).toEqual({
      deliveryProjectId: 'dp-given',
    });
  });

  it('announces the project once, using the session login', async () => {
    const support = fakeSupport();
    const provisioner = new MicroservicesProjectProvisioner(support as never);

    await provisioner.createMicroservicesProject(
      'user-1',
      'tone',
      'token',
      'prov-token',
      'org',
      packedShapeDto as never,
    );

    expect(support.notifyProjectCreated).toHaveBeenCalledTimes(1);
    expect(support.notifyProjectCreated).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws-1',
        creatorUserId: 'user-1',
        creatorLogin: 'tone',
        projectId: 'proj-be',
        repoFullName: 'org/orders',
      }),
    );
  });

  it('does not announce a project that failed to provision', async () => {
    const support = fakeSupport();
    support.pushWorkflowFiles.mockRejectedValueOnce(new Error('GitHub 500'));
    const provisioner = new MicroservicesProjectProvisioner(support as never);

    await expect(
      provisioner.createMicroservicesProject(
        'user-1',
        'tone',
        'token',
        'prov-token',
        'org',
        packedShapeDto as never,
      ),
    ).rejects.toThrow('GitHub 500');

    expect(support.notifyProjectCreated).not.toHaveBeenCalled();
  });
});
