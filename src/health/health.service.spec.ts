import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { HealthService } from './health.service.js';
import { SupabaseService } from '#kernel/db/supabase/supabase.service.js';

const makeSupabaseMock = (pingResult: boolean): Partial<SupabaseService> => ({
  ping: jest.fn().mockResolvedValue(pingResult),
});

const configServiceMock: Partial<ConfigService> = {
  get: jest.fn().mockReturnValue({
    github: { enforcedOrg: 'Alpha-Explora' },
  }),
};

describe('HealthService', () => {
  async function createService(dbPing: boolean): Promise<HealthService> {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HealthService,
        { provide: SupabaseService, useValue: makeSupabaseMock(dbPing) },
        { provide: ConfigService, useValue: configServiceMock },
      ],
    }).compile();

    return module.get<HealthService>(HealthService);
  }

  it('should be defined', async () => {
    const service = await createService(true);
    expect(service).toBeDefined();
  });

  it('returns ok when database check passes', async () => {
    const service = await createService(true);
    const result = await service.getStatus();

    expect(result.status).toBe('ok');
    expect(result.checks.database).toBe(true);
    expect(result.checks.apiCenter).toBe(true);
    expect(result.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('returns error when database check fails', async () => {
    const service = await createService(false);
    const result = await service.getStatus();

    expect(result.status).toBe('error');
    expect(result.checks.database).toBe(false);
    expect(result.checks.apiCenter).toBe(true);
  });
});

/*
 * Whether hosting is configured on the RUNNING process.
 *
 * This exists because answering it once cost a source dive: a React project
 * was created with three Vercel deploy jobs and no Vercel project behind them,
 * and establishing whether the token was even set meant reading the
 * provisioning code and inferring from what it had not done.
 */
describe('HealthService, provider configuration', () => {
  const serviceWith = async (
    managed: Record<string, unknown>,
  ): Promise<HealthService> => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HealthService,
        { provide: SupabaseService, useValue: makeSupabaseMock(true) },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockReturnValue({
              github: { enforcedOrg: 'Alpha-Explora' },
              envProvisioning: { flowciManaged: managed },
            }),
          },
        },
      ],
    }).compile();

    return module.get<HealthService>(HealthService);
  };

  it('reports each provider independently', async () => {
    const service = await serviceWith({
      renderToken: 'rnd_live_value',
      vercelToken: '',
    });

    const result = await service.getStatus();

    expect(result.providers).toEqual({
      renderConfigured: true,
      vercelConfigured: false,
    });
  });

  it('treats whitespace as unconfigured', async () => {
    // An env var set to an empty string is the shape this is actually for:
    // present as a name, carrying nothing. Truthiness alone would call it
    // configured and send the reader looking in the wrong place.
    const service = await serviceWith({
      renderToken: '   ',
      vercelToken: '\n',
    });

    const result = await service.getStatus();

    expect(result.providers).toEqual({
      renderConfigured: false,
      vercelConfigured: false,
    });
  });

  it('survives configuration being absent entirely', async () => {
    const service = await serviceWith({});

    await expect(service.getStatus()).resolves.toMatchObject({
      providers: { renderConfigured: false, vercelConfigured: false },
    });
  });

  it('never puts a token in the response', async () => {
    // The endpoint is unauthenticated. One bit per provider is the whole
    // contract; a prefix or a length would still be more than it needs.
    const service = await serviceWith({
      renderToken: 'rnd_super_secret',
      vercelToken: 'vercel_super_secret',
    });

    const serialised = JSON.stringify(await service.getStatus());

    expect(serialised).not.toContain('rnd_super_secret');
    expect(serialised).not.toContain('vercel_super_secret');
  });
});
