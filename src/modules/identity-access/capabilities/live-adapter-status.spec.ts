import { resolveLiveAdapterStatus } from './live-adapter-status';

describe('resolveLiveAdapterStatus', () => {
  it('reports no live adapters until the services ship live modes', () => {
    expect(resolveLiveAdapterStatus()).toEqual({
      githubShipped: false,
      providersShipped: false,
      implemented: false,
    });
  });

  it('treats live as implemented only when both sides are shipped', () => {
    expect(
      resolveLiveAdapterStatus({
        githubShipped: true,
        providersShipped: true,
      }).implemented,
    ).toBe(true);
    expect(
      resolveLiveAdapterStatus({
        githubShipped: true,
        providersShipped: false,
      }).implemented,
    ).toBe(false);
  });
});
