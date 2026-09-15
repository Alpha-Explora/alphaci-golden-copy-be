import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';

import type { AppConfig } from '#kernel/config/app.config.js';
import {
  CAPABILITY_MANIFEST_SOURCE,
  type CapabilityManifestSource,
} from './capability-manifest-source.port.js';
import { CapabilityResolverService } from './capability-resolver.service.js';
import { PACK_MANIFESTS } from './manifests.js';

const config = {
  composition: { edition: 'enterprise', profile: 'enterprise' },
  envProvisioning: { enabled: true },
  gcpDeployments: { enabled: true, dedicatedProjectsEnabled: true },
  deploymentHistory: { enabled: true, liveProvidersEnabled: true },
  previewDeployments: { enabled: true },
  workspaces: { enabled: true },
} as unknown as AppConfig;

describe('CapabilityResolverService', () => {
  it('resolves deployment composition through deployment()', async () => {
    const source: CapabilityManifestSource = {
      deployment: jest.fn().mockReturnValue(PACK_MANIFESTS.enterprise),
      for: jest.fn(),
    };
    const module = await Test.createTestingModule({
      providers: [
        CapabilityResolverService,
        { provide: ConfigService, useValue: { getOrThrow: () => config } },
        { provide: CAPABILITY_MANIFEST_SOURCE, useValue: source },
      ],
    }).compile();

    const resolver = await module.resolve(CapabilityResolverService);
    const keys = resolver.deployment();

    expect(source.deployment).toHaveBeenCalledTimes(1);
    expect(source.for).not.toHaveBeenCalled();
    expect(keys.has('identity.workspaces')).toBe(true);
    expect(keys.has('runtime.preview-deployments')).toBe(true);
  });

  it('resolves subject composition through the manifest source for(subject) path', async () => {
    const source: CapabilityManifestSource = {
      deployment: jest.fn(),
      for: jest.fn().mockReturnValue(PACK_MANIFESTS.enterprise),
    };
    const module = await Test.createTestingModule({
      providers: [
        CapabilityResolverService,
        { provide: ConfigService, useValue: { getOrThrow: () => config } },
        { provide: CAPABILITY_MANIFEST_SOURCE, useValue: source },
      ],
    }).compile();

    const resolver = await module.resolve(CapabilityResolverService);
    const subject = { tenantId: 'tenant-1' };

    expect(resolver.for(subject).has('identity.workspaces')).toBe(true);
    expect(source.for).toHaveBeenCalledWith(subject);
    expect(source.deployment).not.toHaveBeenCalled();
  });

  it('rejects a subject manifest that is outside the configured build ceiling', async () => {
    const source: CapabilityManifestSource = {
      deployment: jest.fn(),
      for: jest.fn().mockReturnValue(PACK_MANIFESTS.saas),
    };
    const module = await Test.createTestingModule({
      providers: [
        CapabilityResolverService,
        {
          provide: ConfigService,
          useValue: { getOrThrow: () => config },
        },
        { provide: CAPABILITY_MANIFEST_SOURCE, useValue: source },
      ],
    }).compile();

    const resolver = await module.resolve(CapabilityResolverService);

    expect(() => resolver.for({ tenantId: 'tenant-1' })).toThrow(
      /not allowed by build profile 'enterprise'/,
    );
  });

  it('applies configured flags and the requires closure before returning keys', async () => {
    const narrowedConfig = {
      ...config,
      deploymentHistory: { enabled: false, liveProvidersEnabled: true },
      previewDeployments: { enabled: true },
    } as AppConfig;
    const source: CapabilityManifestSource = {
      deployment: jest.fn().mockReturnValue(PACK_MANIFESTS.enterprise),
      for: jest.fn(),
    };
    const module = await Test.createTestingModule({
      providers: [
        CapabilityResolverService,
        {
          provide: ConfigService,
          useValue: { getOrThrow: () => narrowedConfig },
        },
        { provide: CAPABILITY_MANIFEST_SOURCE, useValue: source },
      ],
    }).compile();

    const resolver = await module.resolve(CapabilityResolverService);

    expect(resolver.deployment().has('runtime.env-provisioning')).toBe(true);
    expect(resolver.deployment().has('runtime.deployment-history')).toBe(false);
    expect(resolver.deployment().has('runtime.preview-deployments')).toBe(
      false,
    );
  });

  it('fails clearly when the manifest source provider is not wired', async () => {
    await expect(
      Test.createTestingModule({
        providers: [
          CapabilityResolverService,
          { provide: ConfigService, useValue: { getOrThrow: () => config } },
        ],
      }).compile(),
    ).rejects.toThrow('CapabilityManifestSource');
  });
});
