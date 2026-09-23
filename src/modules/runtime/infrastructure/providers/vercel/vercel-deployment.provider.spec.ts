import { DeploymentProviderRegistry } from '../../../core/deployment-provider.registry';
import type { DeploymentProviderPolicy } from '../../../domain/deployment-provider.policy';
import { VercelDeploymentProvider } from './vercel-deployment.provider';

const testPolicy = {} as DeploymentProviderPolicy;

describe('VercelDeploymentProvider', () => {
  it('registers provider-owned metadata and renders team-aware links', () => {
    const registry = new DeploymentProviderRegistry();
    const provider = new VercelDeploymentProvider(
      {
        label: 'Vercel',
        enabled: true,
        supportedSlots: ['frontend'],
        previewDeployments: true,
      },
      registry,
      testPolicy,
    );

    provider.onModuleInit();

    expect(registry.get('vercel')).toBe(provider);
    expect(
      provider.presentation?.dashboardUrl({
        providerProjectId: 'prj-1',
        providerProjectName: 'orders-web',
        providerMetadata: { vercelTeamSlug: 'flowci' },
      }),
    ).toBe('https://vercel.com/flowci/orders-web');
    expect(
      provider.presentation?.publicUrl(
        {
          providerProjectId: 'prj-1',
          providerProjectName: 'orders-web',
          providerMetadata: { vercelTeamSlug: 'flowci' },
          branchName: 'feature/payments',
        },
        'preview',
      ),
    ).toBe('https://orders-web-git-feature-payments-flowci.vercel.app');
  });

  it('keeps Vercel team validation inside the provider adapter', async () => {
    const provider = new VercelDeploymentProvider(
      {
        label: 'Vercel',
        enabled: true,
        supportedSlots: ['frontend'],
      },
      new DeploymentProviderRegistry(),
      testPolicy,
    );
    const validateTeamAccess = jest.fn().mockResolvedValue({
      id: 'team-1',
      slug: 'flowci',
    });

    await expect(
      provider.prepareConnection?.({
        token: 'token',
        config: { vercelTeamId: 'team-1' },
        account: { id: 'account-1' },
        client: { validateTeamAccess },
      }),
    ).resolves.toEqual({
      accountType: 'team',
      orgId: 'team-1',
      teamId: 'team-1',
      teamSlug: 'flowci',
    });
    expect(validateTeamAccess).toHaveBeenCalledWith('token', 'team-1');
  });

  it('declares no instance filter, unlike Render', () => {
    const provider = new VercelDeploymentProvider(
      { label: 'Vercel', enabled: true, supportedSlots: ['frontend'] },
      new DeploymentProviderRegistry(),
      testPolicy,
    );

    expect(provider.capabilities.logFilters).toEqual(['level', 'type', 'text']);
  });
});
