import { validateEnv } from '#kernel/config/env.validation';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validEnv(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    NODE_ENV: 'development',
    PORT: '3000',
    SESSION_SECRET: 'a'.repeat(32),
    SUPABASE_URL: 'https://abc.supabase.co',
    SUPABASE_ANON_KEY: 'anon-key',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
    ALLOWED_ORIGINS: 'http://localhost:5173',
    FRONTEND_URL: 'http://localhost:3000',
    GITHUB_CLIENT_ID: 'github-client-id',
    GITHUB_CLIENT_SECRET: 'github-client-secret',
    GITHUB_APP_ID: '4114943',
    GITHUB_APP_SLUG: 'alphaci-test',
    GITHUB_APP_PRIVATE_KEY:
      '-----BEGIN PRIVATE KEY-----\\ntest\\n-----END PRIVATE KEY-----',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('validateEnv', () => {
  describe('happy path', () => {
    it('returns a fully typed config object for a valid env', () => {
      const result = validateEnv(validEnv());

      expect(result.NODE_ENV).toBe('development');
      expect(result.PORT).toBe(3000);
      expect(result.SUPABASE_URL).toBe('https://abc.supabase.co');
      expect(result.SUPABASE_ANON_KEY).toBe('anon-key');
      expect(result.SUPABASE_SERVICE_ROLE_KEY).toBe('service-role-key');
      expect(result.ALLOWED_ORIGINS).toBe('http://localhost:5173');
    });

    it('accepts production as NODE_ENV', () => {
      const result = validateEnv(validEnv({ NODE_ENV: 'production' }));
      expect(result.NODE_ENV).toBe('production');
    });

    it('accepts test as NODE_ENV', () => {
      const result = validateEnv(validEnv({ NODE_ENV: 'test' }));
      expect(result.NODE_ENV).toBe('test');
    });

    it('accepts scoped Supabase-only config without default SUPABASE_* trio', () => {
      const result = validateEnv(
        validEnv({
          SUPABASE_URL: undefined,
          SUPABASE_ANON_KEY: undefined,
          SUPABASE_SERVICE_ROLE_KEY: undefined,
          PAYMENT_SERVICE_SUPABASE_URL: 'https://payment.supabase.co',
          PAYMENT_SERVICE_SUPABASE_SECRET_KEY: 'payment-secret',
        }),
      );

      expect(result.SUPABASE_URL).toBeUndefined();
      expect(result.SUPABASE_ANON_KEY).toBeUndefined();
      expect(result.SUPABASE_SERVICE_ROLE_KEY).toBeUndefined();
    });

    it('accepts incomplete default SUPABASE_* when scoped clients are configured', () => {
      const result = validateEnv(
        validEnv({
          SUPABASE_ANON_KEY: undefined,
          PAYMENT_SERVICE_SUPABASE_URL: 'https://payment.supabase.co',
          PAYMENT_SERVICE_SUPABASE_SECRET_KEY: 'payment-secret',
        }),
      );

      expect(result.SUPABASE_URL).toBe('https://abc.supabase.co');
      expect(result.SUPABASE_ANON_KEY).toBeUndefined();
      expect(result.SUPABASE_SERVICE_ROLE_KEY).toBe('service-role-key');
    });

    it('defaults ENABLE_SWAGGER to "false" when not set', () => {
      const result = validateEnv(validEnv());
      expect(result.ENABLE_SWAGGER).toBe('false');
    });

    it('uses the provided ENABLE_SWAGGER value when set', () => {
      const result = validateEnv(validEnv({ ENABLE_SWAGGER: 'true' }));
      expect(result.ENABLE_SWAGGER).toBe('true');
    });

    it('trims leading/trailing whitespace from string values', () => {
      const result = validateEnv(
        validEnv({ SUPABASE_URL: '  https://abc.supabase.co  ' }),
      );
      expect(result.SUPABASE_URL).toBe('https://abc.supabase.co');
    });
  });

  describe('NODE_ENV validation', () => {
    it('throws for an invalid NODE_ENV value', () => {
      expect(() => validateEnv(validEnv({ NODE_ENV: 'staging' }))).toThrow(
        /NODE_ENV/,
      );
    });

    it('throws when NODE_ENV is missing', () => {
      const env = validEnv();
      delete env['NODE_ENV'];
      expect(() => validateEnv(env)).toThrow(/NODE_ENV/);
    });

    it('throws when NODE_ENV is an empty string', () => {
      expect(() => validateEnv(validEnv({ NODE_ENV: '' }))).toThrow(/NODE_ENV/);
    });
  });

  describe('PORT validation', () => {
    it('defaults PORT to 4000 when missing', () => {
      const env = validEnv();
      delete env['PORT'];
      expect(validateEnv(env).PORT).toBe(4000);
    });

    it('throws when PORT is zero', () => {
      expect(() => validateEnv(validEnv({ PORT: '0' }))).toThrow(/PORT/);
    });

    it('throws when PORT is above 65535', () => {
      expect(() => validateEnv(validEnv({ PORT: '65536' }))).toThrow(/PORT/);
    });

    it('throws when PORT is not a number', () => {
      expect(() => validateEnv(validEnv({ PORT: 'abc' }))).toThrow(/PORT/);
    });

    it('accepts PORT at boundary value 1', () => {
      const result = validateEnv(validEnv({ PORT: '1' }));
      expect(result.PORT).toBe(1);
    });

    it('accepts PORT at boundary value 65535', () => {
      const result = validateEnv(validEnv({ PORT: '65535' }));
      expect(result.PORT).toBe(65535);
    });
  });

  describe('required string fields', () => {
    const requiredFields = [
      'SUPABASE_URL',
      'SUPABASE_ANON_KEY',
      'SUPABASE_SERVICE_ROLE_KEY',
      'ALLOWED_ORIGINS',
      'FRONTEND_URL',
      'GITHUB_CLIENT_ID',
      'GITHUB_CLIENT_SECRET',
    ];

    for (const field of requiredFields) {
      it(`throws when ${field} is missing`, () => {
        const env = validEnv();
        delete env[field];
        expect(() => validateEnv(env)).toThrow(new RegExp(field));
      });

      it(`throws when ${field} is an empty string`, () => {
        expect(() => validateEnv(validEnv({ [field]: '' }))).toThrow(
          new RegExp(field),
        );
      });

      it(`throws when ${field} is whitespace only`, () => {
        expect(() => validateEnv(validEnv({ [field]: '   ' }))).toThrow(
          new RegExp(field),
        );
      });
    }
  });

  describe('production GitHub App configuration', () => {
    for (const field of [
      'GITHUB_APP_ID',
      'GITHUB_APP_SLUG',
      'GITHUB_APP_PRIVATE_KEY',
    ]) {
      it(`throws when ${field} is missing in production`, () => {
        const env = validEnv({ NODE_ENV: 'production' });
        delete env[field];
        expect(() => validateEnv(env)).toThrow(new RegExp(field));
      });
    }

    it('accepts the GITHUB_APP alias for GITHUB_APP_ID in production', () => {
      const env = validEnv({ NODE_ENV: 'production', GITHUB_APP: '4114943' });
      delete env['GITHUB_APP_ID'];
      expect(() => validateEnv(env)).not.toThrow();
    });

    it('accepts the GITHUB_PRIVATE_KEY alias for GITHUB_APP_PRIVATE_KEY in production', () => {
      const env = validEnv({
        NODE_ENV: 'production',
        GITHUB_PRIVATE_KEY:
          '-----BEGIN PRIVATE KEY-----\\ntest\\n-----END PRIVATE KEY-----',
      });
      delete env['GITHUB_APP_PRIVATE_KEY'];
      expect(() => validateEnv(env)).not.toThrow();
    });

    it('names both accepted variables when the App ID is missing in production', () => {
      const env = validEnv({ NODE_ENV: 'production' });
      delete env['GITHUB_APP_ID'];
      delete env['GITHUB_APP'];
      expect(() => validateEnv(env)).toThrow(/GITHUB_APP_ID.*GITHUB_APP/);
    });

    it('rejects the placeholder GitHub App slug in production', () => {
      expect(() =>
        validateEnv(
          validEnv({
            NODE_ENV: 'production',
            GITHUB_APP_SLUG: 'my-github-app',
          }),
        ),
      ).toThrow(/real GitHub App slug/);
    });

    it('allows local development to use the placeholder GitHub App slug', () => {
      expect(() =>
        validateEnv(
          validEnv({
            GITHUB_APP_SLUG: 'my-github-app',
          }),
        ),
      ).not.toThrow();
    });
  });
});
