import { UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { SessionAuthGuard } from '#kernel/auth/session-auth.guard.js';
import {
  SESSION_USER_LOOKUP,
  type SessionUserLookup,
} from '#kernel/auth/session-user-lookup.contract.js';
import type { ExecutionContext } from '@nestjs/common';
import type { SessionUser } from '#kernel/auth/session-user.interface.js';

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
});
