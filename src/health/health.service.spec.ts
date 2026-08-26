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
