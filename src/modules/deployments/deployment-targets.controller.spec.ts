import { firstValueFrom } from 'rxjs';

import { DeploymentTargetsController } from './deployment-targets.controller';
import type { DeploymentTargetsService } from './deployment-targets.service';

describe('DeploymentTargetsController', () => {
  const makeService = () =>
    ({
      listDeploymentTargets: jest.fn().mockResolvedValue([{ id: 'target-1' }]),
      createDeploymentTarget: jest.fn().mockResolvedValue({ id: 'target-2' }),
      getDeploymentTargetActions: jest.fn().mockResolvedValue({ actions: [] }),
      syncDeploymentTarget: jest.fn().mockResolvedValue({ synced: true }),
      updateDeploymentTargetMetadata: jest
        .fn()
        .mockResolvedValue({ id: 'target-1', branchName: 'test' }),
      detachDeploymentTarget: jest.fn().mockResolvedValue({ detached: true }),
      getDeploymentTargetLogs: jest
        .fn()
        .mockResolvedValue({ source: 'live', logs: [] }),
    }) as unknown as jest.Mocked<DeploymentTargetsService>;

  const request = { session: { user: { id: 'user-1' } } } as never;

  it('lists deployment targets for the current user project', async () => {
    const service = makeService();
    const controller = new DeploymentTargetsController(service);

    await expect(controller.list(request, 'project-1')).resolves.toEqual([
      { id: 'target-1' },
    ]);
    expect(service.listDeploymentTargets).toHaveBeenCalledWith(
      'project-1',
      'user-1',
    );
  });

  it('creates a deployment target for the current user project', async () => {
    const service = makeService();
    const controller = new DeploymentTargetsController(service);
    const body = { slot: 'frontend', provider: 'render' } as never;

    await expect(
      controller.create(request, 'project-1', body),
    ).resolves.toEqual({
      id: 'target-2',
    });
    expect(service.createDeploymentTarget).toHaveBeenCalledWith(
      'project-1',
      'user-1',
      body,
    );
  });

  it('returns target actions for the current user', async () => {
    const service = makeService();
    const controller = new DeploymentTargetsController(service);

    await expect(
      controller.actions(request, 'project-1', 'target-1'),
    ).resolves.toEqual({ actions: [] });
    expect(service.getDeploymentTargetActions).toHaveBeenCalledWith(
      'project-1',
      'target-1',
      'user-1',
    );
  });

  it('syncs a deployment target for the current user', async () => {
    const service = makeService();
    const controller = new DeploymentTargetsController(service);

    await expect(
      controller.sync(request, 'project-1', 'target-1'),
    ).resolves.toEqual({ synced: true });
    expect(service.syncDeploymentTarget).toHaveBeenCalledWith(
      'project-1',
      'target-1',
      'user-1',
    );
  });

  it('updates deployment target metadata for the current user', async () => {
    const service = makeService();
    const controller = new DeploymentTargetsController(service);
    const body = { branchName: 'test' };

    await expect(
      controller.update(request, 'project-1', 'target-1', body),
    ).resolves.toEqual({ id: 'target-1', branchName: 'test' });
    expect(service.updateDeploymentTargetMetadata).toHaveBeenCalledWith(
      'project-1',
      'target-1',
      'user-1',
      body,
    );
  });

  it('detaches deployment target metadata for the current user', async () => {
    const service = makeService();
    const controller = new DeploymentTargetsController(service);

    await expect(
      controller.detach(request, 'project-1', 'target-1'),
    ).resolves.toEqual({ detached: true });
    expect(service.detachDeploymentTarget).toHaveBeenCalledWith(
      'project-1',
      'target-1',
      'user-1',
      undefined,
    );
  });

  it('fetches deployment target logs with no filters for the current user', async () => {
    const service = makeService();
    const controller = new DeploymentTargetsController(service);

    await expect(
      controller.logs(request, 'project-1', 'target-1'),
    ).resolves.toEqual({ source: 'live', logs: [] });
    expect(service.getDeploymentTargetLogs).toHaveBeenCalledWith(
      'project-1',
      'target-1',
      'user-1',
      {},
    );
  });

  it('passes log type and time-range query params through to the service', async () => {
    const service = makeService();
    const controller = new DeploymentTargetsController(service);

    await expect(
      controller.logs(
        request,
        'project-1',
        'target-1',
        'build',
        '2026-07-11T00:00:00.000Z',
        '2026-07-12T00:00:00.000Z',
      ),
    ).resolves.toEqual({ source: 'live', logs: [] });
    expect(service.getDeploymentTargetLogs).toHaveBeenCalledWith(
      'project-1',
      'target-1',
      'user-1',
      {
        type: 'build',
        startTime: '2026-07-11T00:00:00.000Z',
        endTime: '2026-07-12T00:00:00.000Z',
      },
    );
  });

  it('streams the deployment target logs as an SSE message', async () => {
    const service = makeService();
    const controller = new DeploymentTargetsController(service);

    const stream = controller.logsStream(request, 'project-1', 'target-1');
    const event = await firstValueFrom(stream);

    expect(event).toEqual({ data: { source: 'live', logs: [] } });
    expect(service.getDeploymentTargetLogs).toHaveBeenCalledWith(
      'project-1',
      'target-1',
      'user-1',
      {},
    );
  });

  it('emits an error-shaped SSE message when the service rejects', async () => {
    const service = makeService();
    service.getDeploymentTargetLogs.mockRejectedValueOnce(
      new Error('Deployment target not found'),
    );
    const controller = new DeploymentTargetsController(service);

    const stream = controller.logsStream(request, 'project-1', 'target-1');
    const event = await firstValueFrom(stream);

    expect(event).toEqual({
      data: {
        source: 'simulated',
        reason: 'Deployment target not found',
        logs: [],
      },
    });
  });

  it('passes the detach request body through to the service', async () => {
    const service = makeService();
    const controller = new DeploymentTargetsController(service);
    const body = { deleteProviderResource: true };

    await expect(
      controller.detach(request, 'project-1', 'target-1', body),
    ).resolves.toEqual({ detached: true });
    expect(service.detachDeploymentTarget).toHaveBeenCalledWith(
      'project-1',
      'target-1',
      'user-1',
      body,
    );
  });
});
