import { DeploymentStrategyResolver } from './deployment-strategy.resolver';

describe('DeploymentStrategyResolver', () => {
  const resolver = new DeploymentStrategyResolver();

  it('uses CI-pushed deployments for ALPHACI-managed Vercel targets', () => {
    expect(
      resolver.resolve({
        provider: 'vercel',
        ownershipMode: 'flowci_managed',
      }),
    ).toBe('vercel_ci_pushed');
  });

  it('uses CI-pushed deployments for BYO Vercel targets', () => {
    expect(
      resolver.resolve({
        provider: 'vercel',
        ownershipMode: 'byo',
      }),
    ).toBe('vercel_ci_pushed');
  });

  it('uses image-pushed deployments for ALPHACI-managed Render targets', () => {
    expect(
      resolver.resolve({
        provider: 'render',
        ownershipMode: 'flowci_managed',
      }),
    ).toBe('render_image_pushed');
  });

  it('uses native Git unless BYO Render asks for image deployment', () => {
    expect(
      resolver.resolve({
        provider: 'render',
        ownershipMode: 'byo',
      }),
    ).toBe('render_git_connected');
    expect(
      resolver.resolve({
        provider: 'render',
        ownershipMode: 'byo',
        renderDeployMethod: 'byo_image',
      }),
    ).toBe('render_image_pushed');
  });

  it('uses existing-service strategy when registering Render services', () => {
    expect(
      resolver.resolve({
        provider: 'render',
        ownershipMode: 'byo',
        action: 'register_existing',
      }),
    ).toBe('render_existing_service');
  });
});
