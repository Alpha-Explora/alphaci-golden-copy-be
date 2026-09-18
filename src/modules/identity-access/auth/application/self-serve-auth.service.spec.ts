import { UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Request } from 'express';

import type { SessionUser } from '#kernel/auth/session-user.interface.js';
import type { AppConfig } from '#kernel/config/app.config.js';
import type { SubscriptionBootstrapPort } from '#kernel/ports/subscription-bootstrap.port.js';
import type { AuthSessionHandoffRepository } from '../infrastructure/auth-session-handoff.repository.js';
import type { EmailVerificationCodesRepository } from '../infrastructure/email-verification-codes.repository.js';
import type { OAuthStateRepository } from '../infrastructure/oauth-state.repository.js';
import type {
  UserIdentitiesRepository,
  LinkedIdentity,
} from '../infrastructure/user-identities.repository.js';
import type { UsersRepository } from '../infrastructure/users.repository.js';
import { EmailCodeDeliveryService } from './email-code-delivery.service.js';
import type { GoogleOAuthPort } from './google-oauth.port.js';
import { PasswordHasherService } from './password-hasher.service.js';
import { SelfServeAuthService } from './self-serve-auth.service.js';

const fakeUser: SessionUser = {
  id: 'user-1',
  login: 'ada',
  onboardingCompleted: false,
  isInternal: false,
};

const pendingIdentity: LinkedIdentity = {
  id: 'identity-1',
  userId: fakeUser.id,
  provider: 'email',
  providerUserId: 'ada@example.com',
  email: 'ada@example.com',
  normalizedEmail: 'ada@example.com',
  emailVerified: false,
  passwordHash: 'password-hash',
  displayName: 'Ada Lovelace',
  archivedAt: null,
};

function makeConfigService(): ConfigService {
  const app = {
    frontendUrl: 'http://localhost:3000',
    email: {
      codeDelivery: 'log',
      provider: null,
      apiKey: '',
      from: '',
    },
  } as unknown as AppConfig;

  return {
    getOrThrow: jest.fn().mockReturnValue(app),
    get: jest.fn((key: string) => {
      if (key === 'ALLOWED_ORIGINS') return 'http://localhost:3000';
      if (key === 'NODE_ENV') return 'test';
      return undefined;
    }),
  } as unknown as ConfigService;
}

function makeRequest(): Request {
  const session = {
    regenerate: jest.fn((callback: (error: Error | null) => void) => {
      callback(null);
    }),
    save: jest.fn((callback: (error: Error | null) => void) => {
      callback(null);
    }),
  };

  return { session } as unknown as Request;
}

function makeService() {
  const usersRepository = {
    createFederatedUser: jest.fn().mockResolvedValue(fakeUser),
    findById: jest.fn().mockResolvedValue(fakeUser),
    findByGoogleUserIdIncludingArchived: jest.fn().mockResolvedValue(null),
  } as unknown as UsersRepository;
  const userIdentitiesRepository = {
    findByProviderIdentity: jest.fn().mockResolvedValue(null),
    findActiveUserIdsByVerifiedEmail: jest.fn().mockResolvedValue([]),
    upsertIdentity: jest.fn().mockResolvedValue(pendingIdentity),
  } as unknown as UserIdentitiesRepository;
  const emailVerificationCodesRepository = {
    create: jest.fn().mockResolvedValue({ id: 'code-1' }),
    findLatestActive: jest.fn(),
    incrementAttempt: jest.fn().mockResolvedValue(undefined),
    consumeAllForEmail: jest.fn().mockResolvedValue(undefined),
  } as unknown as EmailVerificationCodesRepository;
  const authSessionHandoffRepository = {
    save: jest.fn().mockResolvedValue(undefined),
    findAndDelete: jest.fn(),
    pruneExpired: jest.fn().mockResolvedValue(undefined),
  } as unknown as AuthSessionHandoffRepository;
  const passwordHasher = {
    hash: jest.fn().mockResolvedValue('password-hash'),
    verify: jest.fn().mockResolvedValue(true),
  } as unknown as PasswordHasherService;
  const emailCodeDelivery = {
    ensureReady: jest.fn(),
    sendCode: jest.fn().mockResolvedValue(undefined),
  } as unknown as EmailCodeDeliveryService;
  const oauthStateRepository = {
    save: jest.fn().mockResolvedValue(undefined),
    findAndDelete: jest.fn(),
    pruneExpired: jest.fn().mockResolvedValue(undefined),
  } as unknown as OAuthStateRepository;
  const googleOAuth = {
    isConfigured: jest.fn().mockReturnValue(true),
    authorizationUrl: jest
      .fn()
      .mockReturnValue('https://accounts.google.com/mock'),
    exchangeCode: jest.fn(),
  } as unknown as GoogleOAuthPort;
  const subscriptionsRepository = {
    ensureDefaultFreeSubscription: jest.fn().mockResolvedValue(undefined),
  } as unknown as SubscriptionBootstrapPort;

  const service = new SelfServeAuthService(
    makeConfigService(),
    usersRepository,
    userIdentitiesRepository,
    emailVerificationCodesRepository,
    authSessionHandoffRepository,
    passwordHasher,
    emailCodeDelivery,
    oauthStateRepository,
    googleOAuth,
    subscriptionsRepository,
  );

  return {
    service,
    usersRepository,
    userIdentitiesRepository,
    emailVerificationCodesRepository,
    authSessionHandoffRepository,
    passwordHasher,
    emailCodeDelivery,
    oauthStateRepository,
    googleOAuth,
    subscriptionsRepository,
  };
}

