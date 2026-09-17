import { NotFoundException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import type { CapabilityResolverPort } from './capability-resolver.port.js';
import { CapabilityGuard } from './capability.guard.js';
import type { CapabilityKey } from './capability-types.js';
import { REQUIRED_CAPABILITIES } from './requires-capability.decorator.js';

const envProvisioning = 'runtime.env-provisioning' as CapabilityKey;

const makeContext = (session: Record<string, unknown>) =>
  ({
    switchToHttp: () => ({
      getRequest: () => ({ session }),
    }),
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
  }) as unknown as ExecutionContext;

const makeResolver = (capabilities: readonly CapabilityKey[]) =>
  ({
    for: jest.fn().mockReturnValue(new Set(capabilities)),
    deployment: jest.fn(),
  }) as unknown as CapabilityResolverPort;

describe('CapabilityGuard', () => {
  it('allows requests without capability metadata', () => {
    const reflector = new Reflector();
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);
    const resolver = makeResolver([]);
    const guard = new CapabilityGuard(reflector, resolver);

    expect(guard.canActivate(makeContext({}))).toBe(true);
    expect(resolver.for).not.toHaveBeenCalled();
  });

  it('allows a request when every required key is present', () => {
    const reflector = new Reflector();
    jest
      .spyOn(reflector, 'getAllAndOverride')
      .mockReturnValue([envProvisioning]);
    const resolver = makeResolver([envProvisioning]);
    const guard = new CapabilityGuard(reflector, resolver);

    expect(
      guard.canActivate(
        makeContext({ tenantId: 'tenant-1', user: { id: 'user-1' } }),
      ),
    ).toBe(true);
    expect(resolver.for).toHaveBeenCalledWith({ tenantId: 'tenant-1' });
  });

  it('hides a route with a generic not-found response when a key is absent', () => {
    const reflector = new Reflector();
    jest
      .spyOn(reflector, 'getAllAndOverride')
      .mockReturnValue([envProvisioning]);
    const resolver = makeResolver([]);
    const guard = new CapabilityGuard(reflector, resolver);

    let thrown: unknown;
    try {
      guard.canActivate(makeContext({ tenantId: 'tenant-1' }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(NotFoundException);
    expect((thrown as NotFoundException).message).toBe(
      'Requested capability is not available',
    );
    expect((thrown as NotFoundException).message).not.toContain(
      envProvisioning,
    );
    expect(resolver.for).toHaveBeenCalledWith({ tenantId: 'tenant-1' });
  });

  it('forwards an empty subject when the authenticated session has no tenant', () => {
    const reflector = new Reflector();
    jest
      .spyOn(reflector, 'getAllAndOverride')
      .mockReturnValue([envProvisioning]);
    const resolver = makeResolver([envProvisioning]);
    const guard = new CapabilityGuard(reflector, resolver);

    expect(guard.canActivate(makeContext({ user: { id: 'user-1' } }))).toBe(
      true,
    );
    expect(resolver.for).toHaveBeenCalledWith({});
  });

  it('reads required keys from the shared capability metadata key', () => {
    const reflector = new Reflector();
    const getAllAndOverride = jest
      .spyOn(reflector, 'getAllAndOverride')
      .mockReturnValue(undefined);
    const resolver = makeResolver([]);
    const guard = new CapabilityGuard(reflector, resolver);

    guard.canActivate(makeContext({}));

    expect(getAllAndOverride).toHaveBeenCalledWith(
      REQUIRED_CAPABILITIES,
      expect.any(Array),
    );
  });
});
