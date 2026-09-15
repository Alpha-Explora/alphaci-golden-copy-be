import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '#kernel/config/app.config.js';
import { PACK_MANIFESTS } from './manifests.js';
import { StaticCapabilityManifestSource } from './static-capability-manifest-source.js';

const configFor = (edition: AppConfig['composition']['edition']) =>
  ({
    composition: { edition, profile: 'enterprise' },
  }) as AppConfig;

describe('StaticCapabilityManifestSource', () => {
  it('returns the configured Enterprise deployment manifest by default', () => {
    const configService = {
      getOrThrow: jest.fn().mockReturnValue(configFor('enterprise')),
    } as unknown as ConfigService;
    const source = new StaticCapabilityManifestSource(configService);

    expect(source.deployment()).toBe(PACK_MANIFESTS.enterprise);
  });

  it('selects the configured edition and uses the subject path', () => {
    const configService = {
      getOrThrow: jest.fn().mockReturnValue(configFor('edu')),
    } as unknown as ConfigService;
    const source = new StaticCapabilityManifestSource(configService);

    expect(source.for({ tenantId: 'tenant-1' })).toBe(PACK_MANIFESTS.edu);
    expect(configService.getOrThrow).toHaveBeenCalledWith('app');
  });
});
