import { UnauthorizedException } from '@nestjs/common';

import { EnvVarsController } from './env-vars.controller';
import type { EnvVarsService } from './env-vars.service';

describe('EnvVarsController', () => {
  const makeService = () =>
    ({
      listEnvMetadata: jest.fn().mockResolvedValue([{ id: 'metadata-1' }]),
      provisionEnvVars: jest.fn().mockResolvedValue({ provisioned: 1 }),
      validateEnvText: jest.fn().mockResolvedValue({ valid: true }),
      deleteEnvMetadata: jest.fn().mockResolvedValue({ removed: true }),
    }) as unknown as jest.Mocked<EnvVarsService>;

  it('lists env metadata for the authenticated session user', async () => {
    const service = makeService();
    const controller = new EnvVarsController(service);

    await expect(
      controller.list(
        { session: { user: { id: 'user-1' } } } as never,
        'project-1',
      ),
    ).resolves.toEqual([{ id: 'metadata-1' }]);

    expect(service.listEnvMetadata).toHaveBeenCalledWith('project-1', 'user-1');
  });

  it('falls back to legacy session userId when listing metadata', async () => {
    const service = makeService();
    const controller = new EnvVarsController(service);

    await controller.list(
      { session: { userId: 'user-2' } } as never,
      'project-1',
    );

    expect(service.listEnvMetadata).toHaveBeenCalledWith('project-1', 'user-2');
  });

  it('rejects unauthenticated list requests', () => {
    const controller = new EnvVarsController(makeService());

    expect(() =>
      controller.list({ session: {} } as never, 'project-1'),
    ).toThrow(UnauthorizedException);
  });

  it('provisions env vars for the authenticated user', async () => {
    const service = makeService();
    const controller = new EnvVarsController(service);
    const body = {
      targetId: 'target-1',
      lane: 'preview' as const,
      gitBranch: 'feat/checkout',
      text: 'API_URL=https://example.test',
    } as never;

    await expect(
      controller.provision(
        { session: { user: { id: 'user-1' } } } as never,
        'project-1',
        body,
      ),
    ).resolves.toEqual({ provisioned: 1 });

    expect(service.provisionEnvVars).toHaveBeenCalledWith(
      'project-1',
      'user-1',
      body,
    );
  });

  it('validates env text for the authenticated user', async () => {
    const service = makeService();
    const controller = new EnvVarsController(service);
    const body = {
      text: 'API_URL=https://example.test',
      deploymentTargetId: 'target-1',
      lane: 'preview' as const,
      gitBranch: 'feat/checkout',
    };

    await expect(
      controller.validate(
        { session: { user: { id: 'user-1' } } } as never,
        'project-1',
        body,
      ),
    ).resolves.toEqual({ valid: true });

    expect(service.validateEnvText).toHaveBeenCalledWith(
      'project-1',
      'user-1',
      body,
    );
  });

  it('removes env metadata for the authenticated user', async () => {
    const service = makeService();
    const controller = new EnvVarsController(service);

    await expect(
      controller.remove(
        { session: { user: { id: 'user-1' } } } as never,
        'project-1',
        'metadata-1',
      ),
    ).resolves.toEqual({ removed: true });

    expect(service.deleteEnvMetadata).toHaveBeenCalledWith(
      'project-1',
      'metadata-1',
      'user-1',
    );
  });
});
