import { ServiceUnavailableException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { HealthService } from './health.service.js';
import { DatabaseService } from '#kernel/db/database.service.js';

/** A DatabaseService whose SELECT 1 resolves (true) or rejects (false). */
const makeDatabaseMock = (reachable: boolean): Partial<DatabaseService> => ({
  query: reachable
    ? jest.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] })
    : jest
        .fn()
        .mockRejectedValue(new ServiceUnavailableException('unreachable')),
});

const configServiceMock: Partial<ConfigService> = {
  get: jest.fn().mockReturnValue({
    github: { enforcedOrg: 'Alpha-Explora' },
  }),
};

describe('HealthService', () => {
  async function createService(
    database: Partial<DatabaseService>,
  ): Promise<HealthService> {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HealthService,
        { provide: DatabaseService, useValue: database },
        { provide: ConfigService, useValue: configServiceMock },
      ],
    }).compile();

    return module.get<HealthService>(HealthService);
  }

  it('should be defined', async () => {
    const service = await createService(makeDatabaseMock(true));
    expect(service).toBeDefined();
  });

  it('returns ok when database check passes', async () => {
    const service = await createService(makeDatabaseMock(true));
    const result = await service.getStatus();

    expect(result.status).toBe('ok');
    expect(result.checks.database).toBe(true);
    expect(result.checks.apiCenter).toBe(true);
    expect(result.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('probes the database with SELECT 1 and no application table', async () => {
    const database = makeDatabaseMock(true);
    const service = await createService(database);

    await service.getStatus();

    expect(database.query).toHaveBeenCalledWith('SELECT 1');
  });

  it('returns error when database check fails', async () => {
    const service = await createService(makeDatabaseMock(false));
    const result = await service.getStatus();

    expect(result.status).toBe('error');
    expect(result.checks.database).toBe(false);
    expect(result.checks.apiCenter).toBe(true);
  });

  it('returns error without a pool when DATABASE_URL is not configured', async () => {
    // DatabaseService throws synchronously-wrapped ServiceUnavailable from
    // query() when the pool is null; the probe must read that as unhealthy.
    const service = await createService({
      query: jest.fn().mockImplementation(() => {
        throw new ServiceUnavailableException('Database is not configured');
      }),
    });
    const result = await service.getStatus();

    expect(result.status).toBe('error');
    expect(result.checks.database).toBe(false);
  });

  it('returns error when the probe does not answer within the timeout', async () => {
    jest.useFakeTimers();
    try {
      const service = await createService({
        query: jest.fn().mockReturnValue(new Promise(() => undefined)),
      });
      const pending = service.getStatus();
      await jest.advanceTimersByTimeAsync(3_000);
      const result = await pending;

      expect(result.checks.database).toBe(false);
    } finally {
      jest.useRealTimers();
    }
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
        { provide: DatabaseService, useValue: makeDatabaseMock(true) },
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
      vercelManagedReady: false,
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
      vercelManagedReady: false,
    });
  });

  it('survives configuration being absent entirely', async () => {
    const service = await serviceWith({});

    await expect(service.getStatus()).resolves.toMatchObject({
      providers: {
        renderConfigured: false,
        vercelConfigured: false,
        vercelManagedReady: false,
      },
    });
  });

  /*
   * The shape that produced the outage: a Vercel token was set, so every
   * configuration signal read as healthy, but managed provisioning needs a
   * team id too and rejected every create. "Configured" and "able to create a
   * target" are different questions and the endpoint now answers both.
   */
  it('separates having a Vercel token from being able to use it', async () => {
    const service = await serviceWith({
      vercelToken: 'vercel_live_value',
    });

    const result = await service.getStatus();

    expect(result.providers.vercelConfigured).toBe(true);
    expect(result.providers.vercelManagedReady).toBe(false);
  });

  it('reports managed Vercel ready only when token and team id are both set', async () => {
    const service = await serviceWith({
      vercelToken: 'vercel_live_value',
      vercelTeamId: 'team_abc123',
    });

    const result = await service.getStatus();

    expect(result.providers.vercelManagedReady).toBe(true);
  });

  it('treats a whitespace team id as no team id', async () => {
    const service = await serviceWith({
      vercelToken: 'vercel_live_value',
      vercelTeamId: '   ',
    });

    const result = await service.getStatus();

    expect(result.providers.vercelManagedReady).toBe(false);
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
