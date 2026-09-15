import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '#kernel/config/app.config.js';
import type { ClientPolicySource } from './client-policy.port.js';
import type { ClientCapabilityPolicy } from './client-policy.types.js';
import { PACK_MANIFESTS } from './manifests.js';
import { StaticCapabilityManifestSource } from './static-capability-manifest-source.js';

const configFor = (edition: AppConfig['composition']['edition']) =>
  ({
    composition: { edition, profile: 'enterprise' },
  }) as AppConfig;

const policySourceFor = (
  policy: ClientCapabilityPolicy | null,
): ClientPolicySource => ({
  deployment: () => policy,
  for: () => policy,
});

describe('StaticCapabilityManifestSource', () => {
  it('returns the configured Enterprise deployment manifest by default', () => {
    const configService = {
      getOrThrow: jest.fn().mockReturnValue(configFor('enterprise')),
    } as unknown as ConfigService;
    const source = new StaticCapabilityManifestSource(
      configService,
      policySourceFor(null),
    );

    expect(source.deployment()).toBe(PACK_MANIFESTS.enterprise);
  });

  it('selects the configured edition and uses the subject path', () => {
    const configService = {
      getOrThrow: jest.fn().mockReturnValue(configFor('edu')),
    } as unknown as ConfigService;
    const source = new StaticCapabilityManifestSource(
      configService,
      policySourceFor(null),
    );

    expect(source.for({ tenantId: 'tenant-1' })).toBe(PACK_MANIFESTS.edu);
    expect(configService.getOrThrow).toHaveBeenCalledWith('app');
  });

  it('narrows the edition manifest by the client policy on both paths', () => {
    const configService = {
      getOrThrow: jest.fn().mockReturnValue(configFor('enterprise')),
    } as unknown as ConfigService;
    const source = new StaticCapabilityManifestSource(
      configService,
      policySourceFor({
        clientId: 'northwind',
        displayName: 'Northwind',
        edition: 'enterprise',
        disabledCapabilities: ['runtime.preview-deployments'],
      }),
    );

    for (const manifest of [
      source.deployment(),
      source.for({ tenantId: 'tenant-1' }),
    ]) {
      expect(manifest.edition).toBe('enterprise');
      expect(manifest.capabilities).not.toContain(
        'runtime.preview-deployments',
      );
      expect(manifest.capabilities).toContain('runtime.deployment-history');
      expect(manifest.capabilities.length).toBe(
        PACK_MANIFESTS.enterprise.capabilities.length - 1,
      );
    }
  });
});
