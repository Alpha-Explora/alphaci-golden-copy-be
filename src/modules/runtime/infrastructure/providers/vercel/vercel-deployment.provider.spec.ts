import { DeploymentProviderRegistry } from '../../../core/deployment-provider.registry';
import type { DeploymentProviderPolicy } from '../../../domain/deployment-provider.policy';
import { VercelDeploymentPolicy } from './vercel-deployment.policy';
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
          branchName: 'uat',
        },
        'preview',
      ),
    ).toBe('https://uat-orders-web.vercel.app');
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

describe('Vercel presentation.publicUrl', () => {
  const provider = new VercelDeploymentProvider(
    { label: 'Vercel', enabled: true, supportedSlots: ['frontend'] },
    new DeploymentProviderRegistry(),
    testPolicy,
  );
  const target = (over: Record<string, unknown> = {}) => ({
    providerProjectId: 'prj-1',
    providerProjectName: 'logistics2cicd-frontend',
    providerMetadata: { vercelTeamSlug: 'blaines-restaurant' },
    branchName: 'uat',
    ...over,
  });
  const publicUrl = (
    t: ReturnType<typeof target>,
    lane?: 'production' | 'preview',
  ) => provider.presentation.publicUrl(t, lane);

  it('previews the CLI-published branch alias, never the -git- address', () => {
    const url = publicUrl(target(), 'preview');
    expect(url).toBe('https://uat-logistics2cicd-frontend.vercel.app');
    expect(url).not.toContain('-git-');
  });

  it('does not depend on the team slug', () => {
    expect(publicUrl(target({ providerMetadata: {} }), 'preview')).toBe(
      'https://uat-logistics2cicd-frontend.vercel.app',
    );
  });

  it('keeps production on the project host regardless of branch', () => {
    const prod = 'https://logistics2cicd-frontend.vercel.app';
    expect(publicUrl(target({ branchName: 'main' }), 'production')).toBe(prod);
    expect(publicUrl(target({ branchName: 'uat' }))).toBe(prod);
    expect(publicUrl(target({ branchName: 'main' }), 'preview')).toBe(prod);
  });

  it('falls back to the project host for a preview with no branch', () => {
    const prod = 'https://logistics2cicd-frontend.vercel.app';
    expect(publicUrl(target({ branchName: null }), 'preview')).toBe(prod);
    expect(publicUrl(target({ branchName: '   ' }), 'preview')).toBe(prod);
  });

  it('returns null without a project name', () => {
    expect(
      publicUrl(target({ providerProjectName: '' }), 'preview'),
    ).toBeNull();
    expect(publicUrl(target({ providerProjectName: '' }))).toBeNull();
  });

  it('agrees with the policy derivation, including unusual branch names', () => {
    const policy = new VercelDeploymentPolicy();
    for (const branch of ['uat', 'main', 'release_1.2', 'Feat-X', ' uat ']) {
      for (const lane of ['production', 'preview'] as const) {
        expect(publicUrl(target({ branchName: branch }), lane)).toBe(
          policy.provisioning.resolvePublicUrl({
            providerProjectName: 'logistics2cicd-frontend',
            branchName: branch,
            lane,
          } as never),
        );
      }
    }
  });
});
