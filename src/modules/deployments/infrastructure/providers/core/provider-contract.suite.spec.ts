import { RenderEnvClient } from '../render/render-env.client';
import { VercelEnvClient } from '../vercel/vercel-env.client';
import { assertDeploymentProviderContract } from './provider-contract.suite';

describe('deployment provider contract', () => {
  it.each([
    ['render', new RenderEnvClient()],
    ['vercel', new VercelEnvClient()],
  ])('%s adapter exposes the provider-neutral operations', (_name, provider) => {
    assertDeploymentProviderContract(provider);
  });
});
