import { ProjectDeploymentsService } from './project-deployments.service';

describe('ProjectDeploymentsService', () => {
  const projectReference = {
    projectId: 'project-1',
    userId: 'user-1',
    repoFullName: 'tone/orders-api',
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
    consoleUrl: jest.fn(() => 'https://dashboard.render.com/web/srv-1/logs'),
  };
  const configService = {
    getOrThrow: jest.fn(),
  };
  const capabilityResolver = {
    deployment: jest.fn(),
  };
  const providerRegistry = {
    find: jest.fn((provider: string) =>
      provider === 'render'
        ? {
            label: 'Render',
            presentation: {
              publicUrl: (target: { providerProjectName: string }) =>
                `https://${target.providerProjectName}.onrender.com`,
              dashboardUrl: () => 'https://dashboard.render.com/web/srv-1',
              consoleUrl: () => 'https://dashboard.render.com/web/srv-1/logs',
            },
          }
        : undefined,
    ),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    deploymentTargetsRepository.listDeploymentTargets.mockResolvedValue([]);
    provider.listDeployments.mockResolvedValue([]);
    configService.getOrThrow.mockReturnValue({
      deploymentHistory: {
        enabled: true,
        liveProvidersEnabled: false,
      },
    });
    capabilityResolver.deployment.mockReturnValue(
      new Set(['runtime.deployment-history']),
    );
  });

  function createService() {
    return new ProjectDeploymentsService(
      deploymentTargetsRepository as never,
      provider as never,
      configService as never,
      undefined,
      undefined,
      undefined,
      undefined,
      capabilityResolver as never,
    );
  }

  it('handles empty deployment history without provider credentials', async () => {
    await expect(
      createService().listDeployments(projectReference),
    ).resolves.toEqual({
      enabled: true,
      mode: 'local_mock',
      liveProvidersEnabled: false,
      deployments: [],
      providerError: null,
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
      createService().listDeployments(projectReference),
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
    capabilityResolver.deployment.mockReturnValueOnce(new Set());

    await expect(
      createService().listDeployments(projectReference),
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
      createService().listDeployments(projectReference),
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
      createService().listDeployments(projectReference),
    ).resolves.toMatchObject({
      liveProvidersEnabled: false,
    });
  });

  it('defaults liveProvidersEnabled to true when configService is absent', async () => {
    const service = new ProjectDeploymentsService(
      deploymentTargetsRepository as never,
      provider as never,
    );

    await expect(
      service.listDeployments(projectReference),
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
        deploymentTargetsRepository as never,
        provider as never,
        configService as never,
        clientRegistry,
        undefined,
        undefined,
        providerRegistry as never,
        capabilityResolver as never,
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
          slot: 'backend',
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
        createLiveService().listDeployments(projectReference),
      ).resolves.toMatchObject({
        mode: 'live',
        deployments: [
          {
            id: 'dep-1',
            targetId: 'target-render',
            provider: 'render',
            // Carried straight from the target, so the previews surface rule
            // can tell a backend deploy from a frontend one.
            slot: 'backend',
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

    it('shares one provider deploy-history call between viewers inside the short TTL', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-10-05T12:00:00.000Z'));
      try {
        deploymentTargetsRepository.listDeploymentTargets.mockResolvedValue([
          {
            id: 'target-render',
            provider: 'render',
            slot: 'backend',
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
        renderClient.getDeployHistory.mockResolvedValue([]);
        const service = createLiveService();

        await Promise.all([
          service.listDeployments(projectReference),
          service.listDeployments(projectReference),
        ]);
        jest.setSystemTime(new Date('2026-10-05T12:00:05.000Z'));
        await service.listDeployments(projectReference);
        expect(renderClient.getDeployHistory).toHaveBeenCalledTimes(1);

        jest.setSystemTime(new Date('2026-10-05T12:00:13.000Z'));
        await service.listDeployments(projectReference);
        expect(renderClient.getDeployHistory).toHaveBeenCalledTimes(2);
      } finally {
        jest.useRealTimers();
      }
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
        createLiveService().listDeployments(projectReference),
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

    /* The three outcomes have to stay distinguishable. Collapsing a provider
     * outage into local_mock told the reader "no provider integration is
     * connected yet" about an integration that was connected and failing,
     * which sends people to reconnect something that is not broken. */
    it('reports unavailable, not simulated data, when every provider call fails', async () => {
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
      renderClient.getDeployHistory.mockRejectedValueOnce(
        new Error('Render API is unavailable'),
      );

      const result =
        await createLiveService().listDeployments(projectReference);

      expect(result.mode).toBe('unavailable');
      expect(result.deployments).toEqual([]);
      expect(result.providerError).toContain('Render');
      // The fixture feed must not stand in for a failed provider.
      expect(provider.listDeployments).not.toHaveBeenCalled();
    });

    it('keeps the successful half and still flags the failure', async () => {
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
        {
          id: 'target-render-2',
          provider: 'render',
          ownershipMode: 'flowci_managed',
          providerProjectId: 'srv-2',
          providerProjectName: 'orders-api-main',
          branchName: 'main',
          renderEnvironmentName: 'production',
          providerMetadata: {},
        },
      ]);
      configService.getOrThrow.mockReturnValue({
        deploymentHistory: { enabled: true, liveProvidersEnabled: true },
        envProvisioning: { flowciManaged: { renderToken: 'rnd_secret' } },
      });
      renderClient.getDeployHistory
        .mockResolvedValueOnce([
          {
            id: 'dep-1',
            status: 'live',
            createdAt: '2026-07-12T11:45:00.000Z',
            readyAt: null,
            commitSha: null,
            commitMessage: null,
            trigger: null,
            deploymentUrl: null,
            environment: null,
            pullRequestNumber: null,
            commitRef: null,
            inspectorUrl: null,
          },
        ])
        .mockRejectedValueOnce(new Error('rate limited'));

      const result =
        await createLiveService().listDeployments(projectReference);

      expect(result.mode).toBe('live');
      expect(result.deployments).toHaveLength(1);
      expect(result.providerError).toContain('Render');
    });

    /* A connected target with genuinely nothing deployed is a real answer.
     * Treating it as "no live data" let the fixture feed render as if real. */
    it('stays live when the provider answers with an empty list', async () => {
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
      renderClient.getDeployHistory.mockResolvedValueOnce([]);

      const result =
        await createLiveService().listDeployments(projectReference);

      expect(result.mode).toBe('live');
      expect(result.deployments).toEqual([]);
      expect(result.providerError).toBeNull();
      expect(provider.listDeployments).not.toHaveBeenCalled();
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
        createLiveService().listDeployments(projectReference),
      ).resolves.toMatchObject({ mode: 'local_mock' });
      expect(renderClient.getDeployHistory).not.toHaveBeenCalled();
      expect(provider.listDeployments).toHaveBeenCalled();
    });
  });
  /*
   * Environments exist before anything is deployed to them, and the panel that
   * shows where a deployment lives has to say so. Derived from the targets
   * rather than asked of the provider: a target that names a branch describes
   * that branch, and a slot with a single target serves every hosted branch -
   * which covers a service per branch and one project serving all of them
   * without this file knowing which provider is which.
   */
  describe('configured environments', () => {
    const target = (overrides: Record<string, unknown> = {}) => ({
      id: 'target-render-uat',
      slot: 'backend',
      provider: 'render',
      providerProjectId: 'srv-1',
      providerProjectName: 'orders-api-uat',
      branchName: 'uat',
      providerMetadata: {},
      ...overrides,
    });

    function withRegistry() {
      return new ProjectDeploymentsService(
        deploymentTargetsRepository as never,
        provider as never,
        configService as never,
        undefined,
        undefined,
        undefined,
        providerRegistry as never,
        capabilityResolver as never,
      );
    }

    it('names one environment per branch for a per-branch target', async () => {
      deploymentTargetsRepository.listDeploymentTargets.mockResolvedValue([
        target(),
        target({
          id: 'target-render-main',
          providerProjectName: 'orders-api-main',
          branchName: 'main',
        }),
      ]);

      const environments =
        await withRegistry().listEnvironments(projectReference);

      expect(
        environments.map((environment) => [
          environment.branch,
          environment.targetId,
          environment.environment,
        ]),
      ).toEqual([
        ['uat', 'target-render-uat', 'uat'],
        ['main', 'target-render-main', 'production'],
      ]);
      // Carried straight from the target, for the same reason as on deploy
      // history items.
      expect(
        environments.every((environment) => environment.slot === 'backend'),
      ).toBe(true);
    });

    it('serves every hosted branch from a slot with one target', async () => {
      deploymentTargetsRepository.listDeploymentTargets.mockResolvedValue([
        target({ id: 'target-vercel', slot: 'frontend' }),
      ]);

      const environments =
        await withRegistry().listEnvironments(projectReference);

      expect(environments.map((environment) => environment.branch)).toEqual([
        'uat',
        'main',
      ]);
      expect(
        environments.every(
          (environment) => environment.targetId === 'target-vercel',
        ),
      ).toBe(true);
      expect(
        environments.every((environment) => environment.slot === 'frontend'),
      ).toBe(true);
    });

    // dev is local: it has no service, so it is not an environment.
    it('never names the working branch', async () => {
      deploymentTargetsRepository.listDeploymentTargets.mockResolvedValue([
        target(),
      ]);

      const environments =
        await withRegistry().listEnvironments(projectReference);

      expect(
        environments.some((environment) => environment.branch === 'dev'),
      ).toBe(false);
    });

    it('reports none when the capability is off', async () => {
      capabilityResolver.deployment.mockReturnValue(new Set());
      deploymentTargetsRepository.listDeploymentTargets.mockResolvedValue([
        target(),
      ]);

      await expect(
        withRegistry().listEnvironments(projectReference),
      ).resolves.toEqual([]);
    });
  });
});
