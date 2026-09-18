import type { Request, Response } from 'express';

import type { EduAuthConfig } from '../application/edu-auth.ports.js';
import { EduAuthService } from '../application/edu-auth.service.js';
import { EduAuthController } from './edu-auth.controller.js';

const config: EduAuthConfig = {
  enabled: true,
  frontendUrl: 'http://localhost:3000',
  sessionCookieName: 'edu_session',
  studentEmailDomains: ['school.edu'],
  studentJitProvisioningEnabled: true,
  supabaseUrl: '',
  supabaseAnonKey: '',
  supabasePasswordResetRedirectUrl: 'http://localhost:3000/reset',
  supabaseSignupRedirectUrl: 'http://localhost:3000/signin',
  githubClientId: '',
  githubClientSecret: '',
  githubCallbackUrl: 'http://localhost:4000/api/v1/auth/edu/github/callback',
  githubScope: 'read:user user:email',
};

const request = { session: {} } as unknown as Request;

const response = () =>
  ({
    redirect: jest.fn(),
    clearCookie: jest.fn(),
  }) as unknown as Response;

const service = () =>
  ({
    login: jest.fn().mockResolvedValue({ ok: true }),
    studentSignup: jest.fn().mockResolvedValue({ created: true }),
    requestPasswordReset: jest.fn().mockResolvedValue({ ok: true }),
    completePasswordReset: jest.fn().mockResolvedValue({ ok: true }),
    me: jest.fn().mockResolvedValue({ authenticated: true }),
    labs: jest.fn().mockResolvedValue({ labs: [], selectedOrgId: null }),
    selectLab: jest
      .fn()
      .mockResolvedValue({ labs: [], selectedOrgId: 'lab-1' }),
    startGithubLink: jest
      .fn()
      .mockResolvedValue('https://github.com/login/oauth/authorize'),
    handleGithubCallback: jest
      .fn()
      .mockResolvedValue('http://localhost:3000/connect-github?auth=success'),
    githubStatus: jest.fn().mockResolvedValue({ state: 'never_connected' }),
    logout: jest.fn().mockResolvedValue(undefined),
  }) as unknown as jest.Mocked<EduAuthService>;

describe('EduAuthController', () => {
  it('keeps the login contract thin and delegates the request unchanged', async () => {
    const authService = service();
    const controller = new EduAuthController(authService, config);
    const body = {
      email: 'teacher@school.edu',
      password: 'password',
      audience: 'STAFF' as const,
    };

    await controller.login(request, body);

    expect(authService.login).toHaveBeenCalledWith(request, body);
  });

  it('preserves the source-compatible student signup and reset contracts', async () => {
    const authService = service();
    const controller = new EduAuthController(authService, config);
    const signup = { email: 'student@school.edu', password: 'password123' };
    const reset = { email: 'student@school.edu' };
    const complete = { accessToken: 'token', password: 'new-password' };

    await controller.studentSignup(signup);
    await controller.requestPasswordReset(reset);
    await controller.completePasswordReset(complete);

    expect(authService.studentSignup).toHaveBeenCalledWith(signup);
    expect(authService.requestPasswordReset).toHaveBeenCalledWith(reset.email);
    expect(authService.completePasswordReset).toHaveBeenCalledWith(
      complete.accessToken,
      complete.password,
    );
  });

  it('redirects staff GitHub linking and delegates lab selection', async () => {
    const authService = service();
    const controller = new EduAuthController(authService, config);
    const res = response();

    await controller.githubStart(request, res, '/connect-github');
    await controller.selectLab(request, { orgId: 'lab-1' });

    expect(authService.startGithubLink).toHaveBeenCalledWith(
      request,
      '/connect-github',
    );
    expect(res.redirect).toHaveBeenCalledWith(
      'https://github.com/login/oauth/authorize',
    );
    expect(authService.selectLab).toHaveBeenCalledWith(request, 'lab-1');
  });

  it('clears the configured EDU session cookie on logout', async () => {
    const authService = service();
    const controller = new EduAuthController(authService, config);
    const res = response();

    await expect(controller.logout(request, res)).resolves.toEqual({
      ok: true,
    });

    expect(authService.logout).toHaveBeenCalledWith(request);
    expect(res.clearCookie).toHaveBeenCalledWith('edu_session');
  });
});
