import { ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';

import type {
  EduAuthConfig,
  EduAuthRepositoryPort,
  EduGithubOAuthPort,
  SupabaseAuthPort,
} from './edu-auth.ports.js';
import { EduAuthService } from './edu-auth.service.js';
import type { EduAccount, EduLab } from '../model/edu-auth.types.js';

const config: EduAuthConfig = {
  enabled: true,
  frontendUrl: 'http://localhost:3000',
  sessionCookieName: 'edu_session',
  studentEmailDomains: ['school.edu'],
  studentJitProvisioningEnabled: true,
  supabaseUrl: 'https://example.supabase.co',
  supabaseAnonKey: 'anon-key',
  supabasePasswordResetRedirectUrl: 'http://localhost:3000/auth/reset-password',
  supabaseSignupRedirectUrl: 'http://localhost:3000/signin',
  githubClientId: 'github-client',
  githubClientSecret: 'github-secret',
  githubCallbackUrl: 'http://localhost:4000/api/v1/auth/edu/github/callback',
  githubScope: 'read:user user:email',
};

const lab: EduLab = {
  id: '00000000-0000-0000-0000-000000000001',
  name: 'Main Lab',
  githubOrgName: 'main-lab',
};

const account = (overrides: Partial<EduAccount> = {}): EduAccount => ({
  userId: 'user-1',
  email: 'teacher@school.edu',
  fullName: 'Teacher User',
  role: 'TEACHER',
  status: 'ACTIVE',
  homeLabId: lab.id,
  githubUserId: null,
  githubLogin: null,
  githubAvatarUrl: null,
  githubProfileUrl: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  supabaseUserId: 'supabase-user-1',
  ...overrides,
});

const makeRequest = (data: Record<string, unknown> = {}) => {
  const session = {
    ...data,
    regenerate: jest
      .fn()
      .mockImplementation((callback: (error?: Error | null) => void) =>
        callback(),
      ),
    save: jest
      .fn()
      .mockImplementation((callback: (error?: Error | null) => void) =>
        callback(),
      ),
    destroy: jest
      .fn()
      .mockImplementation((callback: (error?: Error | null) => void) =>
        callback(),
      ),
  };
  return { session } as unknown as Request;
};

const makeService = () => {
  const repository = {
    findBySupabaseUserId: jest.fn().mockResolvedValue(account()),
    findByUserId: jest.fn().mockResolvedValue(account()),
    findByEmail: jest.fn().mockResolvedValue(null),
    findFirstActiveLab: jest.fn().mockResolvedValue(lab),
    createStudent: jest.fn().mockResolvedValue(
      account({
        userId: 'student-1',
        email: 'ada.lovelace@school.edu',
        fullName: 'Ada Lovelace',
        role: 'STUDENT',
        supabaseUserId: 'supabase-student-1',
      }),
    ),
    recordSupabaseLogin: jest.fn().mockResolvedValue(undefined),
    listAccessibleLabs: jest.fn().mockResolvedValue([lab]),
    linkGithub: jest.fn().mockResolvedValue(account()),
  } as unknown as jest.Mocked<EduAuthRepositoryPort>;
  const supabaseAuth = {
    verifyPassword: jest.fn().mockResolvedValue({
      ok: true,
      user: {
        authUserId: 'supabase-user-1',
        email: 'teacher@school.edu',
        accessToken: 'access-token',
      },
    }),
    signUp: jest.fn().mockResolvedValue({
      outcome: 'created',
      authUserId: null,
      needsEmailConfirmation: true,
    }),
    sendPasswordReset: jest.fn().mockResolvedValue(undefined),
    setPasswordWithToken: jest.fn().mockResolvedValue(null),
  } as unknown as jest.Mocked<SupabaseAuthPort>;
  const githubOAuth = {
    isConfigured: jest.fn().mockReturnValue(true),
    authorizationUrl: jest.fn().mockReturnValue('https://github.com/oauth'),
    exchangeCode: jest.fn(),
    fetchProfile: jest.fn(),
    checkToken: jest.fn(),
  } as unknown as jest.Mocked<EduGithubOAuthPort>;

  return {
    service: new EduAuthService(config, repository, supabaseAuth, githubOAuth),
    repository,
    supabaseAuth,
    githubOAuth,
  };
};

describe('EduAuthService', () => {
  it('establishes the shared and EDU session fields for staff login', async () => {
    const { service } = makeService();
    const request = makeRequest();

    const result = await service.login(request, {
      email: 'teacher@school.edu',
      password: 'password',
      audience: 'STAFF',
    });

    expect(result).toMatchObject({
      ok: true,
      authenticated: true,
      user: {
        id: 'user-1',
        role: 'TEACHER',
        orgId: lab.id,
      },
    });
    expect(request.session.userId).toBe('user-1');
    expect(request.session.eduUserId).toBe('user-1');
    expect(request.session.eduRole).toBe('TEACHER');
    expect(request.session.eduSelectedLabId).toBe(lab.id);
  });

  it('returns a wrong-door error when a staff account uses the student door', async () => {
    const { service } = makeService();

    await expect(
      service.login(makeRequest(), {
        email: 'teacher@school.edu',
        password: 'password',
        audience: 'STUDENT',
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'WRONG_SIGN_IN_DOOR' }),
    });
  });

  it('JIT-provisions an allowed student only after exact subject lookup misses', async () => {
    const { service, repository } = makeService();
    repository.findBySupabaseUserId.mockResolvedValueOnce(null);

    const result = await service.login(makeRequest(), {
      email: 'ada.lovelace@school.edu',
      password: 'password',
      audience: 'STUDENT',
    });

    expect(repository.createStudent).toHaveBeenCalledWith({
      email: 'ada.lovelace@school.edu',
      authUserId: 'supabase-user-1',
      fullName: 'Ada Lovelace',
      homeLabId: lab.id,
    });
    expect(result.user.role).toBe('STUDENT');
  });

  it('rejects student signup outside the configured school domain', async () => {
    const { service, supabaseAuth } = makeService();

    await expect(
      service.studentSignup({
        email: 'student@example.com',
        password: 'password123',
      }),
    ).rejects.toThrow(ForbiddenException);
    expect(supabaseAuth.signUp).not.toHaveBeenCalled();
  });

  it('delegates password reset without disclosing account existence', async () => {
    const { service, supabaseAuth } = makeService();

    await expect(
      service.requestPasswordReset(' Teacher@School.edu '),
    ).resolves.toEqual({ ok: true });
    expect(supabaseAuth.sendPasswordReset).toHaveBeenCalledWith(
      'teacher@school.edu',
    );
  });

  it('rejects lab selection outside the account accessible-lab set', async () => {
    const { service } = makeService();

    await expect(
      service.selectLab(makeRequest({ eduUserId: 'user-1' }), 'other-lab'),
    ).rejects.toThrow(ForbiddenException);
  });
});
