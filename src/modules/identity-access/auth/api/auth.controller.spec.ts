import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { AuthController } from './auth.controller.js';
import { AuthService } from '../application/auth.service.js';
import { SelfServeAuthService } from '../application/self-serve-auth.service.js';
import { SubscriptionService } from '#modules/billing/subscription/application/subscription.service.js';
import { ConfigService } from '@nestjs/config';
import { PlatformAdminAccessService } from '#modules/identity-access/admin/application/platform-admin-access.service.js';
import { SessionAuthGuard } from '#kernel/auth/session-auth.guard.js';
import { CapabilityGuard } from '#kernel/composition/capability.guard.js';
import { SUBSCRIPTION_ACCESS } from '#kernel/auth/subscription-access.port.js';
import type { Request, Response } from 'express';
import type {
  SessionUser,
  SubscriptionState,
} from '#kernel/auth/session-user.interface.js';

const fakeUser: SessionUser = {
  id: 'user-1',
  login: 'testuser',
  onboardingCompleted: false,
  isInternal: false,
};

const fakeFreeSub: SubscriptionState = {
  plan: 'free',
  status: 'inactive',
  provider: 'supabase',
  updatedAt: '2026-01-01T00:00:00Z',
};

const makeRequest = (
  user?: SessionUser,
  sessionExtra: Record<string, unknown> = {},
) =>
  ({
    session: {
      user,
      ...sessionExtra,
      save: jest.fn().mockImplementation((cb: (err: null) => void) => cb(null)),
      destroy: jest
        .fn()
        .mockImplementation((cb: (err: null) => void) => cb(null)),
    },
  }) as unknown as Request;

const makeResponse = () => {
  const res = {
    redirect: jest.fn(),
    clearCookie: jest.fn(),
  };
  return res as unknown as Response;
};

const makeAuthService = () =>
  ({
    startGitHubAuth: jest
      .fn()
      .mockReturnValue('https://github.com/login/oauth/authorize?mock=1'),
    handleGitHubCallback: jest
      .fn()
      .mockResolvedValue('http://localhost:3000?auth=success'),
    devQuickLogin: jest.fn().mockResolvedValue(undefined),
    getSessionUser: jest.fn().mockResolvedValue(fakeUser),
    logout: jest.fn().mockResolvedValue(undefined),
    deleteAccount: jest.fn().mockResolvedValue(undefined),
    getPendingArchivedAccount: jest.fn().mockResolvedValue({ pending: false }),
    restoreArchivedAccount: jest.fn().mockResolvedValue(undefined),
    startFreshAccount: jest.fn().mockResolvedValue(undefined),
  }) as unknown as AuthService;

const makeSubscriptionService = () =>
  ({
    getForUser: jest.fn().mockResolvedValue(fakeFreeSub),
  }) as unknown as SubscriptionService;

const makeSelfServeAuthService = () =>
  ({
    checkEmailSignupAvailability: jest
      .fn()
      .mockReturnValue({ ok: true, available: true }),
    startEmailSignup: jest
      .fn()
      .mockResolvedValue({ ok: true, verificationRequired: true }),
    verifyEmailSignupCode: jest.fn().mockResolvedValue({
      ok: true,
      authenticated: true,
      user: fakeUser,
    }),
    loginWithEmail: jest.fn().mockResolvedValue({
      ok: true,
      authenticated: true,
      user: fakeUser,
    }),
    resendEmailSignupCode: jest
      .fn()
      .mockResolvedValue({ ok: true, verificationRequired: true }),
    startGoogleAuth: jest
      .fn()
      .mockResolvedValue('https://accounts.google.com/o/oauth2/mock'),
    handleGoogleCallback: jest
      .fn()
      .mockResolvedValue('http://localhost:3000/auth/callback?auth=success'),
    claimSessionHandoff: jest
      .fn()
      .mockResolvedValue({ ok: true, auth: 'success' }),
  }) as unknown as SelfServeAuthService;