describe('SelfServeAuthService', () => {
  it('creates a pending email identity and sends a verification code', async () => {
    const {
      service,
      usersRepository,
      userIdentitiesRepository,
      emailVerificationCodesRepository,
      emailCodeDelivery,
      passwordHasher,
    } = makeService();

    await expect(
      service.startEmailSignup({
        firstName: 'Ada',
        lastName: 'Lovelace',
        email: ' ADA@EXAMPLE.COM ',
        password: 'password123',
      }),
    ).resolves.toEqual({ ok: true, verificationRequired: true });

    expect(emailCodeDelivery.ensureReady).toHaveBeenCalledTimes(1);
    expect(usersRepository.createFederatedUser).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'ada@example.com',
        provider: 'email',
        providerUserId: 'ada@example.com',
      }),
    );
    expect(passwordHasher.hash).toHaveBeenCalledWith('password123');
    expect(emailVerificationCodesRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        normalizedEmail: 'ada@example.com',
        codeHash: 'password-hash',
        purpose: 'signup',
        pendingIdentityId: pendingIdentity.id,
      }),
    );
    expect(emailCodeDelivery.sendCode).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'ada@example.com',
        purpose: 'signup',
        code: expect.stringMatching(/^\d{6}$/),
      }),
    );
    expect(userIdentitiesRepository.upsertIdentity).toHaveBeenCalled();
  });

  it('verifies the code, provisions the free entitlement, and establishes a session', async () => {
    const {
      service,
      emailVerificationCodesRepository,
      userIdentitiesRepository,
      subscriptionsRepository,
    } = makeService();
    emailVerificationCodesRepository.findLatestActive = jest
      .fn()
      .mockResolvedValue({
        id: 'code-1',
        normalizedEmail: 'ada@example.com',
        codeHash: 'code-hash',
        pendingIdentityId: pendingIdentity.id,
        attemptCount: 0,
        sentCount: 1,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
    userIdentitiesRepository.findByProviderIdentity = jest
      .fn()
      .mockResolvedValue(pendingIdentity);
    userIdentitiesRepository.upsertIdentity = jest.fn().mockResolvedValue({
      ...pendingIdentity,
      emailVerified: true,
    });

    const request = makeRequest();
    await expect(
      service.verifyEmailSignupCode(request, {
        email: 'ADA@example.com',
        code: '123456',
      }),
    ).resolves.toMatchObject({ ok: true, authenticated: true, user: fakeUser });

    expect(
      emailVerificationCodesRepository.consumeAllForEmail,
    ).toHaveBeenCalledWith('ada@example.com', 'signup');
    expect(
      subscriptionsRepository.ensureDefaultFreeSubscription,
    ).toHaveBeenCalledWith(fakeUser.id);
    expect(request.session.userId).toBe(fakeUser.id);
  });

  it('rejects an invalid code and increments its attempt counter', async () => {
    const { service, emailVerificationCodesRepository, passwordHasher } =
      makeService();
    emailVerificationCodesRepository.findLatestActive = jest
      .fn()
      .mockResolvedValue({
        id: 'code-1',
        normalizedEmail: 'ada@example.com',
        codeHash: 'code-hash',
        pendingIdentityId: pendingIdentity.id,
        attemptCount: 0,
        sentCount: 1,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
    passwordHasher.verify = jest.fn().mockResolvedValue(false);

    await expect(
      service.verifyEmailSignupCode(makeRequest(), {
        email: 'ada@example.com',
        code: '000000',
      }),
    ).rejects.toThrow(
      new UnauthorizedException('Invalid or expired verification code'),
    );
    expect(
      emailVerificationCodesRepository.incrementAttempt,
    ).toHaveBeenCalledWith('code-1');
  });

  it('logs in a verified email identity and refreshes the session', async () => {
    const { service, userIdentitiesRepository, subscriptionsRepository } =
      makeService();
    userIdentitiesRepository.findByProviderIdentity = jest
      .fn()
      .mockResolvedValue({ ...pendingIdentity, emailVerified: true });

    const request = makeRequest();
    await expect(
      service.loginWithEmail(request, {
        email: 'ada@example.com',
        password: 'password123',
      }),
    ).resolves.toMatchObject({ ok: true, authenticated: true, user: fakeUser });
    expect(
      subscriptionsRepository.ensureDefaultFreeSubscription,
    ).toHaveBeenCalledWith(fakeUser.id);
    expect(request.session.userId).toBe(fakeUser.id);
  });

  it('stores a Google OAuth state only for an allowed return origin', async () => {
    const { service, oauthStateRepository, googleOAuth } = makeService();

    await expect(
      service.startGoogleAuth('https://evil.example.com/account'),
    ).resolves.toBe('https://accounts.google.com/mock');
    expect(oauthStateRepository.save).toHaveBeenCalledWith(
      expect.any(String),
      'http://localhost:3000',
      'google',
    );
    (oauthStateRepository.save as unknown as jest.Mock).mockClear();

    await expect(
      service.startGoogleAuth('http://localhost:3000/auth/callback'),
    ).resolves.toBe('https://accounts.google.com/mock');
    expect(oauthStateRepository.save).toHaveBeenCalledWith(
      expect.any(String),
      'http://localhost:3000/auth/callback',
      'google',
    );
    expect(googleOAuth.authorizationUrl).toHaveBeenCalledWith(
      expect.any(String),
    );
  });
});
