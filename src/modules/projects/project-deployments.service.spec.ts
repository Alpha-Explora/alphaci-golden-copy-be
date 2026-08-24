import { ProjectDeploymentsService } from './project-deployments.service';

describe('ProjectDeploymentsService', () => {
  const projectsRepository = {
    findByIdAndUser: jest.fn(),
  };
  const deploymentTargetsRepository = {
    listDeploymentTargets: jest.fn(),
  };
  const provider = {
    listDeployments: jest.fn(),
    normalizeStatus: jest.fn((status: string) =>
      status === 'live' ? 'ready' : 'unknown',
    ),
    dashboardUrl: jest.fn(() => 'https://dashboard.render.com/web/srv-1'),
    consoleUrl: jest.fn(
      () => 'https://dashboard.render.com/web/srv-1/logs',
    ),
  };
  const configService = {
    getOrThrow: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    projectsRepository.findByIdAndUser.mockResolvedValue({
      id: 'project-1',
      repo_full_name: 'tone/orders-api',
    });
    deploymentTargetsRepository.listDeploymentTargets.mockResolvedValue([]);
    provider.listDeployments.mockResolvedValue([]);
    configService.getOrThrow.mockReturnValue({
      deploymentHistory: {
        enabled: true,
        liveProvidersEnabled: false,
      },
    });
  });

  function createService() {
    return new ProjectDeploymentsService(
      projectsRepository as never,
      deploymentTargetsRepository as never,
      provider as never,
      configService as never,
    );
  }

  it('handles empty deployment history without provider credentials', async () => {
    await expect(
      createService().listDeployments('project-1', 'user-1'),
    ).resolves.toEqual({
      enabled: true,
      mode: 'local_mock',
      liveProvidersEnabled: false,
      deployments: [],
    });

    expect(provider.listDeployments).toHaveBeenCalledWith([]);
  });

  it('returns local deployment history from stored targets', async () => {
    const targets = [
      {
        id: 'target-render',
        provider: 'render',
        providerProjectId: 'srv-1',
        providerProjectName: 'orders-api-test',
        branchName: 'test',
        renderEnvironmentName: 'test',
        providerMetadata: {},
      },
    ];
    deploymentTargetsRepository.listDeploymentTargets.mockResolvedValueOnce(
      targets,
    );
    provider.listDeployments.mockResolvedValueOnce([
      {
        id: 'local-target-render',
        targetId: 'target-render',
        targetName: 'orders-api-test',
        provider: 'render',
        environment: 'test',
        branch: 'test',
        commitSha: null,
        status: 'ready',
        createdAt: '2026-06-12T00:00:00.000Z',
        readyAt: '2026-06-12T00:05:00.000Z',
        dashboardUrl: 'https://dashboard.render.com/web/srv-1',
        consoleUrl: 'https://dashboard.render.com/web/srv-1/logs',
      },
    ]);

    await expect(
      createService().listDeployments('project-1', 'user-1'),
    ).resolves.toMatchObject({
      deployments: [
        {
          id: 'local-target-render',
          provider: 'render',
          status: 'ready',
        },
      ],
    });
    expect(provider.listDeployments).toHaveBeenCalledWith(targets);
  });

  it('returns disabled local state when deployment history is off', async () => {
    configService.getOrThrow.mockReturnValueOnce({
      deploymentHistory: {
        enabled: false,
        liveProvidersEnabled: false,
      },
    });

    await expect(
      createService().listDeployments('project-1', 'user-1'),
    ).resolves.toMatchObject({
      enabled: false,
      deployments: [],
    });
    expect(provider.listDeployments).not.toHaveBeenCalled();
  });

  it('reports liveProvidersEnabled true when explicitly configured', async () => {
    configService.getOrThrow.mockReturnValue({
      deploymentHistory: {
        enabled: true,
        liveProvidersEnabled: true,
      },
    });

    await expect(
      createService().listDeployments('project-1', 'user-1'),
    ).resolves.toMatchObject({
      liveProvidersEnabled: true,
    });
  });

  it('reports liveProvidersEnabled false when explicitly disabled', async () => {
    configService.getOrThrow.mockReturnValue({
      deploymentHistory: {
        enabled: true,
        liveProvidersEnabled: false,
      },
    });

    await expect(
      createService().listDeployments('project-1', 'user-1'),
    ).resolves.toMatchObject({
      liveProvidersEnabled: false,
    });
  });

  it('defaults liveProvidersEnabled to true when configService is absent', async () => {
    const service = new ProjectDeploymentsService(
      projectsRepository as never,
      deploymentTargetsRepository as never,
      provider as never,
    );

    await expect(
      service.listDeployments('project-1', 'user-1'),
    ).resolves.toMatchObject({
      liveProvidersEnabled: true,
    });
  });

  describe('live deploy history', () => {
    const renderClient = {
      getDeployHistory: jest.fn(),
    };
    const clientRegistry = {
      getClient: jest.fn().mockReturnValue(renderClient),
    };

    function createLiveService() {
      return new ProjectDeploymentsService(
        projectsRepository as never,
        deploymentTargetsRepository as never,
        provider as never,
        configService as never,
        clientRegistry as never,
      );
    }

    beforeEach(() => {
      renderClient.getDeployHistory.mockReset();
      clientRegistry.getClient.mockReturnValue(renderClient);
    });

    it('returns live deploy history when the provider client supports it and a token resolves', async () => {
      deploymentTargetsRepository.listDeploymentTargets.mockResolvedValueOnce([
        {
          id: 'target-render',
          provider: 'render',
          ownershipMode: 'flowci_managed',
          providerProjectId: 'srv-1',
          providerProjectName: 'orders-api-test',
          branchName: 'test',
          renderEnvironmentName: 'test',
          providerMetadata: {},
        },
      ]);
      configService.getOrThrow.mockReturnValue({
        deploymentHistory: { enabled: true, liveProvidersEnabled: true },
        envProvisioning: { flowciManaged: { renderToken: 'rnd_secret' } },
      });
      renderClient.getDeployHistory.mockResolvedValueOnce([
        {
          id: 'dep-1',
          status: 'live',
          createdAt: '2026-07-12T11:45:00.000Z',
          readyAt: '2026-07-12T11:48:00.000Z',
          commitSha: 'ea73844',
          commitMessage: 'feat: add logs endpoint',
          trigger: 'auto_deploy',
          deploymentUrl: null,
          environment: null,
          pullRequestNumber: null,
          commitRef: null,
          inspectorUrl: null,
        },
      ]);

      await expect(
        createLiveService().listDeployments('project-1', 'user-1'),
      ).resolves.toMatchObject({
        mode: 'live',
        deployments: [
          {
            id: 'dep-1',
            targetId: 'target-render',
            provider: 'render',
            status: 'ready',
            commitSha: 'ea73844',
            commitMessage: 'feat: add logs endpoint',
            // Render reports none of these per deploy, so each one falls
            // back to what the target itself knows.
            deploymentUrl: 'https://orders-api-test.onrender.com',
            environment: 'test',
            branch: 'test',
            pullRequestNumber: null,
            inspectorUrl: null,
          },
        ],
      });
      expect(provider.listDeployments).not.toHaveBeenCalled();
    });

    it('prefers the per-deployment lane, branch, and URL a Vercel preview reports over the target defaults', async () => {
      const vercelClient = { getDeployHistory: jest.fn() };
      clientRegistry.getClient.mockReturnValue(vercelClient);
      deploymentTargetsRepository.listDeploymentTargets.mockResolvedValueOnce([
        {
          id: 'target-vercel',
          provider: 'vercel',
          ownershipMode: 'flowci_managed',
          providerProjectId: 'prj-1',
          providerProjectName: 'web-app',
          branchName: 'main',
          renderEnvironmentName: null,
          providerMetadata: {},
        },
      ]);
      configService.getOrThrow.mockReturnValue({
        deploymentHistory: { enabled: true, liveProvidersEnabled: true },
        envProvisioning: { flowciManaged: { vercelToken: 'vc_secret' } },
      });
      vercelClient.getDeployHistory.mockResolvedValueOnce([
        {
          id: 'dpl_1',
          status: 'READY',
          createdAt: '2026-07-12T11:45:00.000Z',
          readyAt: '2026-07-12T11:48:00.000Z',
          commitSha: 'ea73844',
          commitMessage: 'feat: checkout',
          trigger: 'git',
          deploymentUrl: 'https://web-app-git-feat-checkout.vercel.app',
          environment: 'preview',
          pullRequestNumber: 42,
          commitRef: 'feat/checkout',
          inspectorUrl: 'https://vercel.com/tone/web-app/dpl_1',
        },
      ]);

      await expect(
        createLiveService().listDeployments('project-1', 'user-1'),
      ).resolves.toMatchObject({
        mode: 'live',
        deployments: [
          {
            id: 'dpl_1',
            provider: 'vercel',
            deploymentUrl: 'https://web-app-git-feat-checkout.vercel.app',
            environment: 'preview',
            // Not the target's 'main' — the deployment's own ref.
            branch: 'feat/checkout',
            pullRequestNumber: 42,
            inspectorUrl: 'https://vercel.com/tone/web-app/dpl_1',
          },
        ],
      });
    });

    it('falls back to local mock when no target has a resolvable live connection', async () => {
      deploymentTargetsRepository.listDeploymentTargets.mockResolvedValueOnce([
        {
          id: 'target-vercel',
          provider: 'vercel',
          ownershipMode: 'byo',
          providerConnectionId: null,
          providerProjectId: 'prj-1',
          providerProjectName: 'web-app',
          branchName: 'uat',
          providerMetadata: {},
        },
      ]);
      configService.getOrThrow.mockReturnValue({
        deploymentHistory: { enabled: true, liveProvidersEnabled: true },
      });

      await expect(
        createLiveService().listDeployments('project-1', 'user-1'),
      ).resolves.toMatchObject({ mode: 'local_mock' });
      expect(renderClient.getDeployHistory).not.toHaveBeenCalled();
      expect(provider.listDeployments).toHaveBeenCalled();
    });
  });
});
