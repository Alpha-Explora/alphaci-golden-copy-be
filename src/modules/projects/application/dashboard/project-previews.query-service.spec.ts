import { ProjectPreviewsService } from './project-previews.query-service';
import type {
  DeploymentHistoryItem as ProjectDeploymentHistoryItem,
  DeploymentProjectReference,
} from '#kernel/ports/deployment-runtime.port';

const projectReference: DeploymentProjectReference = {
  projectId: 'project-1',
  userId: 'user-1',
  repoFullName: 'tone/orders-api',
};

function deployment(
  overrides: Partial<ProjectDeploymentHistoryItem> = {},
): ProjectDeploymentHistoryItem {
  return {
    id: 'dpl_1',
    targetId: 'target-vercel',
    targetName: 'web-app',
    provider: 'vercel',
    slot: 'frontend',
    environment: 'preview',
    branch: 'feat/checkout',
    commitSha: 'ea73844',
    commitMessage: 'feat: checkout',
    createdBy: 'tone',
    status: 'ready',
    createdAt: '2026-07-12T11:45:00.000Z',
    readyAt: '2026-07-12T11:48:00.000Z',
    deploymentUrl: 'https://web-app-git-feat-checkout.vercel.app',
    pullRequestNumber: 42,
    inspectorUrl: 'https://vercel.com/tone/web-app/dpl_1',
    dashboardUrl: 'https://vercel.com/tone/web-app',
    consoleUrl: 'https://vercel.com/tone/web-app/deployments',
    ...overrides,
  };
}

