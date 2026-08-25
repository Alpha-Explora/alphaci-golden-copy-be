import { RenderEnvClient } from '../render/render-env.client';
import { VercelEnvClient } from '../vercel/vercel-env.client';
import {
  assertDeploymentProviderContract,
} from './provider-contract.suite';

describe('deployment provider contract', () => {
  it.each([
    ['render', new RenderEnvClient()],
    ['vercel', new VercelEnvClient()],
  ])('%s adapter satisfies the full provider-neutral contract', (_name, provider) => {
    expect(() => assertDeploymentProviderContract(provider)).not.toThrow();
  });

  it.each([
    ['render', new RenderEnvClient()],
    ['vercel', new VercelEnvClient()],
  ])('%s adapter reports the correct provider id', (name, provider) => {
    expect(provider.provider).toBe(name);
  });

  it.each([
    ['render', new RenderEnvClient()],
    ['vercel', new VercelEnvClient()],
  ])('%s adapter implements all seven required operations as functions', (name, provider) => {
    const requiredOps = [
      'validateConnection',
      'listTargets',
      'createTarget',
      'upsertEnvironmentVariables',
      'deleteEnvironmentVariable',
      'getTargetStatus',
      'deleteTarget',
    ] as const;
    for (const op of requiredOps) {
      expect(typeof provider[op]).toBe('function');
    }
  });

  it('rejects a provider with an unknown provider id', () => {
    const base = new RenderEnvClient();
    const fake = Object.assign(Object.create(Object.getPrototypeOf(base)), base);
    fake.provider = 'unknown' as never;
    expect(() =>
      assertDeploymentProviderContract(
        fake as unknown as Parameters<typeof assertDeploymentProviderContract>[0],
      ),
    ).toThrow('Unsupported deployment provider: unknown');
  });

  it('rejects a provider missing a required operation', () => {
    const base = new RenderEnvClient();
    const incomplete = Object.assign(Object.create(Object.getPrototypeOf(base)), base);
    (incomplete as unknown as Record<string, unknown>).deleteTarget = undefined;
    expect(() =>
      assertDeploymentProviderContract(
        incomplete as unknown as Parameters<typeof assertDeploymentProviderContract>[0],
      ),
    ).toThrow(/does not implement required operation: deleteTarget/);
  });
});
