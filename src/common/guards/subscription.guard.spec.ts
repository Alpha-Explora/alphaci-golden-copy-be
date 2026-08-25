import { HttpStatus, UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { SubscriptionGuard } from './subscription.guard.js';
import { SubscriptionService } from '../../modules/subscription/index.js';
import type { ExecutionContext } from '@nestjs/common';
import type {
  SessionUser,
  SubscriptionState,
} from '../interfaces/session-user.interface.js';

const fakeUser: SessionUser = {
  id: 'user-1',
  login: 'testuser',
  onboardingCompleted: false,
  isInternal: false,
};

const makeContext = (user: SessionUser | undefined) =>
  ({
    switchToHttp: () => ({
      getRequest: () => ({ session: { user } }),
    }),
  }) as unknown as ExecutionContext;

const makeSubscriptionService = (
  status: SubscriptionState['status'] = 'active',
) =>
  ({
    getForUser: jest.fn().mockResolvedValue({
      plan: status === 'active' ? 'pro' : 'free',
      status,
      provider: 'manual',
      updatedAt: '2026-01-01T00:00:00Z',
    } as SubscriptionState),
  }) as unknown as SubscriptionService;

describe('SubscriptionGuard', () => {
  let guard: SubscriptionGuard;

  const build = async (status: SubscriptionState['status'] = 'active') => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SubscriptionGuard,
        {
          provide: SubscriptionService,
          useValue: makeSubscriptionService(status),
        },
      ],
    }).compile();
    return module.get(SubscriptionGuard);
  };

  it('should be defined', async () => {
    guard = await build();
    expect(guard).toBeDefined();
  });

  it('throws UnauthorizedException when no user in session', async () => {
    guard = await build();
    const ctx = makeContext(undefined);
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it('returns true when user has active subscription', async () => {
    guard = await build('active');
    const ctx = makeContext(fakeUser);
    const result = await guard.canActivate(ctx);
    expect(result).toBe(true);
  });

  it('throws 402 when subscription is inactive', async () => {
    guard = await build('inactive');
    const ctx = makeContext(fakeUser);
    await expect(guard.canActivate(ctx)).rejects.toMatchObject({
      status: HttpStatus.PAYMENT_REQUIRED,
    });
  });
});