describe('ProjectPreviewsService', () => {
  const deploymentsService = {
    listDeployments: jest.fn(),
    listEnvironments: jest.fn(),
  };
  const embeddabilityProbe = { check: jest.fn() };
  const capabilityResolver = { deployment: jest.fn() };
  const providerCatalog = { list: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
    capabilityResolver.deployment.mockReturnValue(
      new Set(['runtime.preview-deployments', 'runtime.deployment-history']),
    );
    embeddabilityProbe.check.mockResolvedValue({
      embeddable: true,
      reason: null,
    });
    deploymentsService.listDeployments.mockResolvedValue({
      enabled: true,
      mode: 'live',
      liveProvidersEnabled: true,
      deployments: [],
    });
    deploymentsService.listEnvironments.mockResolvedValue([]);
    // Neither provider declares logs by default, so most tests exercise the
    // pre-existing page-surface behaviour; the logs-specific tests below
    // override this per case.
    providerCatalog.list.mockReturnValue([
      {
        id: 'render',
        label: 'Render',
        enabled: true,
        envProvisioning: true,
        previewDeployments: false,
        logs: false,
      },
      {
        id: 'vercel',
        label: 'Vercel',
        enabled: true,
        envProvisioning: true,
        previewDeployments: true,
        logs: false,
      },
    ]);
  });

  const environment = (branch: 'uat' | 'main', targetId = 'target-render') => ({
    targetId,
    targetName: `orders-api-${branch}`,
    provider: 'render' as const,
    slot: 'backend' as const,
    branch,
    environment: branch === 'main' ? 'production' : branch,
    url: `https://orders-api-${branch}.onrender.com`,
    dashboardUrl: 'https://dashboard.render.com/web/srv-1',
  });

  function createService() {
    return new ProjectPreviewsService(
      deploymentsService,
      embeddabilityProbe as never,
      capabilityResolver as never,
      providerCatalog as never,
    );
  }

  it('returns a disabled response and asks the provider for nothing when the flag is off', async () => {
    capabilityResolver.deployment.mockReturnValueOnce(new Set());

    await expect(
      createService().listPreviews(projectReference),
    ).resolves.toEqual({
      enabled: false,
      liveProvidersEnabled: false,
      branches: [],
      providerError: null,
    });
    expect(deploymentsService.listDeployments).not.toHaveBeenCalled();
  });

  it('maps a branch deployment into a preview card', async () => {
    deploymentsService.listDeployments.mockResolvedValue({
      enabled: true,
      mode: 'live',
      liveProvidersEnabled: true,
      deployments: [deployment()],
    });

    await expect(
      createService().listPreviews(projectReference),
    ).resolves.toMatchObject({
      enabled: true,
      liveProvidersEnabled: true,
      branches: [
        {
          branch: 'feat/checkout',
          isProduction: false,
          previewUrl: 'https://web-app-git-feat-checkout.vercel.app',
          pullRequestNumber: 42,
          status: 'ready',
          embeddable: true,
        },
      ],
    });
  });

  it('frames the environment’s stable address and keeps the deployment’s own beside it', async () => {
    // Vercel's per-deployment hostname sits behind deployment protection; the
    // production domain does not, and it is the one the provider lists.
    deploymentsService.listDeployments.mockResolvedValue({
      enabled: true,
      mode: 'live',
      liveProvidersEnabled: true,
      deployments: [
        deployment({
          branch: 'main',
          environment: 'production',
          deploymentUrl: 'https://web-app-abc123-tone.vercel.app',
        }),
      ],
    });
    deploymentsService.listEnvironments.mockResolvedValue([
      {
        ...environment('main', 'target-vercel'),
        provider: 'vercel' as const,
        url: 'https://web-app.vercel.app',
      },
    ]);

    const response = await createService().listPreviews(projectReference);

    expect(response.branches).toEqual([
      expect.objectContaining({
        branch: 'main',
        previewUrl: 'https://web-app.vercel.app',
        deploymentUrl: 'https://web-app-abc123-tone.vercel.app',
        createdBy: 'tone',
      }),
    ]);
    expect(embeddabilityProbe.check).toHaveBeenCalledWith(
      'https://web-app.vercel.app',
    );
  });

  it('keeps only the newest deployment per branch, listing it first among its recent deploys', async () => {
    deploymentsService.listDeployments.mockResolvedValue({
      enabled: true,
      mode: 'live',
      liveProvidersEnabled: true,
      deployments: [
        deployment({
          id: 'dpl_old',
          createdAt: '2026-07-12T10:00:00.000Z',
          commitSha: 'old',
        }),
        deployment({
          id: 'dpl_new',
          createdAt: '2026-07-12T12:00:00.000Z',
          commitSha: 'new',
        }),
      ],
    });

    const result = await createService().listPreviews(projectReference);

    expect(result.branches).toHaveLength(1);
    expect(result.branches[0]).toMatchObject({
      deploymentId: 'dpl_new',
      commitSha: 'new',
    });
    expect(
      result.branches[0]?.recentDeploys.map((deploy) => deploy.id),
    ).toEqual(['dpl_new', 'dpl_old']);
  });

  it('lists at most five recent deploys per environment, with their trigger and start', async () => {
    deploymentsService.listDeployments.mockResolvedValue({
      enabled: true,
      mode: 'live',
      liveProvidersEnabled: true,
      deployments: Array.from({ length: 7 }, (_, index) =>
        deployment({
          id: `dpl_${String(index)}`,
          createdAt: `2026-07-12T1${String(index)}:00:00.000Z`,
          startedAt: `2026-07-12T1${String(index)}:00:04.000Z`,
          trigger: 'api',
          status: index === 6 ? 'ready' : 'superseded',
        }),
      ),
    });

    const [preview] = (await createService().listPreviews(projectReference))
      .branches;

    expect(preview?.recentDeploys).toHaveLength(5);
    expect(preview?.recentDeploys[0]).toMatchObject({
      id: 'dpl_6',
      status: 'ready',
      trigger: 'api',
      startedAt: '2026-07-12T16:00:04.000Z',
    });
    expect(preview?.recentDeploys[1]?.status).toBe('superseded');
    expect(preview).toMatchObject({ trigger: 'api' });
  });

  it('names the commits a provider sent no message for, with one branch read', async () => {
    deploymentsService.listDeployments.mockResolvedValue({
      enabled: true,
      mode: 'live',
      liveProvidersEnabled: true,
      deployments: [
        deployment({
          id: 'dpl_a',
          branch: 'uat',
          commitSha: 'b0f1855e663b',
          commitMessage: null,
        }),
        deployment({
          id: 'dpl_b',
          branch: 'uat',
          commitSha: 'eeee',
          commitMessage: null,
          createdAt: '2026-07-12T10:00:00.000Z',
        }),
      ],
    });
    const commitMessages = {
      forBranch: jest
        .fn()
        .mockResolvedValue(
          new Map([
            ['b0f1855e663bf792b11703477999d5e825d3eb56', 'fix(a11y): labels'],
          ]),
        ),
    };
    const service = new ProjectPreviewsService(
      deploymentsService,
      embeddabilityProbe as never,
      capabilityResolver as never,
      providerCatalog as never,
      commitMessages as never,
    );

    const [preview] = (await service.listPreviews(projectReference)).branches;

    expect(commitMessages.forBranch).toHaveBeenCalledTimes(1);
    expect(commitMessages.forBranch).toHaveBeenCalledWith(
      'tone/orders-api',
      'user-1',
      'uat',
    );
    expect(preview?.commitMessage).toBe('fix(a11y): labels');
    expect(
      preview?.recentDeploys.map((deploy) => deploy.commitMessage),
    ).toEqual(['fix(a11y): labels', null]);
  });

  it('keeps the same branch separate per deployment target', async () => {
    deploymentsService.listDeployments.mockResolvedValue({
      enabled: true,
      mode: 'live',
      liveProvidersEnabled: true,
      deployments: [
        deployment({ id: 'dpl_fe', targetId: 'target-fe', branch: 'main' }),
        deployment({ id: 'dpl_be', targetId: 'target-be', branch: 'main' }),
      ],
    });

    const result = await createService().listPreviews(projectReference);

    expect(result.branches).toHaveLength(2);
    expect(result.branches.map((b) => b.targetId).sort()).toEqual([
      'target-be',
      'target-fe',
    ]);
  });

  it('flags the production lane and sorts it first', async () => {
    deploymentsService.listDeployments.mockResolvedValue({
      enabled: true,
      mode: 'live',
      liveProvidersEnabled: true,
      deployments: [
        deployment({
          id: 'dpl_preview',
          branch: 'feat/checkout',
          environment: 'preview',
          createdAt: '2026-07-12T12:00:00.000Z',
        }),
        deployment({
          id: 'dpl_prod',
          branch: 'main',
          environment: 'production',
          createdAt: '2026-07-12T09:00:00.000Z',
        }),
      ],
    });

    const result = await createService().listPreviews(projectReference);

    // Production leads even though the preview is newer.
    expect(result.branches.map((b) => b.branch)).toEqual([
      'main',
      'feat/checkout',
    ]);
    expect(result.branches[0]?.isProduction).toBe(true);
  });

  // Vercel labels every deployment made with the production target as
  // production, and the platform deploys every branch that way. A failed
  // feature-branch build came back as production and drew a second
  // Production Deployment card on the Overview.
  it('calls only the production environment’s branch production, whatever the provider labels', async () => {
    deploymentsService.listDeployments.mockResolvedValue({
      enabled: true,
      mode: 'live',
      liveProvidersEnabled: true,
      deployments: [
        deployment({
          id: 'dpl_main',
          branch: 'main',
          environment: 'production',
          createdAt: '2026-07-12T09:00:00.000Z',
        }),
        deployment({
          id: 'dpl_feature',
          branch: 'feat/cicd-system-validation',
          environment: 'production',
          status: 'failed',
          createdAt: '2026-07-12T12:00:00.000Z',
        }),
      ],
    });
    deploymentsService.listEnvironments.mockResolvedValue([
      { ...environment('main', 'target-vercel'), provider: 'vercel' as const },
    ]);

    const result = await createService().listPreviews(projectReference);

    expect(
      result.branches.map((b) => [b.branch, b.isProduction] as const),
    ).toEqual([
      ['main', true],
      ['feat/cicd-system-validation', false],
    ]);
  });

  it('keeps the provider’s production label for a target with no listed environment', async () => {
    deploymentsService.listDeployments.mockResolvedValue({
      enabled: true,
      mode: 'live',
      liveProvidersEnabled: true,
      deployments: [deployment({ branch: 'main', environment: 'production' })],
    });
    // An environment for another target says nothing about this one.
    deploymentsService.listEnvironments.mockResolvedValue([
      environment('main', 'target-render'),
    ]);

    const result = await createService().listPreviews(projectReference);

    expect(
      result.branches.find((b) => b.targetId === 'target-vercel')?.isProduction,
    ).toBe(true);
  });

  it('sorts non-production branches newest first', async () => {
    deploymentsService.listDeployments.mockResolvedValue({
      enabled: true,
      mode: 'live',
      liveProvidersEnabled: true,
      deployments: [
        deployment({ branch: 'older', createdAt: '2026-07-12T09:00:00.000Z' }),
        deployment({ branch: 'newer', createdAt: '2026-07-12T12:00:00.000Z' }),
      ],
    });

    const result = await createService().listPreviews(projectReference);

    expect(result.branches.map((b) => b.branch)).toEqual(['newer', 'older']);
  });

  it('drops deployments with no branch to group under', async () => {
    deploymentsService.listDeployments.mockResolvedValue({
      enabled: true,
      mode: 'live',
      liveProvidersEnabled: true,
      deployments: [deployment({ branch: null })],
    });

    await expect(
      createService().listPreviews(projectReference),
    ).resolves.toMatchObject({ branches: [] });
  });

  it.each(['building', 'failed', 'queued', 'canceled', 'unknown'] as const)(
    'does not probe a deployment in %s state',
    async (status) => {
      deploymentsService.listDeployments.mockResolvedValue({
        enabled: true,
        mode: 'live',
        liveProvidersEnabled: true,
        deployments: [deployment({ status })],
      });

      const result = await createService().listPreviews(projectReference);

      expect(embeddabilityProbe.check).not.toHaveBeenCalled();
      expect(result.branches[0]).toMatchObject({
        embeddable: null,
        embedBlockedReason: null,
      });
    },
  );

  it('passes a blocked embedding verdict through to the card', async () => {
    embeddabilityProbe.check.mockResolvedValue({
      embeddable: false,
      reason: 'The site sends X-Frame-Options: DENY.',
    });
    deploymentsService.listDeployments.mockResolvedValue({
      enabled: true,
      mode: 'live',
      liveProvidersEnabled: true,
      deployments: [deployment()],
    });

    const result = await createService().listPreviews(projectReference);

    expect(result.branches[0]).toMatchObject({
      embeddable: false,
      embedBlockedReason: 'The site sends X-Frame-Options: DENY.',
    });
  });

  /*
   * A project provisioned an hour ago has environments and no deployments.
   * Reporting only history showed it as having neither, which is the opposite
   * of what provisioning had just done - and the one screen meant to show
   * where a deployment lives was empty exactly when someone first looks.
   */
  it('lists an environment that has never been deployed to', async () => {
    deploymentsService.listEnvironments.mockResolvedValue([
      environment('uat'),
      environment('main', 'target-render-main'),
    ]);

    const result = await createService().listPreviews(projectReference);

    expect(result.branches).toHaveLength(2);
    expect(result.branches.map((branch) => branch.branch)).toEqual([
      'main',
      'uat',
    ]);
    expect(result.branches[0]).toMatchObject({
      branch: 'main',
      isProduction: true,
      status: 'not_deployed',
      deploymentId: null,
      createdAt: null,
      previewUrl: 'https://orders-api-main.onrender.com',
      embeddable: false,
    });
    // Nothing to frame, so nothing is probed.
    expect(embeddabilityProbe.check).not.toHaveBeenCalled();
  });

  it('lets a real deployment describe a branch rather than the placeholder', async () => {
    deploymentsService.listDeployments.mockResolvedValue({
      enabled: true,
      mode: 'live',
      liveProvidersEnabled: true,
      deployments: [
        deployment({ targetId: 'target-render', branch: 'uat', id: 'dpl_uat' }),
      ],
    });
    deploymentsService.listEnvironments.mockResolvedValue([
      environment('uat'),
      environment('main', 'target-render-main'),
    ]);

    const result = await createService().listPreviews(projectReference);

    const uat = result.branches.find((branch) => branch.branch === 'uat');
    expect(uat).toMatchObject({ deploymentId: 'dpl_uat', status: 'ready' });
    expect(
      result.branches.filter((branch) => branch.branch === 'uat'),
    ).toHaveLength(1);
  });

  /*
   * Optional on the port, so an implementation that cannot enumerate
   * environments contributes none rather than failing the panel.
   */
  it('falls back to history alone when the port cannot list environments', async () => {
    const service = new ProjectPreviewsService(
      { listDeployments: deploymentsService.listDeployments } as never,
      embeddabilityProbe as never,
      capabilityResolver as never,
    );

    await expect(service.listPreviews(projectReference)).resolves.toMatchObject(
      { branches: [] },
    );
  });

  it('reports liveProvidersEnabled from the underlying history', async () => {
    deploymentsService.listDeployments.mockResolvedValue({
      enabled: true,
      mode: 'local_mock',
      liveProvidersEnabled: false,
      deployments: [],
    });

    await expect(
      createService().listPreviews(projectReference),
    ).resolves.toMatchObject({ liveProvidersEnabled: false });
  });

  /*
   * Scope v1: only a backend target on a provider that actually offers log
   * retrieval gets the log surface. Everything else - including a backend
   * target on a provider with no log capability - keeps the page thumbnail.
   */
  describe('preview surface', () => {
    it('shows logs for a ready backend deployment on a provider with log capability, and never probes it', async () => {
      providerCatalog.list.mockReturnValue([
        {
          id: 'render',
          label: 'Render',
          enabled: true,
          envProvisioning: true,
          previewDeployments: false,
          logs: true,
        },
      ]);
      deploymentsService.listDeployments.mockResolvedValue({
        enabled: true,
        mode: 'live',
        liveProvidersEnabled: true,
        deployments: [
          deployment({
            provider: 'render',
            slot: 'backend',
            targetId: 'target-render',
            branch: 'main',
            createdAt: '2026-07-12T11:45:00.000Z',
          }),
        ],
      });

      const result = await createService().listPreviews(projectReference);

      expect(result.branches[0]).toMatchObject({
        slot: 'backend',
        surface: 'logs',
        providerLabel: 'Render',
        logsAvailable: true,
        logWindow: { startTime: '2026-07-12T11:45:00.000Z', endTime: null },
        embeddable: false,
        embedBlockedReason: null,
      });
      expect(embeddabilityProbe.check).not.toHaveBeenCalled();
    });

    it('keeps the page surface and still probes a ready deployment when the provider has no log capability', async () => {
      deploymentsService.listDeployments.mockResolvedValue({
        enabled: true,
        mode: 'live',
        liveProvidersEnabled: true,
        deployments: [deployment({ provider: 'render', slot: 'backend' })],
      });

      const result = await createService().listPreviews(projectReference);

      expect(result.branches[0]).toMatchObject({
        slot: 'backend',
        surface: 'page',
        logsAvailable: false,
      });
      expect(embeddabilityProbe.check).toHaveBeenCalled();
    });

    it('keeps the page surface for a frontend deployment even when its provider has log capability', async () => {
      providerCatalog.list.mockReturnValue([
        {
          id: 'vercel',
          label: 'Vercel',
          enabled: true,
          envProvisioning: true,
          previewDeployments: true,
          logs: true,
        },
      ]);
      deploymentsService.listDeployments.mockResolvedValue({
        enabled: true,
        mode: 'live',
        liveProvidersEnabled: true,
        deployments: [deployment({ provider: 'vercel', slot: 'frontend' })],
      });

      const result = await createService().listPreviews(projectReference);

      expect(result.branches[0]).toMatchObject({
        slot: 'frontend',
        surface: 'page',
        logsAvailable: true,
      });
      expect(embeddabilityProbe.check).toHaveBeenCalled();
    });

    it('carries no log window for an environment that has never been deployed to', async () => {
      providerCatalog.list.mockReturnValue([
        {
          id: 'render',
          label: 'Render',
          enabled: true,
          envProvisioning: true,
          previewDeployments: false,
          logs: true,
        },
      ]);
      deploymentsService.listEnvironments.mockResolvedValue([
        environment('uat'),
      ]);

      const result = await createService().listPreviews(projectReference);

      expect(result.branches[0]).toMatchObject({
        slot: 'backend',
        surface: 'logs',
        logWindow: null,
        status: 'not_deployed',
      });
    });

    it('falls back to the provider id when the catalog has no entry for it', async () => {
      providerCatalog.list.mockReturnValue([]);
      deploymentsService.listDeployments.mockResolvedValue({
        enabled: true,
        mode: 'live',
        liveProvidersEnabled: true,
        deployments: [deployment({ provider: 'render', slot: 'backend' })],
      });

      const result = await createService().listPreviews(projectReference);

      expect(result.branches[0]).toMatchObject({
        providerLabel: 'render',
        logsAvailable: false,
        surface: 'page',
      });
    });
  });
});
