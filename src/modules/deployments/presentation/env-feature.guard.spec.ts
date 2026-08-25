import { NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

import { EnvFeatureGuard } from './env-feature.guard';

describe('EnvFeatureGuard', () => {
  const makeConfigService = (enabled: boolean) =>
    ({
      getOrThrow: jest.fn().mockReturnValue({
        envProvisioning: { enabled },
      }),
    }) as unknown as ConfigService;

  it('allows requests when environment provisioning is enabled', () => {
    const guard = new EnvFeatureGuard(makeConfigService(true));

    expect(guard.canActivate()).toBe(true);
  });

  it('hides environment provisioning routes when disabled', () => {
    const guard = new EnvFeatureGuard(makeConfigService(false));

    expect(() => guard.canActivate()).toThrow(NotFoundException);
  });
});
