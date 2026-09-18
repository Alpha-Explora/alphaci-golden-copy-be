import { randomUUID } from 'node:crypto';

import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';

import type { SessionUser } from '#kernel/auth/session-user.interface.js';
import {
  EDU_AUTH_CONFIG,
  EDU_AUTH_REPOSITORY,
  EDU_GITHUB_OAUTH_PORT,
  EduGithubLinkConflictError,
  SUPABASE_AUTH_PORT,
  type EduAuthConfig,
  type EduAuthRepositoryPort,
  type EduGithubOAuthPort,
  type SupabaseAuthPort,
} from './edu-auth.ports.js';
import {
  accessibleLabSelectionIsValid,
  avatarColorForEduEmail,
  displayNameFromEduEmail,
  expectedAudienceFor,
  isAccountActive,
  isAllowedStudentEmail,
  isEduStaffRole,
  normalizeEduEmail,
} from './edu-auth.policy.js';
import type {
  EduAccount,
  EduLab,
  EduLabsResponse,
  EduRole,
  EduSessionUser,
  EduSignInAudience,
  GithubConnectionStatus,
} from '../model/edu-auth.types.js';
import type { EduLoginDto } from '../api/dto/edu-login.dto.js';
import type { EduStudentSignupDto } from '../api/dto/edu-student-signup.dto.js';

export interface EduAuthenticatedResponse {
  ok: true;
  authenticated: true;
  user: EduSessionUser;
  labs: EduLab[];
  selectedOrgId: string | null;
  github: {
    linked: boolean;
    login: string | null;
  };
}

export interface EduMeResponse {
  authenticated: true;
  user: EduSessionUser;
  labs: EduLabsResponse['labs'];
  selectedOrgId: string | null;
  github: {
    linked: boolean;
    login: string | null;
  };
}

@Injectable()
export class EduAuthService {
  private readonly logger = new Logger(EduAuthService.name);

  constructor(
    @Inject(EDU_AUTH_CONFIG) private readonly config: EduAuthConfig,
    @Inject(EDU_AUTH_REPOSITORY)
    private readonly repository: EduAuthRepositoryPort,
    @Inject(SUPABASE_AUTH_PORT)
    private readonly supabaseAuth: SupabaseAuthPort,
    @Inject(EDU_GITHUB_OAUTH_PORT)
    private readonly githubOAuth: EduGithubOAuthPort,
  ) {}

  async login(
    request: Request,
    input: EduLoginDto,
  ): Promise<EduAuthenticatedResponse> {
    const email = normalizeEduEmail(input.email);
    const result = await this.supabaseAuth.verifyPassword(
      email,
      input.password,
    );
    const account = await this.resolveAuthenticatedAccount(result, email);

    this.assertAudience(account.role, input.audience);
    this.assertActive(account);

    const labs = await this.repository.listAccessibleLabs(
      account.userId,
      account.role,
    );
    await this.establishSession(request, account);
    if (isEduStaffRole(account.role) && labs.length > 0) {
      const firstLab = labs[0];
      if (firstLab) request.session.eduSelectedLabId = firstLab.id;
    }
    await this.saveSession(request);

    return {
      ok: true,
      authenticated: true,
      user: this.toSessionUser(account, request.session.eduSelectedLabId),
      labs,
      selectedOrgId: request.session.eduSelectedLabId ?? null,
      github: {
        linked: Boolean(account.githubLogin),
        login: account.githubLogin,
      },
    };
  }

