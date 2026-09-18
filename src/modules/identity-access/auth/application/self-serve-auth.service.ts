import { randomInt, randomUUID } from 'node:crypto';

import {
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';

import type { SessionUser } from '#kernel/auth/session-user.interface.js';
import type { AppConfig } from '#kernel/config/app.config.js';
import {
  SUBSCRIPTION_BOOTSTRAP,
  type SubscriptionBootstrapPort,
} from '#kernel/ports/subscription-bootstrap.port.js';
import { AuthSessionHandoffRepository } from '../infrastructure/auth-session-handoff.repository.js';
import { EmailVerificationCodesRepository } from '../infrastructure/email-verification-codes.repository.js';
import { OAuthStateRepository } from '../infrastructure/oauth-state.repository.js';
import { UserIdentitiesRepository } from '../infrastructure/user-identities.repository.js';
import { UsersRepository } from '../infrastructure/users.repository.js';
import { EmailCodeDeliveryService } from './email-code-delivery.service.js';
import {
  GOOGLE_OAUTH,
  type GoogleOAuthPort,
  type GoogleProfile,
} from './google-oauth.port.js';
import { PasswordHasherService } from './password-hasher.service.js';

const VERIFICATION_CODE_TTL_MS = 10 * 60 * 1000;
const MAX_VERIFICATION_ATTEMPTS = 5;
const GENERIC_VERIFICATION_ERROR = 'Invalid or expired verification code';
const GENERIC_LOGIN_ERROR = 'Invalid email or password';
const GENERIC_GOOGLE_ERROR = 'Google authentication failed';

export interface EmailSignupInput {
  firstName: string;
  lastName: string;
  email: string;
  password: string;
}

export interface EmailCodeInput {
  email: string;
  code: string;
}

export interface EmailLoginInput {
  email: string;
  password: string;
}

export interface AuthenticatedSelfServeResponse {
  ok: true;
  authenticated: true;
  user: SessionUser;
}

export interface VerificationRequiredResponse {
  ok: true;
  verificationRequired: true;
}

@Injectable()
export class SelfServeAuthService {
  private readonly logger = new Logger(SelfServeAuthService.name);
  private readonly config: AppConfig;
  private readonly returnToOrigins: Set<string>;
  private readonly returnToOriginPatterns: RegExp[];

  constructor(
    private readonly configService: ConfigService,
    private readonly usersRepository: UsersRepository,
    private readonly userIdentitiesRepository: UserIdentitiesRepository,
    private readonly emailVerificationCodesRepository: EmailVerificationCodesRepository,
    private readonly authSessionHandoffRepository: AuthSessionHandoffRepository,
    private readonly passwordHasher: PasswordHasherService,
    private readonly emailCodeDelivery: EmailCodeDeliveryService,
    private readonly oauthStateRepository: OAuthStateRepository,
    @Inject(GOOGLE_OAUTH)
    private readonly googleOAuth: GoogleOAuthPort,
    @Inject(SUBSCRIPTION_BOOTSTRAP)
    private readonly subscriptionsRepository: SubscriptionBootstrapPort,
  ) {
    this.config = this.configService.getOrThrow<AppConfig>('app');
    this.returnToOrigins = this.buildReturnToOrigins(
      this.config.frontendUrl,
      this.configService.get<string>('ALLOWED_ORIGINS'),
    );
    this.returnToOriginPatterns = this.buildReturnToOriginPatterns(
      this.configService.get<string>('ALLOWED_ORIGIN_PATTERNS'),
    );
  }

  /**
   * This endpoint is intentionally a non-authoritative UI hint. It never
   * queries identity data, so it cannot disclose whether an account exists.
   */
  checkEmailSignupAvailability(email: string): {
    ok: true;
    available: true;
  } {
    void email;
    return { ok: true, available: true };
  }

  async startEmailSignup(
    input: EmailSignupInput,
  ): Promise<VerificationRequiredResponse> {
    // Check delivery readiness before any identity lookup. This keeps a
    // missing provider from turning this public endpoint into an account
    // existence oracle.
    this.emailCodeDelivery.ensureReady();

    const email = normalizeEmail(input.email);
    const displayName =
      `${input.firstName.trim()} ${input.lastName.trim()}`.trim();
    let identity = await this.userIdentitiesRepository.findByProviderIdentity(
      'email',
      email,
    );

    if (identity?.archivedAt || identity?.emailVerified) {
      return verificationRequiredResponse();
    }

    const passwordHash = await this.passwordHasher.hash(input.password);

    if (!identity) {
      const existingUserIds =
        await this.userIdentitiesRepository.findActiveUserIdsByVerifiedEmail(
          email,
        );
      if (existingUserIds.length > 0) {
        return verificationRequiredResponse();
      }

      const user = await this.usersRepository.createFederatedUser({
        login: email.split('@')[0] ?? email,
        name: displayName,
        email,
        provider: 'email',
        providerUserId: email,
      });

      identity = await this.userIdentitiesRepository.upsertIdentity({
        userId: user.id,
        provider: 'email',
        providerUserId: email,
        email,
        emailVerified: false,
        passwordHash,
        displayName,
      });
    } else {
      identity = await this.userIdentitiesRepository.upsertIdentity({
        userId: identity.userId,
        provider: 'email',
        providerUserId: email,
        email,
        emailVerified: false,
        passwordHash,
        displayName,
      });
    }

    await this.sendEmailVerificationCode(email, identity.id);
    return verificationRequiredResponse();
  }

  async verifyEmailSignupCode(
    request: Request,
    input: EmailCodeInput,
  ): Promise<AuthenticatedSelfServeResponse> {
    const email = normalizeEmail(input.email);
    const record = await this.emailVerificationCodesRepository.findLatestActive(
      email,
      'signup',
    );

    if (!record || record.attemptCount >= MAX_VERIFICATION_ATTEMPTS) {
      throw new UnauthorizedException(GENERIC_VERIFICATION_ERROR);
    }

    const matches = await this.passwordHasher.verify(
      input.code,
      record.codeHash,
    );
    if (!matches) {
      await this.emailVerificationCodesRepository.incrementAttempt(record.id);
      throw new UnauthorizedException(GENERIC_VERIFICATION_ERROR);
    }

    const identity = await this.userIdentitiesRepository.findByProviderIdentity(
      'email',
      email,
    );
    if (
      !identity ||
      identity.archivedAt ||
      identity.emailVerified ||
      (record.pendingIdentityId !== null &&
        record.pendingIdentityId !== identity.id) ||
      !identity.passwordHash
    ) {
      throw new UnauthorizedException(GENERIC_VERIFICATION_ERROR);
    }

    await this.emailVerificationCodesRepository.consumeAllForEmail(
      email,
      'signup',
    );
    const verifiedIdentity = await this.userIdentitiesRepository.upsertIdentity(
      {
        userId: identity.userId,
        provider: 'email',
        providerUserId: email,
        email,
        emailVerified: true,
        passwordHash: identity.passwordHash,
        ...(identity.displayName ? { displayName: identity.displayName } : {}),
      },
    );
    const user = await this.usersRepository.findById(verifiedIdentity.userId);

    if (!user) {
      throw new UnauthorizedException(GENERIC_VERIFICATION_ERROR);
    }

    await this.subscriptionsRepository.ensureDefaultFreeSubscription(user.id);
    await this.establishSession(request, user);
    await this.saveSession(request);
    return authenticatedResponse(user);
  }

  async loginWithEmail(
    request: Request,
    input: EmailLoginInput,
  ): Promise<AuthenticatedSelfServeResponse> {
    const email = normalizeEmail(input.email);
    const identity = await this.userIdentitiesRepository.findByProviderIdentity(
      'email',
      email,
    );

    if (
      !identity ||
      identity.archivedAt ||
      !identity.emailVerified ||
      !identity.passwordHash
    ) {
      throw new UnauthorizedException(GENERIC_LOGIN_ERROR);
    }

    let matches = false;
    try {
      matches = await this.passwordHasher.verify(
        input.password,
        identity.passwordHash,
      );
    } catch {
      matches = false;
    }

    if (!matches) {
      throw new UnauthorizedException(GENERIC_LOGIN_ERROR);
    }

    const user = await this.usersRepository.findById(identity.userId);
    if (!user) {
      throw new UnauthorizedException(GENERIC_LOGIN_ERROR);
    }

    await this.subscriptionsRepository.ensureDefaultFreeSubscription(user.id);
    await this.establishSession(request, user);
    await this.saveSession(request);
    return authenticatedResponse(user);
  }

  async resendEmailSignupCode(
    emailInput: string,
  ): Promise<VerificationRequiredResponse> {
    this.emailCodeDelivery.ensureReady();

    const email = normalizeEmail(emailInput);
    const identity = await this.userIdentitiesRepository.findByProviderIdentity(
      'email',
      email,
    );

    if (identity && !identity.archivedAt && !identity.emailVerified) {
      await this.sendEmailVerificationCode(email, identity.id);
    }

    return verificationRequiredResponse();
  }

  async startGoogleAuth(returnTo?: string): Promise<string> {
    const safeReturnTo = this.normalizeReturnTo(returnTo);
    if (!this.googleOAuth.isConfigured()) {
      return this.withQuery(safeReturnTo, 'auth', 'unavailable');
    }

    try {
      const state = randomUUID();
      await this.oauthStateRepository.save(state, safeReturnTo, 'google');
      if (randomInt(100) < 5) {
        void this.oauthStateRepository.pruneExpired();
      }
      return this.googleOAuth.authorizationUrl(state);
    } catch (error) {
      this.logger.error(
        `Google OAuth start failed: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
      return this.withQuery(safeReturnTo, 'auth', 'failed');
    }
  }

  async handleGoogleCallback(
    request: Request,
    code?: string,
    state?: string,
  ): Promise<string> {
    const fallbackReturnTo = `${this.config.frontendUrl}/auth/callback`;
    const oauthRecord =
      code && state
        ? await this.oauthStateRepository.findAndDelete(state)
        : null;
    const returnTo = this.normalizeReturnTo(
      oauthRecord?.returnTo ?? fallbackReturnTo,
    );

    if (!code || !state || oauthRecord?.provider !== 'google') {
      return this.withQuery(returnTo, 'auth', 'invalid_state');
    }
    if (!this.googleOAuth.isConfigured()) {
      return this.withQuery(returnTo, 'auth', 'unavailable');
    }

    try {
      const profile = await this.googleOAuth.exchangeCode(code);
      const user = await this.resolveGoogleUser(profile);
      await this.subscriptionsRepository.ensureDefaultFreeSubscription(user.id);
      await this.establishSession(request, user);
      await this.saveSession(request);

      const handoffToken = randomUUID();
      await this.authSessionHandoffRepository.save(handoffToken, {
        kind: 'authenticated',
        user,
      });
      void this.authSessionHandoffRepository.pruneExpired();

      return this.withQuery(
        this.withQuery(returnTo, 'auth', 'success'),
        'handoff',
        handoffToken,
      );
    } catch (error) {
      this.logger.error(
        `Google OAuth callback failed: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
      return this.withQuery(returnTo, 'auth', 'failed');
    }
  }

  async claimSessionHandoff(
    request: Request,
    token: string,
  ): Promise<{ ok: true; auth: 'success' }> {
    const payload =
      await this.authSessionHandoffRepository.findAndDelete(token);
    if (!payload || payload.kind !== 'authenticated') {
      throw new UnauthorizedException('Invalid or expired session handoff');
    }

    const user = await this.usersRepository.findById(payload.user.id);
    if (!user) {
      throw new UnauthorizedException('Invalid or expired session handoff');
    }

    await this.establishSession(request, user);
    await this.saveSession(request);
    return { ok: true, auth: 'success' };
  }

  private async sendEmailVerificationCode(
    email: string,
    pendingIdentityId: string,
  ): Promise<void> {
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const codeHash = await this.passwordHasher.hash(code);
    await this.emailVerificationCodesRepository.consumeAllForEmail(
      email,
      'signup',
    );
    await this.emailVerificationCodesRepository.create({
      normalizedEmail: email,
      codeHash,
      purpose: 'signup',
      pendingIdentityId,
      expiresAt: new Date(Date.now() + VERIFICATION_CODE_TTL_MS),
    });
    await this.emailCodeDelivery.sendCode({
      email,
      code,
      purpose: 'signup',
    });
  }

  private async resolveGoogleUser(
    profile: GoogleProfile,
  ): Promise<SessionUser> {
    if (!profile.emailVerified) {
      throw new Error(GENERIC_GOOGLE_ERROR);
    }

    const email = normalizeEmail(profile.email);
    const existingIdentity =
      await this.userIdentitiesRepository.findByProviderIdentity(
        'google',
        profile.providerUserId,
      );

    if (existingIdentity?.archivedAt) {
      throw new Error(GENERIC_GOOGLE_ERROR);
    }

    let userId = existingIdentity?.userId;
    if (!userId) {
      const legacyGoogleUser =
        await this.usersRepository.findByGoogleUserIdIncludingArchived(
          profile.providerUserId,
        );
      if (legacyGoogleUser?.archivedAt) {
        throw new Error(GENERIC_GOOGLE_ERROR);
      }

      userId = legacyGoogleUser?.id;
    }

    if (!userId) {
      const matchingUserIds =
        await this.userIdentitiesRepository.findActiveUserIdsByVerifiedEmail(
          email,
        );
      if (matchingUserIds.length > 1) {
        throw new Error(GENERIC_GOOGLE_ERROR);
      }
      userId = matchingUserIds[0];
    }

    if (!userId) {
      const createdUser = await this.usersRepository.createFederatedUser({
        login: email.split('@')[0] ?? email,
        name: profile.name ?? email,
        email,
        ...(profile.avatarUrl ? { avatarUrl: profile.avatarUrl } : {}),
        provider: 'google',
        providerUserId: profile.providerUserId,
      });
      userId = createdUser.id;
    }

    const linkedIdentity = await this.userIdentitiesRepository.upsertIdentity({
      userId,
      provider: 'google',
      providerUserId: profile.providerUserId,
      email,
      emailVerified: true,
      ...(profile.name ? { displayName: profile.name } : {}),
      ...(profile.avatarUrl ? { avatarUrl: profile.avatarUrl } : {}),
    });
    const user = await this.usersRepository.findById(linkedIdentity.userId);
    if (!user) {
      throw new Error(GENERIC_GOOGLE_ERROR);
    }

    return user;
  }

  private async establishSession(
    request: Request,
    user: SessionUser,
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      request.session.regenerate((error) => {
        if (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
          return;
        }

        request.session.userId = user.id;
        request.session.user = user;
        delete request.session.oauthState;
        delete request.session.oauthReturnTo;
        delete request.session.oauthProvider;
        delete request.session.pendingArchived;
        resolve();
      });
    });
  }

  private saveSession(request: Request): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      request.session.save((error) => {
        if (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        resolve();
      });
    });
  }

  private normalizeReturnTo(returnTo?: string): string {
    if (!returnTo) {
      return this.config.frontendUrl;
    }

    if (returnTo.startsWith('/')) {
      return `${this.config.frontendUrl}${returnTo}`;
    }

    try {
      const parsed = new URL(returnTo);
      if (this.isAllowedReturnToOrigin(parsed.origin)) {
        return parsed.toString();
      }
    } catch {
      return this.config.frontendUrl;
    }

    return this.config.frontendUrl;
  }

  private isAllowedReturnToOrigin(origin: string): boolean {
    if (this.returnToOrigins.has(origin)) {
      return true;
    }

    return (
      origin.startsWith('https://') &&
      this.returnToOriginPatterns.some((pattern) => pattern.test(origin))
    );
  }

  private buildReturnToOrigins(
    frontendUrl: string,
    allowedOrigins?: string,
  ): Set<string> {
    const origins = new Set<string>();
    this.addReturnToOrigin(origins, frontendUrl);
    for (const origin of (allowedOrigins ?? '').split(',')) {
      this.addReturnToOrigin(origins, origin);
    }
    return origins;
  }

  private buildReturnToOriginPatterns(patterns?: string): RegExp[] {
    return (patterns ?? '')
      .split(',')
      .map((pattern) => pattern.trim())
      .filter(Boolean)
      .flatMap((pattern) => {
        try {
          return [new RegExp(`^${pattern}$`)];
        } catch {
          return [];
        }
      });
  }

  private addReturnToOrigin(origins: Set<string>, value: string): void {
    const trimmed = value.trim();
    if (!trimmed) return;

    try {
      origins.add(new URL(trimmed).origin);
    } catch {
      // Invalid origins are rejected by environment validation.
    }
  }

  private withQuery(url: string, key: string, value: string): string {
    for (const candidate of [url, this.config.frontendUrl]) {
      try {
        const parsed = new URL(candidate);
        parsed.searchParams.set(key, value);
        return parsed.toString();
      } catch {
        // Fall through to the next safe candidate.
      }
    }

    return `/?${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
  }
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function verificationRequiredResponse(): VerificationRequiredResponse {
  return { ok: true, verificationRequired: true };
}

function authenticatedResponse(
  user: SessionUser,
): AuthenticatedSelfServeResponse {
  return { ok: true, authenticated: true, user };
}
