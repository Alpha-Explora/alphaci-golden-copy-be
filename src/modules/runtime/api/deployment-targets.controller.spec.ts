import { firstValueFrom } from 'rxjs';

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

  it('reinstalls CI secrets, passing the session GitHub token through', async () => {
    const service = makeService();
    const controller = new DeploymentTargetsController(service);
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
    const controller = new DeploymentTargetsController(service);

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
        type: ['build'],
        startTime: '2026-07-11T00:00:00.000Z',
        endTime: '2026-07-12T00:00:00.000Z',
      },
    );
  });

  it('parses comma lists, direction, and limit for GET .../logs', async () => {
    const service = makeService();
    const controller = new DeploymentTargetsController(service);

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

  describe('logsStream mode=append', () => {
    // Must match the controller's private LOG_STREAM_POLL_INTERVAL_MS.
    const POLL_MS = 5_000;

    const line = (id: string, timestamp: string) => ({
      id,
      timestamp,
      message: `line ${id}`,
      level: 'info' as const,
      type: null,
      instance: null,
      labels: {},
    });

    const page = (overrides: Record<string, unknown>) => ({
      source: 'live' as const,
      hasMore: false,
      next: null,
      filters: [],
      logs: [],
      ...overrides,
    });

    // Flushes the microtask chain a snapshot/tick's async service call runs
    // through (promise -> defer/from -> map -> switchMap) without relying on
    // fake-timer macrotask advancement, since the snapshot fires on
    // subscribe rather than on an interval tick.
    const flush = async () => {
      for (let i = 0; i < 10; i += 1) {
        await Promise.resolve();
      }
    };

    afterEach(() => {
      jest.useRealTimers();
    });

    it('sends one snapshot and completes when endTime closes the window', async () => {
      jest.useFakeTimers();
      const service = makeService();
      service.getDeploymentTargetLogs.mockResolvedValueOnce(
        page({ logs: [line('a', '2026-07-12T00:00:00.000Z')] }),
      );
      const controller = new DeploymentTargetsController(service);

      const events: Array<{ data: unknown }> = [];
      let completed = false;
      controller
        .logsStream(
          request,
          'project-1',
          'target-1',
          'append',
          undefined,
          '2026-07-11T00:00:00.000Z',
          '2026-07-12T00:00:00.000Z',
        )
        .subscribe({
          next: (event) => events.push(event as { data: unknown }),
          complete: () => {
            completed = true;
          },
        });

      await flush();

      expect(events).toHaveLength(1);
      expect(events[0]?.data).toMatchObject({
        kind: 'snapshot',
        source: 'live',
        logs: [line('a', '2026-07-12T00:00:00.000Z')],
      });
      expect(completed).toBe(true);
      expect(service.getDeploymentTargetLogs).toHaveBeenCalledTimes(1);
      expect(service.getDeploymentTargetLogs).toHaveBeenCalledWith(
        'project-1',
        'target-1',
        'user-1',
        expect.objectContaining({
          startTime: '2026-07-11T00:00:00.000Z',
          endTime: '2026-07-12T00:00:00.000Z',
          direction: 'backward',
          limit: 100,
        }),
      );
    });

    it('polls forward after the snapshot and dedupes the boundary line', async () => {
      jest.useFakeTimers();
      const service = makeService();
      service.getDeploymentTargetLogs
        .mockResolvedValueOnce(
          page({ logs: [line('a', '2026-07-12T00:00:00.000Z')] }),
        )
        // Render's forward query starting at the cursor's own timestamp
        // re-includes the boundary line ('a') alongside the genuinely new one.
        .mockResolvedValueOnce(
          page({
            logs: [
              line('a', '2026-07-12T00:00:00.000Z'),
              line('b', '2026-07-12T00:00:05.000Z'),
            ],
          }),
        );
      const controller = new DeploymentTargetsController(service);

      const events: Array<{ data: { kind: string } }> = [];
      controller
        .logsStream(request, 'project-1', 'target-1', 'append')
        .subscribe({ next: (event) => events.push(event as never) });

      await flush();
      await jest.advanceTimersByTimeAsync(POLL_MS);
      await flush();

      expect(events.map((e) => e.data.kind)).toEqual(['snapshot', 'append']);
      expect(events[1]?.data).toMatchObject({
        kind: 'append',
        source: 'live',
        logs: [line('b', '2026-07-12T00:00:05.000Z')],
      });
      // The second call is the tail tick, querying forward from the snapshot's cursor.
      expect(service.getDeploymentTargetLogs).toHaveBeenNthCalledWith(
        2,
        'project-1',
        'target-1',
        'user-1',
        expect.objectContaining({
          startTime: '2026-07-12T00:00:00.000Z',
          direction: 'forward',
          limit: 100,
        }),
      );
    });

    it('caps forward paging at 5 provider calls per tick', async () => {
      jest.useFakeTimers();
      const service = makeService();
      // Distinguish the snapshot (direction: backward) from each tick page
      // (direction: forward) by the query itself, rather than a raw call
      // counter — every forward call reports hasMore so the tick keeps
      // paging until the cap stops it.
      let forwardCalls = 0;
      service.getDeploymentTargetLogs.mockImplementation((...args) => {
        const query = args[3] as { direction?: string } | undefined;
        if (query?.direction !== 'forward') {
          return Promise.resolve(
            page({ logs: [line('seed', '2026-07-12T00:00:00.000Z')] }),
          );
        }
        forwardCalls += 1;
        return Promise.resolve(
          page({
            logs: [
              line(
                `p${forwardCalls}`,
                `2026-07-12T00:00:0${forwardCalls}.000Z`,
              ),
            ],
            hasMore: true,
          }),
        );
      });
      const controller = new DeploymentTargetsController(service);

      const events: Array<{ data: { kind: string; logs?: unknown[] } }> = [];
      controller
        .logsStream(request, 'project-1', 'target-1', 'append')
        .subscribe({ next: (event) => events.push(event as never) });

      await flush();
      await jest.advanceTimersByTimeAsync(POLL_MS);
      await flush();

      // 1 snapshot call + exactly 5 paged calls during the one tick.
      expect(service.getDeploymentTargetLogs).toHaveBeenCalledTimes(6);
      const appendEvent = events.find((e) => e.data.kind === 'append');
      expect(appendEvent?.data.logs).toHaveLength(5);
    });

    it('emits a status event on a provider failure and keeps ticking afterward', async () => {
      jest.useFakeTimers();
      const service = makeService();
      service.getDeploymentTargetLogs
        .mockResolvedValueOnce(
          page({ logs: [line('a', '2026-07-12T00:00:00.000Z')] }),
        )
        .mockResolvedValueOnce(
          page({
            source: 'unavailable',
            reason: 'Render is down',
            logs: [],
          }),
        )
        .mockResolvedValueOnce(
          page({ logs: [line('b', '2026-07-12T00:00:05.000Z')] }),
        );
      const controller = new DeploymentTargetsController(service);

      const events: Array<{ data: { kind: string } }> = [];
      controller
        .logsStream(request, 'project-1', 'target-1', 'append')
        .subscribe({ next: (event) => events.push(event as never) });

      await flush();
      await jest.advanceTimersByTimeAsync(POLL_MS);
      await flush();
      await jest.advanceTimersByTimeAsync(POLL_MS);
      await flush();

      expect(events.map((e) => e.data.kind)).toEqual([
        'snapshot',
        'status',
        'append',
      ]);
      expect(events[1]?.data).toMatchObject({
        kind: 'status',
        source: 'unavailable',
        reason: 'Render is down',
      });
      expect(events[2]?.data).toMatchObject({
        kind: 'append',
        logs: [line('b', '2026-07-12T00:00:05.000Z')],
      });
    });
  });
});
