import type { EduAuthConfig } from '../application/edu-auth.ports.js';
import { EduGithubOAuthAdapter } from './edu-github-oauth.adapter.js';

const config: EduAuthConfig = {
  enabled: true,
  frontendUrl: 'http://localhost:3000',
  sessionCookieName: 'edu_session',
  studentEmailDomains: ['school.edu'],
  studentJitProvisioningEnabled: true,
  supabaseUrl: '',
  supabaseAnonKey: '',
  supabasePasswordResetRedirectUrl: '',
  supabaseSignupRedirectUrl: '',
  githubClientId: 'client-id',
  githubClientSecret: 'client-secret',
  githubCallbackUrl: 'http://localhost:4000/api/v1/auth/edu/github/callback',
  githubScope: 'read:user user:email',
};

const response = (payload: unknown, ok = true, status = 200) =>
  ({
    ok,
    status,
    headers: { get: jest.fn().mockReturnValue('repo, read:user') },
    json: jest.fn().mockResolvedValue(payload),
  }) as unknown as Response;

describe('EduGithubOAuthAdapter', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('maps GitHub numeric user IDs for explicit provider identity binding', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      response({
        id: 12345,
        login: 'teacher',
        name: 'Teacher',
        email: 'teacher@school.edu',
        avatar_url: 'https://github.com/avatar.png',
        html_url: 'https://github.com/teacher',
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const adapter = new EduGithubOAuthAdapter(config);

    await expect(adapter.fetchProfile('github-token')).resolves.toMatchObject({
      userId: '12345',
      login: 'teacher',
      email: 'teacher@school.edu',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/user',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer github-token',
        }),
      }),
    );
  });
});
