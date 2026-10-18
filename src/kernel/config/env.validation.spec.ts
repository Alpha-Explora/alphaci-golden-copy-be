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

    it('accepts an environment with no Supabase configuration at all', () => {
      const result = validateEnv(
        validEnv({
          SUPABASE_URL: undefined,
          SUPABASE_ANON_KEY: undefined,
          SUPABASE_SERVICE_ROLE_KEY: undefined,
        }),
      );

      expect(result.SUPABASE_URL).toBeUndefined();
      expect(result.SUPABASE_ANON_KEY).toBeUndefined();
      expect(result.SUPABASE_SERVICE_ROLE_KEY).toBeUndefined();
    });

    it('accepts a partial SUPABASE_* set when the Supabase storage driver is not selected', () => {
      const result = validateEnv(
        validEnv({
          STORAGE_DRIVER: 'postgres',
          SUPABASE_ANON_KEY: undefined,
          SUPABASE_SERVICE_ROLE_KEY: undefined,
        }),
      );

      expect(result.SUPABASE_URL).toBe('https://abc.supabase.co');
      expect(result.SUPABASE_ANON_KEY).toBeUndefined();
      expect(result.SUPABASE_SERVICE_ROLE_KEY).toBeUndefined();
    });

    it('ignores legacy scoped *_SUPABASE_* variables', () => {
      expect(() =>
        validateEnv(
          validEnv({
            SUPABASE_URL: undefined,
            SUPABASE_ANON_KEY: undefined,
            SUPABASE_SERVICE_ROLE_KEY: undefined,
            PAYMENT_SERVICE_SUPABASE_URL: 'https://payment.supabase.co',
            PAYMENT_SERVICE_SUPABASE_SECRET_KEY: 'payment-secret',
          }),
        ),
      ).not.toThrow();
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

  describe('development Quick login flag', () => {
    it('accepts an explicit boolean value', () => {
      expect(
        validateEnv(validEnv({ DEV_QUICK_LOGIN: 'true' })).DEV_QUICK_LOGIN,
      ).toBe('true');
      expect(
        validateEnv(validEnv({ DEV_QUICK_LOGIN: 'false' })).DEV_QUICK_LOGIN,
      ).toBe('false');
    });

    it('rejects unrecognized values', () => {
      expect(() => validateEnv(validEnv({ DEV_QUICK_LOGIN: 'yes' }))).toThrow(
        /DEV_QUICK_LOGIN/,
      );
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

  describe('composition profile validation', () => {
    it('rejects an invalid build profile during environment validation', () => {
      expect(() =>
        validateEnv(validEnv({ ALPHACI_BUILD_PROFILE: 'saas' })),
      ).toThrow(/ALPHACI_BUILD_PROFILE/);
    });

    it('rejects an edition outside the selected build profile during boot validation', () => {
      expect(() =>
        validateEnv(
          validEnv({
            ALPHACI_BUILD_PROFILE: 'hosted',
            ALPHACI_EDITION: 'enterprise',
          }),
        ),
      ).toThrow(/not allowed by build profile 'hosted'/);
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

  describe('deployment mode and storage driver', () => {
    const selfhostedEnv = (overrides: Record<string, unknown> = {}) =>
      validEnv({
        SUPABASE_URL: undefined,
        SUPABASE_ANON_KEY: undefined,
        SUPABASE_SERVICE_ROLE_KEY: undefined,
        ALPHACI_DEPLOYMENT_MODE: 'selfhosted',
        SESSION_STORE_DRIVER: 'postgres',
        DATABASE_URL: 'postgres://app:pw@db:5432/alphaci',
        PLATFORM_PUBLIC_URL: 'https://alphaci.customer.example',
        ...overrides,
      });

    it('treats an unset ALPHACI_DEPLOYMENT_MODE as saas', () => {
      expect(() => validateEnv(validEnv())).not.toThrow();
    });

    it('rejects an unknown ALPHACI_DEPLOYMENT_MODE', () => {
      expect(() =>
        validateEnv(validEnv({ ALPHACI_DEPLOYMENT_MODE: 'onprem-ish' })),
      ).toThrow(/ALPHACI_DEPLOYMENT_MODE/);
    });

    it('accepts a complete self-hosted environment with no Supabase values', () => {
      expect(() => validateEnv(selfhostedEnv())).not.toThrow();
    });

    it('requires SESSION_STORE_DRIVER=postgres when self-hosted', () => {
      expect(() =>
        validateEnv(selfhostedEnv({ SESSION_STORE_DRIVER: undefined })),
      ).toThrow(/SESSION_STORE_DRIVER=postgres/);
      expect(() =>
        validateEnv(selfhostedEnv({ SESSION_STORE_DRIVER: 'memory' })),
      ).toThrow(/SESSION_STORE_DRIVER=postgres/);
    });

    it('requires a database URL when self-hosted', () => {
      expect(() =>
        validateEnv(selfhostedEnv({ DATABASE_URL: undefined })),
      ).toThrow(/DATABASE_URL/);
    });

    it('accepts the legacy SUPABASE_DB_URL as the database URL when self-hosted', () => {
      expect(() =>
        validateEnv(
          selfhostedEnv({
            DATABASE_URL: undefined,
            SUPABASE_DB_URL: 'postgres://app:pw@db:5432/alphaci',
          }),
        ),
      ).not.toThrow();
    });

    it('requires a public URL when self-hosted', () => {
      expect(() =>
        validateEnv(selfhostedEnv({ PLATFORM_PUBLIC_URL: undefined })),
      ).toThrow(/PLATFORM_PUBLIC_URL/);
    });

    it('defaults the storage driver to postgres when self-hosted, even with SUPABASE_* present', () => {
      expect(() =>
        validateEnv(
          selfhostedEnv({
            SUPABASE_URL: 'https://abc.supabase.co',
            SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
          }),
        ),
      ).not.toThrow();
    });

    it('rejects STORAGE_DRIVER=supabase when self-hosted', () => {
      expect(() =>
        validateEnv(selfhostedEnv({ STORAGE_DRIVER: 'supabase' })),
      ).toThrow(/not available when ALPHACI_DEPLOYMENT_MODE=selfhosted/);
    });

    it('rejects an unknown STORAGE_DRIVER', () => {
      expect(() => validateEnv(validEnv({ STORAGE_DRIVER: 's3' }))).toThrow(
        /STORAGE_DRIVER/,
      );
    });

    it('requires the Supabase URL and service-role key when STORAGE_DRIVER=supabase', () => {
      expect(() =>
        validateEnv(
          validEnv({
            STORAGE_DRIVER: 'supabase',
            SUPABASE_URL: undefined,
          }),
        ),
      ).toThrow(/STORAGE_DRIVER=supabase requires SUPABASE_URL/);
      expect(() =>
        validateEnv(
          validEnv({
            STORAGE_DRIVER: 'supabase',
            SUPABASE_SERVICE_ROLE_KEY: '',
          }),
        ),
      ).toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
    });

    it('accepts STORAGE_DRIVER=supabase with its URL and key', () => {
      expect(() =>
        validateEnv(validEnv({ STORAGE_DRIVER: 'supabase' })),
      ).not.toThrow();
    });

    it('accepts STORAGE_DRIVER=postgres in saas mode without Supabase values', () => {
      expect(() =>
        validateEnv(
          validEnv({
            STORAGE_DRIVER: 'postgres',
            SUPABASE_URL: undefined,
            SUPABASE_SERVICE_ROLE_KEY: undefined,
          }),
        ),
      ).not.toThrow();
    });
  });
});
