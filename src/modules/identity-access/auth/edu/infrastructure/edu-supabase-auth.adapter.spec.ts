import type { EduAuthConfig } from '../application/edu-auth.ports.js';
import { EduSupabaseAuthAdapter } from './edu-supabase-auth.adapter.js';

const config: EduAuthConfig = {
  enabled: true,
  frontendUrl: 'http://localhost:3000',
  sessionCookieName: 'edu_session',
  studentEmailDomains: ['school.edu'],
  studentJitProvisioningEnabled: true,
  supabaseUrl: 'https://project.supabase.co/',
  supabaseAnonKey: 'anon-key',
  supabasePasswordResetRedirectUrl: 'http://localhost:3000/reset',
  supabaseSignupRedirectUrl: 'http://localhost:3000/signin',
  githubClientId: '',
  githubClientSecret: '',
  githubCallbackUrl: '',
  githubScope: '',
};

const response = (payload: unknown, ok = true, status = 200) =>
  ({
    ok,
    status,
    json: jest.fn().mockResolvedValue(payload),
  }) as unknown as Response;

describe('EduSupabaseAuthAdapter', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('uses the server-side password grant and maps a Supabase subject', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      response({
        access_token: 'access-token',
        user: { id: 'supabase-user-1', email: 'student@school.edu' },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const adapter = new EduSupabaseAuthAdapter(config);

    await expect(
      adapter.verifyPassword('student@school.edu', 'password'),
    ).resolves.toEqual({
      ok: true,
      user: {
        authUserId: 'supabase-user-1',
        email: 'student@school.edu',
        accessToken: 'access-token',
      },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://project.supabase.co/auth/v1/token?grant_type=password',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ apikey: 'anon-key' }),
      }),
    );
  });

  it('maps Supabase rate limiting without exposing provider details', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(response({ message: 'slow down' }, false, 429));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const adapter = new EduSupabaseAuthAdapter(config);

    await expect(
      adapter.verifyPassword('student@school.edu', 'password'),
    ).resolves.toEqual({ ok: false, reason: 'rate_limited' });
  });
});
