import { createEduAuthConfig } from './edu-auth.config.js';

describe('createEduAuthConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      ALPHACI_EDITION: 'edu',
      PLATFORM_PUBLIC_URL: 'https://api.example.com/api/v1',
    };
    delete process.env['EDU_GITHUB_CALLBACK_URL'];
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('derives the default GitHub callback from the backend API origin', () => {
    expect(createEduAuthConfig().githubCallbackUrl).toBe(
      'https://api.example.com/api/v1/auth/edu/github/callback',
    );
  });

  it('preserves an explicitly registered callback override', () => {
    process.env['EDU_GITHUB_CALLBACK_URL'] =
      'https://edu-api.example.com/oauth/github/callback';

    expect(createEduAuthConfig().githubCallbackUrl).toBe(
      'https://edu-api.example.com/oauth/github/callback',
    );
  });
});
