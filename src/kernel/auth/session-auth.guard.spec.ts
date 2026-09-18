import { UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { SessionAuthGuard } from '#kernel/auth/session-auth.guard.js';
import { Reflector } from '@nestjs/core';
import {
  SESSION_USER_LOOKUP,
  type SessionUserLookup,
} from '#kernel/auth/session-user-lookup.contract.js';
import type { ExecutionContext } from '@nestjs/common';
import type { SessionUser } from '#kernel/auth/session-user.interface.js';
import type {
  TenantContext,
  TenantContextPort,
  TenantContextResolverPort,
} from '#kernel/tenancy/tenant-context.port.js';

const fakeUser: SessionUser = {
  id: 'user-1',
  login: 'testuser',
  onboardingCompleted: false,
  isInternal: false,
};

const makeContext = (session: Record<string, unknown>) =>
  ({
    switchToHttp: () => ({
      getRequest: () => ({ session }),
    }),
    getHandler: () => function handler() {},
    getClass: () => function Controller() {},
  }) as unknown as ExecutionContext;

const makeSessionUserLookup = () =>
  ({
    findSessionUser: jest.fn().mockResolvedValue(fakeUser),
  }) as unknown as SessionUserLookup;

describe('SessionAuthGuard', () => {
  let guard: SessionAuthGuard;
  let sessionUserLookup: SessionUserLookup;

  beforeEach(async () => {
    sessionUserLookup = makeSessionUserLookup();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SessionAuthGuard,
        { provide: SESSION_USER_LOOKUP, useValue: sessionUserLookup },
      ],
    }).compile();

    guard = module.get(SessionAuthGuard);
  });

  it('should be defined', () => {
    expect(guard).toBeDefined();
  });

  it('returns true when session.user is set', async () => {
    const ctx = makeContext({ user: fakeUser });
    const result = await guard.canActivate(ctx);
    expect(result).toBe(true);
  });

  it('throws UnauthorizedException when session has neither user nor userId', async () => {
    const ctx = makeContext({});
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it('loads user from repo when userId is set but user is missing', async () => {
    const session: Record<string, unknown> = { userId: 'user-1' };
    const ctx = makeContext(session);
    const result = await guard.canActivate(ctx);

    expect(sessionUserLookup.findSessionUser).toHaveBeenCalledWith('user-1');
    expect(result).toBe(true);
    expect(session['user']).toEqual(fakeUser);
  });

  it('throws UnauthorizedException when userId is set but user not found in repo', async () => {
    (sessionUserLookup.findSessionUser as jest.Mock).mockResolvedValueOnce(
      null,
    );
    const ctx = makeContext({ userId: 'unknown' });
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it('stores a membership-validated tenant context and normalizes the session selector', async () => {
    let activeContext: TenantContext | null = null;
    const store: TenantContextPort = {
      current: () => activeContext,
      require: () => {
        if (!activeContext) throw new Error('context not set');
        return activeContext;
      },
      set: (context) => {
        activeContext = context;
      },
      clear: () => {
        activeContext = null;
      },
    };
    const resolver: TenantContextResolverPort = {
      resolveForSession: jest.fn().mockResolvedValue({
        tenantId: 'tenant-1',
        userId: 'user-1',
        membershipRole: 'member',
        deploymentMode: 'hosted',
      }),
    };
    const guarded = new SessionAuthGuard(sessionUserLookup, resolver, store);
    const session = { user: fakeUser, tenantId: 'untrusted-selector' };

    await expect(guarded.canActivate(makeContext(session))).resolves.toBe(true);
    expect(resolver.resolveForSession).toHaveBeenCalledWith(
      'user-1',
      'untrusted-selector',
    );
    expect(session.tenantId).toBe('tenant-1');
    expect(store.require().tenantId).toBe('tenant-1');
  });

  it('clears an inherited tenant context before rejecting an unauthenticated request', async () => {
    let activeContext: TenantContext | null = {
      tenantId: 'tenant-1',
      userId: 'user-1',
      membershipRole: 'member',
      deploymentMode: 'hosted',
    };
    const store: TenantContextPort = {
      current: () => activeContext,
      require: () => {
        if (!activeContext) throw new Error('context not set');
        return activeContext;
      },
      set: (context) => {
        activeContext = context;
      },
      clear: () => {
        activeContext = null;
      },
    };
    const resolver: TenantContextResolverPort = {
      resolveForSession: jest.fn(),
    };
    const guarded = new SessionAuthGuard(sessionUserLookup, resolver, store);

    await expect(guarded.canActivate(makeContext({}))).rejects.toThrow(
      UnauthorizedException,
    );
    expect(store.current()).toBeNull();
    expect(resolver.resolveForSession).not.toHaveBeenCalled();
  });

  it('authenticates explicitly global routes without requiring tenant membership', async () => {
    let activeContext: TenantContext | null = {
      tenantId: 'tenant-1',
      userId: 'user-1',
      membershipRole: 'member',
      deploymentMode: 'hosted',
    };
    const store: TenantContextPort = {
      current: () => activeContext,
      require: () => {
        if (!activeContext) throw new Error('context not set');
        return activeContext;
      },
      set: (context) => {
        activeContext = context;
      },
      clear: () => {
        activeContext = null;
      },
    };
    const resolver: TenantContextResolverPort = {
      resolveForSession: jest.fn(),
    };
    const reflector = new Reflector();
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValueOnce(true);
    const guarded = new SessionAuthGuard(
      sessionUserLookup,
      resolver,
      store,
      reflector,
    );

    await expect(
      guarded.canActivate(makeContext({ user: fakeUser })),
    ).resolves.toBe(true);
    expect(resolver.resolveForSession).not.toHaveBeenCalled();
    expect(store.current()).toBeNull();
  });
});
