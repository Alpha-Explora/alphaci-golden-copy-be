import { NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

import { DevOnlyGuard } from '#kernel/auth/dev-only.guard';

describe('DevOnlyGuard', () => {
  const makeConfigService = (nodeEnv: string) =>
    ({
      get: jest.fn().mockReturnValue(nodeEnv),
    }) as unknown as ConfigService;

  it('allows diagnostic routes outside production', () => {
    const guard = new DevOnlyGuard(makeConfigService('development'));

    expect(guard.canActivate()).toBe(true);
  });

  it('hides diagnostic routes in production', () => {
    const guard = new DevOnlyGuard(makeConfigService('production'));

    expect(() => guard.canActivate()).toThrow(NotFoundException);
  });
});
