import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { HttpException, HttpStatus } from '@nestjs/common';
import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';
import type { HealthResponse, HealthStatus } from './health.service.js';

function makeServiceMock(
  status: HealthStatus,
  database: boolean,
): Partial<HealthService> {
  return {
    getStatus: jest.fn().mockResolvedValue({
      status,
      uptimeSeconds: 42,
      checks: { database, apiCenter: true },
      deploy: {
        gitCommit: 'test-sha',
        githubEnforcedOrg: 'Alpha-Explora',
        githubAppConfigured: true,
        githubAppId: '4114943',
        githubAppSlug: 'alphaci-test',
      },
      providers: { renderConfigured: true, vercelConfigured: false },
    } satisfies HealthResponse),
  };
}

describe('HealthController', () => {
  async function createController(
    status: HealthStatus,
    database: boolean,
  ): Promise<HealthController> {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        {
          provide: HealthService,
          useValue: makeServiceMock(status, database),
        },
      ],
    }).compile();
    return module.get<HealthController>(HealthController);
  }

  it('should be defined', async () => {
    const controller = await createController('ok', true);
    expect(controller).toBeDefined();
  });

  it('returns 200 with ok payload when database check passes', async () => {
    const controller = await createController('ok', true);
    const response = await controller.getHealth();

    expect(response.status).toBe('ok');
    expect(response.checks.database).toBe(true);
    expect(response.checks.apiCenter).toBe(true);
    expect(typeof response.uptimeSeconds).toBe('number');
    expect(response.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('throws HttpException 503 when database check fails', async () => {
    const controller = await createController('error', false);

    const promise = controller.getHealth();
    await expect(promise).rejects.toThrow(HttpException);

    try {
      await controller.getHealth();
    } catch (err: unknown) {
      if (err instanceof HttpException) {
        expect(err.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
        const body = err.getResponse() as HealthResponse;
        expect(body.status).toBe('error');
        expect(body.checks.database).toBe(false);
        expect(body.checks.apiCenter).toBe(true);
      }
    }
  });
});