const makeConfigService = () =>
  ({
    getOrThrow: jest
      .fn()
      .mockReturnValue({ session: { name: 'cicd_workflow_sid' } }),
  }) as unknown as ConfigService;

const makePlatformAdminAccessService = () =>
  ({
    findRole: jest.fn().mockResolvedValue(null),
    findAppRole: jest.fn().mockResolvedValue('member'),
    findAppRoleWithSource: jest
      .fn()
      .mockResolvedValue({ role: 'member', source: 'github_team' }),
  }) as unknown as PlatformAdminAccessService;

describe('AuthController', () => {
  let controller: AuthController;
  let authService: AuthService;
  let subscriptionService: SubscriptionService;
  let selfServeAuthService: SelfServeAuthService;

  beforeEach(async () => {
    authService = makeAuthService();
    subscriptionService = makeSubscriptionService();
    selfServeAuthService = makeSelfServeAuthService();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: authService },
        {
          provide: SelfServeAuthService,
          useValue: selfServeAuthService,
        },
        { provide: SUBSCRIPTION_ACCESS, useValue: subscriptionService },
        {
          provide: PlatformAdminAccessService,
          useValue: makePlatformAdminAccessService(),
        },
        { provide: ConfigService, useValue: makeConfigService() },
      ],
    })
      .overrideGuard(SessionAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(CapabilityGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get(AuthController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('delegates self-serve email endpoints to the self-serve service', async () => {
    const req = makeRequest();
    const signup = {
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      password: 'password123',
    };
    const code = { email: signup.email, code: '123456' };

    controller.checkEmailSignupAvailability({ email: signup.email });
    await controller.startEmailSignup(signup);
    await controller.verifyEmailSignupCode(req, code);
    await controller.loginWithEmail(req, {
      email: signup.email,
      password: signup.password,
    });
    await controller.resendEmailSignupCode({ email: signup.email });

    expect(
      selfServeAuthService.checkEmailSignupAvailability,
    ).toHaveBeenCalledWith(signup.email);
    expect(selfServeAuthService.startEmailSignup).toHaveBeenCalledWith(signup);
    expect(selfServeAuthService.verifyEmailSignupCode).toHaveBeenCalledWith(
      req,
      code,
    );
    expect(selfServeAuthService.loginWithEmail).toHaveBeenCalledWith(req, {
      email: signup.email,
      password: signup.password,
    });
    expect(selfServeAuthService.resendEmailSignupCode).toHaveBeenCalledWith(
      signup.email,
    );
  });

  it('redirects Google start/callback and delegates the session claim', async () => {
    const req = makeRequest();
    const res = makeResponse();

    await controller.googleStart(res, 'http://localhost:3000/dashboard');
    await controller.googleCallback(req, res, 'code-1', 'state-1');
    await controller.claimSessionHandoff(req, { token: 'handoff-token' });

    expect(selfServeAuthService.startGoogleAuth).toHaveBeenCalledWith(
      'http://localhost:3000/dashboard',
    );
    expect(selfServeAuthService.handleGoogleCallback).toHaveBeenCalledWith(
      req,
      'code-1',
      'state-1',
    );
    expect(selfServeAuthService.claimSessionHandoff).toHaveBeenCalledWith(
      req,
      'handoff-token',
    );
    expect(res.redirect).toHaveBeenCalledTimes(2);
  });

  it('delegates development Quick login to the auth service', async () => {
    const req = makeRequest();

    await controller.devQuickLogin(req);

    expect(authService.devQuickLogin).toHaveBeenCalledWith(req);
  });

  describe('githubStart', () => {
    it('redirects to GitHub auth URL', async () => {
      const req = makeRequest();
      const res = makeResponse();
      await controller.githubStart(req, res);
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(res.redirect).toHaveBeenCalledWith(
        'https://github.com/login/oauth/authorize?mock=1',
      );
    });
  });

  describe('githubCallback', () => {
    it('redirects to success URL after callback', async () => {
      const req = makeRequest();
      const res = makeResponse();
      await controller.githubCallback(req, res, 'code123', 'state-abc');
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(authService.handleGitHubCallback).toHaveBeenCalledWith(
        req,
        'code123',
        'state-abc',
      );
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(res.redirect).toHaveBeenCalledWith(
        'http://localhost:3000?auth=success',
      );
    });
  });

  describe('me', () => {
    it('returns authenticated user with subscription', async () => {
      const req = makeRequest(fakeUser);
      const result = await controller.me(req);
      expect(result).toMatchObject({
        authenticated: true,
        user: fakeUser,
        subscription: fakeFreeSub,
      });
    });

    it('returns unauthenticated when no user', async () => {
      (authService.getSessionUser as jest.Mock).mockResolvedValueOnce(null);
      const req = makeRequest();
      const result = await controller.me(req);
      expect(result).toEqual({ authenticated: false });
    });
  });

  describe('logout', () => {
    it('calls logout and clears cookie', async () => {
      const req = makeRequest(fakeUser);
      const res = makeResponse();
      const result = await controller.logout(req, res);
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(authService.logout).toHaveBeenCalledWith(req);
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(res.clearCookie).toHaveBeenCalledWith('cicd_workflow_sid');
      expect(result).toEqual({ ok: true });
    });
  });

  describe('deleteAccount', () => {
    it('calls archiveById via deleteAccount and returns { ok, archived }', async () => {
      const req = makeRequest(fakeUser);
      const res = makeResponse();
      const result = await controller.deleteAccount(req, res);

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(authService.deleteAccount).toHaveBeenCalledWith(req);
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(res.clearCookie).toHaveBeenCalledWith('cicd_workflow_sid');
      expect(result).toEqual({ ok: true, archived: true });
    });

    it('throws UnauthorizedException when no user in session', async () => {
      const req = makeRequest();
      const res = makeResponse();
      await expect(controller.deleteAccount(req, res)).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('getPendingArchivedAccount', () => {
    it('returns { pending: false } when service returns pending false', async () => {
      const req = makeRequest();
      const result = await controller.getPendingArchivedAccount(req);
      expect(result).toEqual({ pending: false });
    });

    it('returns pending info when service returns pending true', async () => {
      const pendingInfo = {
        pending: true as const,
        login: 'testuser',
        archivedAt: '2026-05-01T00:00:00.000Z',
        purgeAt: '2026-05-31T00:00:00.000Z',
        retentionDays: 30,
      };
      (
        authService.getPendingArchivedAccount as jest.Mock
      ).mockResolvedValueOnce(pendingInfo);
      const req = makeRequest();
      const result = await controller.getPendingArchivedAccount(req);
      expect(result).toEqual(pendingInfo);
    });
  });

  describe('restoreArchivedAccount', () => {
    it('returns { ok, restored } when pendingArchived is in session', async () => {
      const req = makeRequest(undefined, {
        pendingArchived: {
          githubUserId: '12345',
          login: 'testuser',
          accessToken: 'tok',
        },
      });
      const result = await controller.restoreArchivedAccount(req);
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(authService.restoreArchivedAccount).toHaveBeenCalledWith(req);
      expect(result).toEqual({ ok: true, restored: true });
    });

    it('throws UnauthorizedException when no pendingArchived in session', async () => {
      const req = makeRequest(undefined, {});
      await expect(controller.restoreArchivedAccount(req)).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('startFreshAccount', () => {
    it('returns { ok, created } when pendingArchived is in session', async () => {
      const req = makeRequest(undefined, {
        pendingArchived: {
          githubUserId: '12345',
          login: 'testuser',
          accessToken: 'tok',
        },
      });
      const result = await controller.startFreshAccount(req);
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(authService.startFreshAccount).toHaveBeenCalledWith(req);
      expect(result).toEqual({ ok: true, created: true });
    });

    it('throws UnauthorizedException when no pendingArchived in session', async () => {
      const req = makeRequest(undefined, {});
      await expect(controller.startFreshAccount(req)).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });
});
