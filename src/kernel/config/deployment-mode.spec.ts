import {
  parseDeploymentMode,
  resolveStorageDriver,
} from '#kernel/config/deployment-mode';

describe('parseDeploymentMode', () => {
  it('defaults to saas when unset or blank', () => {
    expect(parseDeploymentMode({})).toBe('saas');
    expect(parseDeploymentMode({ ALPHACI_DEPLOYMENT_MODE: '   ' })).toBe(
      'saas',
    );
  });

  it('accepts selfhosted case-insensitively, trimmed', () => {
    expect(
      parseDeploymentMode({ ALPHACI_DEPLOYMENT_MODE: '  SelfHosted ' }),
    ).toBe('selfhosted');
  });

  it('throws on an unknown value rather than falling back to saas', () => {
    expect(() =>
      parseDeploymentMode({ ALPHACI_DEPLOYMENT_MODE: 'self-hosted' }),
    ).toThrow(/Invalid ALPHACI_DEPLOYMENT_MODE/);
  });
});

describe('resolveStorageDriver', () => {
  it('keeps SaaS on supabase when SUPABASE_URL is present', () => {
    expect(
      resolveStorageDriver({ SUPABASE_URL: 'https://abc.supabase.co' }, 'saas'),
    ).toBe('supabase');
  });

  it('keeps SaaS on supabase when only the service-role key is present', () => {
    expect(
      resolveStorageDriver({ SUPABASE_SERVICE_ROLE_KEY: 'k' }, 'saas'),
    ).toBe('supabase');
  });

  it('defaults to postgres when no Supabase value is present', () => {
    expect(resolveStorageDriver({}, 'saas')).toBe('postgres');
  });

  it('does not treat blank Supabase values as present', () => {
    expect(
      resolveStorageDriver(
        { SUPABASE_URL: '  ', SUPABASE_SERVICE_ROLE_KEY: '' },
        'saas',
      ),
    ).toBe('postgres');
  });

  it('defaults to postgres when self-hosted, even with Supabase values set', () => {
    expect(
      resolveStorageDriver(
        { SUPABASE_URL: 'https://abc.supabase.co' },
        'selfhosted',
      ),
    ).toBe('postgres');
  });

  it('honours an explicit STORAGE_DRIVER over the default', () => {
    expect(
      resolveStorageDriver(
        { STORAGE_DRIVER: 'postgres', SUPABASE_URL: 'https://abc.supabase.co' },
        'saas',
      ),
    ).toBe('postgres');
    expect(resolveStorageDriver({ STORAGE_DRIVER: 'supabase' }, 'saas')).toBe(
      'supabase',
    );
  });

  it('rejects supabase when self-hosted', () => {
    expect(() =>
      resolveStorageDriver({ STORAGE_DRIVER: 'supabase' }, 'selfhosted'),
    ).toThrow(/not available when ALPHACI_DEPLOYMENT_MODE=selfhosted/);
  });

  it('rejects an unknown STORAGE_DRIVER', () => {
    expect(() =>
      resolveStorageDriver({ STORAGE_DRIVER: 'gcs' }, 'saas'),
    ).toThrow(/Invalid STORAGE_DRIVER/);
  });
});
