import { LocalDeploymentHistoryProvider } from './local-deployment-history.provider';

describe('LocalDeploymentHistoryProvider', () => {
  it('normalizes Vercel-like deployment statuses', () => {
    const provider = new LocalDeploymentHistoryProvider();

    expect(provider.normalizeStatus('READY')).toBe('ready');
    expect(provider.normalizeStatus('BUILDING')).toBe('building');
    expect(provider.normalizeStatus('ERROR')).toBe('failed');
    expect(provider.normalizeStatus('CANCELED')).toBe('canceled');
    expect(provider.normalizeStatus('something-new')).toBe('unknown');
  });

  it('normalizes Render-like deployment statuses', () => {
    const provider = new LocalDeploymentHistoryProvider();

    expect(provider.normalizeStatus('live')).toBe('ready');
    expect(provider.normalizeStatus('build_in_progress')).toBe('building');
    expect(provider.normalizeStatus('build_failed')).toBe('failed');
    expect(provider.normalizeStatus('canceled')).toBe('canceled');
  });

  it('returns empty deployment history when fixture mode is disabled', async () => {
    const provider = new LocalDeploymentHistoryProvider({ fixtureMode: false });

    await expect(provider.listDeployments([])).resolves.toEqual([]);
  });

  it('returns fixture deployments with provider dashboard links', async () => {
    const provider = new LocalDeploymentHistoryProvider({ fixtureMode: true });

    await expect(
      provider.listDeployments([
        {
          id: 'target-vercel',
          provider: 'vercel',
          providerProjectId: 'prj_1',
          providerProjectName: 'orders-web',
          branchName: 'main',
          renderEnvironmentName: null,
          providerMetadata: { vercelTeamSlug: 'flowci-team' },
        },
      ] as never),
    ).resolves.toEqual([
      expect.objectContaining({
        id: 'local-target-vercel',
        targetId: 'target-vercel',
        provider: 'vercel',
        status: 'ready',
        deploymentUrl: 'https://orders-web.vercel.app',
        pullRequestNumber: null,
        inspectorUrl: null,
        dashboardUrl: 'https://vercel.com/flowci-team/orders-web',
        consoleUrl: 'https://vercel.com/flowci-team/orders-web/deployments',
      }),
    ]);
  });
});