  async studentSignup(input: EduStudentSignupDto): Promise<{
    created: boolean;
    needsEmailConfirmation: boolean;
    message: string;
  }> {
    const email = normalizeEduEmail(input.email);
    if (!this.config.studentJitProvisioningEnabled) {
      throw new ForbiddenException(
        'New student accounts are not being created right now. Please contact your teacher.',
      );
    }
    this.assertAllowedStudentEmail(email);

    const existing = await this.repository.findByEmail(email);
    if (existing) {
      throw new ConflictException(
        'An EDU account already exists for this email. Please sign in instead.',
      );
    }

    const result = await this.supabaseAuth.signUp(email, input.password);
    switch (result.outcome) {
      case 'created':
        return {
          created: true,
          needsEmailConfirmation: result.needsEmailConfirmation,
          message: result.needsEmailConfirmation
            ? 'Check your school email to confirm your account, then sign in.'
            : 'Your account is ready. You can sign in now.',
        };
      case 'already-registered':
        throw new ConflictException(
          'An account already exists for this email. Please sign in instead.',
        );
      case 'rate-limited':
        throw new HttpException(
          'Too many signup attempts. Please wait a moment and try again.',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      case 'unconfigured':
        throw new ServiceUnavailableException(
          'Student signup is not configured on this server.',
        );
      case 'failed':
        throw new ServiceUnavailableException(
          'We could not create your account right now. Please try again later.',
        );
    }
  }

  async requestPasswordReset(emailInput: string): Promise<{ ok: true }> {
    await this.supabaseAuth.sendPasswordReset(normalizeEduEmail(emailInput));
    return { ok: true };
  }

  async completePasswordReset(
    accessToken: string,
    password: string,
  ): Promise<{ ok: boolean; message: string }> {
    if (!accessToken.trim()) {
      return {
        ok: false,
        message:
          'This link is missing its sign-in token. Open the link directly from your email.',
      };
    }

    const failure = await this.supabaseAuth.setPasswordWithToken(
      accessToken,
      password,
    );
    if (failure) return { ok: false, message: failure };
    return { ok: true, message: 'Your password is set. You can sign in now.' };
  }

  async me(request: Request): Promise<EduMeResponse> {
    const account = await this.requireSessionAccount(request);
    const labs = await this.labsForAccount(request, account);
    return {
      authenticated: true,
      user: this.toSessionUser(account, labs.selectedOrgId ?? undefined),
      labs: labs.labs,
      selectedOrgId: labs.selectedOrgId,
      github: {
        linked: Boolean(account.githubLogin),
        login: account.githubLogin,
      },
    };
  }

  async labs(request: Request): Promise<EduLabsResponse> {
    const account = await this.requireSessionAccount(request);
    return this.labsForAccount(request, account);
  }

  async selectLab(request: Request, orgId: string): Promise<EduLabsResponse> {
    const account = await this.requireSessionAccount(request);
    const labs = await this.repository.listAccessibleLabs(
      account.userId,
      account.role,
    );
    if (!labs.some((lab) => lab.id === orgId)) {
      throw new ForbiddenException('You do not have access to that lab.');
    }

    request.session.eduSelectedLabId = orgId;
    await this.saveSession(request);
    return { labs, selectedOrgId: orgId };
  }

  async startGithubLink(request: Request, returnTo?: string): Promise<string> {
    const account = await this.requireSessionAccount(request);
    this.assertStaff(account);
    const safeReturnTo = this.normalizeReturnTo(returnTo);

    if (!this.githubOAuth.isConfigured()) {
      return this.withQuery(safeReturnTo, 'auth', 'unavailable');
    }

    const state = randomUUID();
    request.session.eduGithubOAuthState = state;
    request.session.eduGithubOAuthReturnTo = safeReturnTo;
    request.session.eduGithubOAuthUserId = account.userId;
    await this.saveSession(request);
    return this.githubOAuth.authorizationUrl(state);
  }

  async handleGithubCallback(
    request: Request,
    code?: string,
    state?: string,
  ): Promise<string> {
    const returnTo =
      request.session.eduGithubOAuthReturnTo ??
      this.normalizeReturnTo('/connect-github');
    const expectedState = request.session.eduGithubOAuthState;
    const userId = request.session.eduGithubOAuthUserId;

    delete request.session.eduGithubOAuthState;
    delete request.session.eduGithubOAuthReturnTo;
    delete request.session.eduGithubOAuthUserId;

    if (
      !code ||
      !state ||
      !expectedState ||
      state !== expectedState ||
      !userId
    ) {
      await this.saveSession(request);
      return this.withQuery(returnTo, 'auth', 'invalid_state');
    }
    if (!this.githubOAuth.isConfigured()) {
      await this.saveSession(request);
      return this.withQuery(returnTo, 'auth', 'unavailable');
    }

    try {
      const account = await this.repository.findByUserId(userId);
      if (!account) {
        await this.saveSession(request);
        return this.withQuery(returnTo, 'auth', 'not_authorized');
      }
      this.assertStaff(account);
      this.assertActive(account);

      const accessToken = await this.githubOAuth.exchangeCode(code);
      const profile = await this.githubOAuth.fetchProfile(accessToken);
      const linked = await this.repository.linkGithub({
        userId,
        githubUserId: profile.userId,
        githubLogin: profile.login,
        githubAvatarUrl: profile.avatarUrl,
        githubProfileUrl: profile.profileUrl,
      });

      request.session.eduUserId = linked.userId;
      request.session.eduRole = linked.role;
      request.session.userId = linked.userId;
      await this.saveSession(request);
      return this.withQuery(returnTo, 'auth', 'success');
    } catch (error) {
      // Persist the one-time state removal even when the provider or link
      // fails, so the callback cannot be replayed with the same state.
      await this.saveSession(request).catch(() => undefined);
      if (error instanceof EduGithubLinkConflictError) {
        return this.withQuery(returnTo, 'auth', 'github_conflict');
      }
      this.logger.error(
        `EDU GitHub callback failed: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
      return this.withQuery(returnTo, 'auth', 'failed');
    }
  }

  async githubStatus(request: Request): Promise<GithubConnectionStatus> {
    const account = await this.requireSessionAccount(request);
    const base = {
      linked: Boolean(account.githubLogin),
      login: account.githubLogin,
      connected: false,
      scopes: [] as string[],
      canCreateRepos: false,
      checkedAt: new Date().toISOString(),
    };

    if (!isEduStaffRole(account.role)) {
      return { ...base, state: 'not_applicable' };
    }
    if (!this.githubOAuth.isConfigured()) {
      return { ...base, state: 'unconfigured' };
    }

    // Phase one deliberately stores only the durable GitHub identity link. It
    // does not retain an OAuth access token in the session, so future lab
    // operations must introduce an explicit server-side token/vault contract
    // and scope review before they can claim live GitHub connectivity.
    return account.githubLogin
      ? { ...base, linked: true, connected: true, state: 'connected' }
      : { ...base, state: 'never_connected' };
  }

  async logout(request: Request): Promise<void> {
    if (!request.session) return;
    await new Promise<void>((resolve, reject) => {
      request.session.destroy((error) => {
        if (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        resolve();
      });
    });
  }

  private async resolveAuthenticatedAccount(
    result: Awaited<ReturnType<SupabaseAuthPort['verifyPassword']>>,
    email: string,
  ): Promise<EduAccount> {
    if (!result.ok) {
      switch (result.reason) {
        case 'rate_limited':
          throw new HttpException(
            'Too many sign-in attempts. Please wait a moment and try again.',
            HttpStatus.TOO_MANY_REQUESTS,
          );
        case 'email_not_confirmed':
          throw new ForbiddenException(
            'Please confirm your email address first — check your inbox for the link we sent.',
          );
        case 'unconfigured':
        case 'error':
          throw new ServiceUnavailableException(
            'Password sign-in is not configured on this server.',
          );
        case 'invalid_credentials':
          throw new UnauthorizedException('Incorrect email or password.');
      }
    }

    const existing = await this.repository.findBySupabaseUserId(
      result.user.authUserId,
    );
    if (existing) {
      await this.repository.recordSupabaseLogin(
        result.user.authUserId,
        result.user.email,
      );
      return existing;
    }

    const addressTaken = await this.repository.findByEmail(email);
    if (addressTaken) {
      throw new ForbiddenException(
        'Your sign-in worked, but this account is not linked to an AlphaCI Educ profile yet. ' +
          'Ask your IT admin to send you an invitation.',
      );
    }

    if (!this.config.studentJitProvisioningEnabled) {
      throw new ForbiddenException(
        'Your sign-in worked, but this account is not linked to an AlphaCI Educ profile yet. ' +
          'Ask your IT admin to send you an invitation.',
      );
    }
    this.assertAllowedStudentEmail(email);

    const homeLab = await this.repository.findFirstActiveLab();
    if (!homeLab) {
      throw new ForbiddenException(
        'This system has no laboratories set up yet. Please contact your IT admin.',
      );
    }

    return this.repository.createStudent({
      email,
      authUserId: result.user.authUserId,
      fullName: displayNameFromEduEmail(email),
      homeLabId: homeLab.id,
    });
  }

  private async requireSessionAccount(request: Request): Promise<EduAccount> {
    const userId = request.session.eduUserId;
    if (!userId) throw new UnauthorizedException('Authentication required');
    const account = await this.repository.findByUserId(userId);
    if (!account || !isAccountActive(account)) {
      throw new UnauthorizedException('Authentication required');
    }
    return account;
  }

  private async labsForAccount(
    request: Request,
    account: EduAccount,
  ): Promise<EduLabsResponse> {
    const labs = await this.repository.listAccessibleLabs(
      account.userId,
      account.role,
    );
    let selectedOrgId = request.session.eduSelectedLabId ?? null;
    if (!accessibleLabSelectionIsValid(labs, selectedOrgId ?? undefined)) {
      delete request.session.eduSelectedLabId;
      selectedOrgId = null;
      await this.saveSession(request);
    }
    return { labs, selectedOrgId };
  }

  private assertAudience(
    role: EduRole,
    audience: EduSignInAudience | undefined,
  ): void {
    if (!audience || expectedAudienceFor(role) === audience) return;
    throw new ForbiddenException({
      statusCode: HttpStatus.FORBIDDEN,
      code: 'WRONG_SIGN_IN_DOOR',
      message:
        audience === 'STUDENT'
          ? 'That account is a teacher or IT staff account. Please use the staff sign-in page.'
          : 'That account is a student account. Please use the student sign-in page.',
    });
  }

  private assertActive(account: EduAccount): void {
    if (!isAccountActive(account)) {
      throw new ForbiddenException(
        'This account is no longer active. Please contact your school IT staff.',
      );
    }
  }

  private assertStaff(account: EduAccount): void {
    if (!isEduStaffRole(account.role)) {
      throw new ForbiddenException('Students cannot connect a GitHub account.');
    }
  }

  private assertAllowedStudentEmail(email: string): void {
    if (isAllowedStudentEmail(email, this.config.studentEmailDomains)) return;
    const allowed = this.config.studentEmailDomains
      .map((domain) => `@${domain}`)
      .join(', ');
    throw new ForbiddenException(
      allowed
        ? `Use your school email address (${allowed}) to sign in.`
        : 'Student sign-in is not configured on this server.',
    );
  }

  private async establishSession(
    request: Request,
    account: EduAccount,
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      request.session.regenerate((error) => {
        if (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        request.session.userId = account.userId;
        request.session.user = this.toSharedSessionUser(account);
        request.session.eduUserId = account.userId;
        request.session.eduRole = account.role;
        resolve();
      });
    });
  }

  private toSharedSessionUser(account: EduAccount): SessionUser {
    return {
      id: account.userId,
      login: account.email.split('@')[0] ?? account.email,
      name: account.fullName,
      ...(account.githubAvatarUrl
        ? { avatarUrl: account.githubAvatarUrl }
        : {}),
      email: account.email,
      onboardingCompleted: true,
      isInternal: false,
    };
  }

  private toSessionUser(
    account: EduAccount,
    selectedLabId?: string,
  ): EduSessionUser {
    return {
      id: account.userId,
      fullName: account.fullName,
      email: account.email,
      role: account.role,
      orgId: selectedLabId ?? account.homeLabId,
      personalGithubUsername: null,
      status: account.status,
      avatarColor: avatarColorForEduEmail(account.email),
      createdAt: account.createdAt,
      githubUsername: account.githubLogin,
      consumesGithubSeat: isEduStaffRole(account.role),
      githubLogin: account.githubLogin,
      githubAvatarUrl: account.githubAvatarUrl,
      githubProfileUrl: account.githubProfileUrl,
      authUserId: account.supabaseUserId,
    };
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
    const fallback = new URL(
      '/connect-github',
      this.config.frontendUrl,
    ).toString();
    if (!returnTo) return fallback;
    if (returnTo.startsWith('/') && !returnTo.startsWith('//')) {
      return new URL(returnTo, this.config.frontendUrl).toString();
    }
    try {
      const candidate = new URL(returnTo);
      const origin = new URL(this.config.frontendUrl).origin;
      return candidate.origin === origin ? candidate.toString() : fallback;
    } catch {
      return fallback;
    }
  }

  private withQuery(url: string, key: string, value: string): string {
    const result = new URL(url);
    result.searchParams.set(key, value);
    return result.toString();
  }
}
