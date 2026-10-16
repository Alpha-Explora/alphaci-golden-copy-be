import { Logger } from '@nestjs/common';
import { firstValueFrom } from 'rxjs';

import { DeploymentLogsHubService } from '../application/deployment-logs-hub.service';
import { ProviderRateLimitedError } from '../core/provider-rate-limited.error';

import { DeploymentTargetsController } from './deployment-targets.controller';
import type { DeploymentTargetsService } from '../application/deployment-targets.service';

describe('DeploymentTargetsController', () => {
  const makeService = () =>
    ({
      listDeploymentTargets: jest.fn().mockResolvedValue([{ id: 'target-1' }]),
      createDeploymentTarget: jest.fn().mockResolvedValue({ id: 'target-2' }),
      getDeploymentTargetActions: jest.fn().mockResolvedValue({ actions: [] }),
      syncDeploymentTarget: jest.fn().mockResolvedValue({ synced: true }),
      reinstallDeploymentSecrets: jest
        .fn()
        .mockResolvedValue({ reinstalled: true, githubSecrets: {} }),
      updateDeploymentTargetMetadata: jest
        .fn()
        .mockResolvedValue({ id: 'target-1', branchName: 'test' }),
      detachDeploymentTarget: jest.fn().mockResolvedValue({ detached: true }),
      getDeploymentTargetLogs: jest
        .fn()
        .mockResolvedValue({ source: 'live', logs: [] }),
      openLogsReader: jest.fn().mockResolvedValue({
        provider: 'render',
        filters: [],
        bucketKey: 'render:connection:conn-1',
        targetKey: 'render:connection:conn-1:target:target-1',
        read: jest.fn().mockResolvedValue({ source: 'live', logs: [] }),
      }),
    }) as unknown as jest.Mocked<DeploymentTargetsService>;

  const request = { session: { user: { id: 'user-1' } } } as never;

  it('lists deployment targets for the current user project', async () => {
    const service = makeService();
    const controller = new DeploymentTargetsController(
      service,
      new DeploymentLogsHubService(),
    );

    await expect(controller.list(request, 'project-1')).resolves.toEqual([
      { id: 'target-1' },
    ]);
    expect(service.listDeploymentTargets).toHaveBeenCalledWith(
      'project-1',
      'user-1',
      undefined,
    );
  });

  it('creates a deployment target for the current user project', async () => {
    const service = makeService();
    const controller = new DeploymentTargetsController(
      service,
      new DeploymentLogsHubService(),
    );
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
      { githubAccessToken: null },
    );
  });

  it('returns target actions for the current user', async () => {
    const service = makeService();
    const controller = new DeploymentTargetsController(
      service,
      new DeploymentLogsHubService(),
    );

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
    const controller = new DeploymentTargetsController(
      service,
      new DeploymentLogsHubService(),
    );

    await expect(
      controller.sync(request, 'project-1', 'target-1'),
    ).resolves.toEqual({ synced: true });
    expect(service.syncDeploymentTarget).toHaveBeenCalledWith(
      'project-1',
      'target-1',
      'user-1',
    );
  });

  it('reinstalls CI secrets, passing the session GitHub token through', async () => {
    const service = makeService();
    const controller = new DeploymentTargetsController(
      service,
      new DeploymentLogsHubService(),
    );
    const tokenRequest = {
      session: { user: { id: 'user-1' }, githubAccessToken: 'gh-token' },
    } as never;

    await expect(
      controller.reinstallSecrets(tokenRequest, 'project-1', 'target-1'),
    ).resolves.toEqual({ reinstalled: true, githubSecrets: {} });
    expect(service.reinstallDeploymentSecrets).toHaveBeenCalledWith(
      'project-1',
      'target-1',
      'user-1',
      'gh-token',
    );
  });

  it('reinstalls CI secrets with a null token when the session has none', async () => {
    const service = makeService();
    const controller = new DeploymentTargetsController(
      service,
      new DeploymentLogsHubService(),
    );

    await controller.reinstallSecrets(request, 'project-1', 'target-1');

    expect(service.reinstallDeploymentSecrets).toHaveBeenCalledWith(
      'project-1',
      'target-1',
      'user-1',
      null,
    );
  });

  it('updates deployment target metadata for the current user', async () => {
    const service = makeService();
    const controller = new DeploymentTargetsController(
      service,
      new DeploymentLogsHubService(),
    );
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
    const controller = new DeploymentTargetsController(
      service,
      new DeploymentLogsHubService(),
    );

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
    const controller = new DeploymentTargetsController(
      service,
      new DeploymentLogsHubService(),
    );

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
    const controller = new DeploymentTargetsController(
      service,
      new DeploymentLogsHubService(),
    );

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
        type: ['build'],
        startTime: '2026-07-11T00:00:00.000Z',
        endTime: '2026-07-12T00:00:00.000Z',
      },
    );
  });

  it('parses comma lists, direction, and limit for GET .../logs', async () => {
    const service = makeService();
    const controller = new DeploymentTargetsController(
      service,
      new DeploymentLogsHubService(),
    );

    await expect(
      controller.logs(
        request,
        'project-1',
        'target-1',
        'build,app',
        undefined,
        undefined,
        'forward',
        '250',
        'error,warn',
        'timeout',
        'srv-1,srv-2',
      ),
    ).resolves.toEqual({ source: 'live', logs: [] });
    expect(service.getDeploymentTargetLogs).toHaveBeenCalledWith(
      'project-1',
      'target-1',
      'user-1',
      {
        type: ['build', 'app'],
        direction: 'forward',
        // 250 is clamped down to the 1..100 contract.
        limit: 100,
        level: ['error', 'warn'],
        text: 'timeout',
        instance: ['srv-1', 'srv-2'],
      },
    );
  });

  it('streams the deployment target logs as an SSE message', async () => {
    const service = makeService();
    const controller = new DeploymentTargetsController(
      service,
      new DeploymentLogsHubService(),
    );

    const stream = controller.logsStream(request, 'project-1', 'target-1');
    const event = await firstValueFrom(stream);

    expect(event).toEqual({ data: { source: 'live', logs: [] } });
    expect(service.openLogsReader).toHaveBeenCalledWith(
      'project-1',
      'target-1',
      'user-1',
    );
    const reader = await service.openLogsReader('project-1', 'target-1', 'u');
    expect(reader.read).toHaveBeenCalledWith({});
  });

  it('emits an error-shaped SSE message when the target cannot be opened', async () => {
    const service = makeService();
    service.openLogsReader.mockRejectedValueOnce(
      new Error('Deployment target not found'),
    );
    const controller = new DeploymentTargetsController(
      service,
      new DeploymentLogsHubService(),
    );

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

  it('reports an append-mode open failure as an unavailable status', async () => {
    const service = makeService();
    service.openLogsReader.mockRejectedValueOnce(
      new Error('Deployment target not found'),
    );
    const controller = new DeploymentTargetsController(
      service,
      new DeploymentLogsHubService(),
    );

    const event = await firstValueFrom(
      controller.logsStream(request, 'project-1', 'target-1', 'append'),
    );

    expect(event).toEqual({
      data: {
        kind: 'status',
        source: 'unavailable',
        reason: 'Deployment target not found',
      },
    });
  });

  it('wraps a hub snapshot and a 429 status as SSE data without the provider body', async () => {
    jest.useFakeTimers();
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    try {
      const service = makeService();
      const read = jest
        .fn()
        .mockRejectedValue(new ProviderRateLimitedError('render', 12_000));
      service.openLogsReader.mockResolvedValue({
        provider: 'render',
        filters: [],
        bucketKey: 'render:connection:conn-1',
        targetKey: 'render:connection:conn-1:target:target-1',
        read,
      });
      const controller = new DeploymentTargetsController(
        service,
        new DeploymentLogsHubService(),
      );

      const events: unknown[] = [];
      const subscription = controller
        .logsStream(request, 'project-1', 'target-1', 'append')
        .subscribe((event) => events.push(event));
      await jest.advanceTimersByTimeAsync(0);
      subscription.unsubscribe();

      expect(events).toEqual([
        {
          data: {
            kind: 'status',
            source: 'live',
            rateLimited: true,
            retryAfterMs: 12_000,
          },
        },
      ]);
    } finally {
      warn.mockRestore();
      jest.useRealTimers();
    }
  });

  it('passes the detach request body through to the service', async () => {
    const service = makeService();
    const controller = new DeploymentTargetsController(
      service,
      new DeploymentLogsHubService(),
    );
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
