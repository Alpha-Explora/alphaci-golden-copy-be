import { ForbiddenException, UnauthorizedException } from '@nestjs/common';

import { EnvVarsController } from './env-vars.controller';
import type { EnvVarsService } from '../application/env-vars.service';

describe('EnvVarsController', () => {
  const makeService = () =>
    ({
      assertHttpAccess: jest.fn().mockResolvedValue(undefined),
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

    expect(service.assertHttpAccess).toHaveBeenCalledWith(
      'project-1',
      'user-1',
    );
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

  it('rejects unauthenticated list requests', async () => {
    const controller = new EnvVarsController(makeService());

    await expect(
      controller.list({ session: {} } as never, 'project-1'),
    ).rejects.toThrow(UnauthorizedException);
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

    expect(service.assertHttpAccess).toHaveBeenCalledWith(
      'project-1',
      'user-1',
    );
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

    expect(service.assertHttpAccess).toHaveBeenCalledWith(
      'project-1',
      'user-1',
    );
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

    expect(service.assertHttpAccess).toHaveBeenCalledWith(
      'project-1',
      'user-1',
    );
    expect(service.deleteEnvMetadata).toHaveBeenCalledWith(
      'project-1',
      'metadata-1',
      'user-1',
    );
  });

  it.each([
    ['list', (c: EnvVarsController, req: never) => c.list(req, 'project-1')],
    [
      'provision',
      (c: EnvVarsController, req: never) =>
        c.provision(req, 'project-1', {} as never),
    ],
    [
      'validate',
      (c: EnvVarsController, req: never) =>
        c.validate(req, 'project-1', {} as never),
    ],
    [
      'remove',
      (c: EnvVarsController, req: never) =>
        c.remove(req, 'project-1', 'metadata-1'),
    ],
  ] as const)(
    '%s refuses and never calls the underlying method when assertHttpAccess is refused',
    async (_name, call) => {
      const service = makeService();
      service.assertHttpAccess.mockRejectedValue(
        new ForbiddenException({ code: 'ENV_VARS_LEAD_ONLY' }),
      );
      const controller = new EnvVarsController(service);
      const req = { session: { user: { id: 'user-1' } } } as never;

      await expect(call(controller, req)).rejects.toBeInstanceOf(
        ForbiddenException,
      );

      expect(service.listEnvMetadata).not.toHaveBeenCalled();
      expect(service.provisionEnvVars).not.toHaveBeenCalled();
      expect(service.validateEnvText).not.toHaveBeenCalled();
      expect(service.deleteEnvMetadata).not.toHaveBeenCalled();
    },
  );
});
