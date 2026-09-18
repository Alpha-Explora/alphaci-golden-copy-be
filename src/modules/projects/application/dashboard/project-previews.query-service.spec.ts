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
    environment: 'preview',
    branch: 'feat/checkout',
    commitSha: 'ea73844',
    commitMessage: 'feat: checkout',
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
  });

  const environment = (branch: 'uat' | 'main', targetId = 'target-render') => ({
    targetId,
    targetName: `orders-api-${branch}`,
    provider: 'render' as const,
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

  it('keeps only the newest deployment per branch', async () => {
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
});
