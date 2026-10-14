import { OutboxDispatcher } from '#kernel/events/outbox-dispatcher';
import { OUTBOX_TOPICS } from '#kernel/events/outbox-topics';

import { OutboxRelayService } from './outbox-relay.service';
import {
  DEFAULT_OUTBOX_RELAY_INTERVAL_MS,
  OutboxRelayWorker,
  resolveOutboxRelayIntervalMs,
} from './outbox-relay.worker';

/*
 * For about four weeks nothing drained the outbox. The relay existed, only a
 * manual script called it, and nothing ran the script - so every audit event
 * and notification sat in platform.outbox_events as `pending`, including two
 * GitHub repository deletions GitHub had refused and nobody was told about.
 */

const makeService = (processPending = jest.fn().mockResolvedValue(0)) => {
  const service = new OutboxRelayService(
    { processPending } as never,
    new OutboxDispatcher(),
    { recordProjectEvent: jest.fn().mockResolvedValue(undefined) } as never,
    { record: jest.fn().mockResolvedValue(undefined) } as never,
  );
  return { service, processPending };
};

describe('OutboxRelayService.processPlatformEventsOnce', () => {
  /*
   * The timer must never claim hierarchy grant/revoke. Their handlers add and
   * remove people from GitHub teams, which is why the manual script refuses to
   * run until HIERARCHY_GITHUB_SYNC_MODE is set. Firing those every fifteen
   * seconds would be a far worse bug than the one this fixes.
   */
  it('claims only the audit and notification topics', async () => {
    const { service, processPending } = makeService();

    await service.processPlatformEventsOnce(10);

    const topics = processPending.mock.calls[0]?.[2] as string[];
    expect([...topics].sort()).toEqual(
      [
        OUTBOX_TOPICS.platformAuditRecorded,
        OUTBOX_TOPICS.platformNotificationRequested,
      ].sort(),
    );
    expect(topics).not.toContain(OUTBOX_TOPICS.hierarchyAssignmentGrant);
    expect(topics).not.toContain(OUTBOX_TOPICS.hierarchyAssignmentRevoke);
  });

  it('does not route through the dispatcher, so a claim cannot reach another handler', async () => {
    const handlers: string[] = [];
    const processPending = jest.fn(
      async (handler: (event: unknown) => Promise<void>) => {
        await handler({
          id: 'n-1',
          topic: OUTBOX_TOPICS.platformNotificationRequested,
          aggregateType: 'notification',
          aggregateId: 'user-1',
          payload: { userId: 'user-1', eventCode: 'x', title: 't', body: 'b' },
          createdAt: '2026-09-15T17:02:58.000Z',
        });
        return 1;
      },
    );
    const notifications = {
      record: jest.fn(async () => {
        handlers.push('notification');
      }),
    };
    const service = new OutboxRelayService(
      { processPending } as never,
      new OutboxDispatcher(),
      { recordProjectEvent: jest.fn() } as never,
      notifications as never,
    );
    // Deliberately NOT calling onModuleInit: nothing is registered with the
    // dispatcher, so a pass that went through it would throw.

    await expect(service.processPlatformEventsOnce()).resolves.toBe(1);
    expect(handlers).toEqual(['notification']);
  });
});

describe('OutboxRelayService.processHierarchyEventsOnce', () => {
  const registerHierarchyHandler = (dispatcher: OutboxDispatcher) => {
    const handle = jest.fn().mockResolvedValue(undefined);
    dispatcher.register({
      topics: [
        OUTBOX_TOPICS.hierarchyAssignmentGrant,
        OUTBOX_TOPICS.hierarchyAssignmentRevoke,
      ],
      handle,
    });
    return handle;
  };

  it('claims only the hierarchy grant and revoke topics', async () => {
    const processPending = jest.fn().mockResolvedValue(0);
    const dispatcher = new OutboxDispatcher();
    registerHierarchyHandler(dispatcher);
    const service = new OutboxRelayService(
      { processPending } as never,
      dispatcher,
      {} as never,
      {} as never,
    );

    await service.processHierarchyEventsOnce(10);

    const [, limit, topics] = processPending.mock.calls[0] as [
      unknown,
      number,
      string[],
    ];
    expect(limit).toBe(10);
    expect([...topics].sort()).toEqual(
      [
        OUTBOX_TOPICS.hierarchyAssignmentGrant,
        OUTBOX_TOPICS.hierarchyAssignmentRevoke,
      ].sort(),
    );
  });

  it('shares no topic with the platform pass, so one worker tick cannot claim an event twice', async () => {
    const processPending = jest.fn().mockResolvedValue(0);
    const dispatcher = new OutboxDispatcher();
    registerHierarchyHandler(dispatcher);
    const service = new OutboxRelayService(
      { processPending } as never,
      dispatcher,
      {} as never,
      {} as never,
    );

    await service.processPlatformEventsOnce();
    await service.processHierarchyEventsOnce();

    const platform = processPending.mock.calls[0]?.[2] as string[];
    const hierarchy = processPending.mock.calls[1]?.[2] as string[];
    expect(platform.filter((topic) => hierarchy.includes(topic))).toEqual([]);
  });

  it('claims through the shared lease and SKIP LOCKED path (processPending), so the Render cron can run alongside', async () => {
    const processPending = jest.fn().mockResolvedValue(0);
    const dispatcher = new OutboxDispatcher();
    registerHierarchyHandler(dispatcher);
    const service = new OutboxRelayService(
      { processPending } as never,
      dispatcher,
      {} as never,
      {} as never,
    );
    await service.processHierarchyEventsOnce();
    // The cron path (processPendingOnce) goes through the same claim primitive.
    await service.processPendingOnce();
    expect(processPending).toHaveBeenCalledTimes(2);
    expect(processPending.mock.calls[0]?.[3]).toEqual(
      processPending.mock.calls[1]?.[3],
    );
  });

  it('dispatches a claimed job to the registered hierarchy handler', async () => {
    const dispatcher = new OutboxDispatcher();
    const handle = registerHierarchyHandler(dispatcher);
    const event = {
      id: 'e-1',
      topic: OUTBOX_TOPICS.hierarchyAssignmentGrant,
      aggregateType: 'repository_assignment',
      aggregateId: 'a-1',
      payload: { assignmentId: 'a-1', actingUserId: 'u-1' },
      createdAt: '2026-10-08T00:00:00.000Z',
    };
    const processPending = jest.fn(
      async (handler: (e: unknown) => Promise<void>) => {
        await handler(event);
        return 1;
      },
    );
    const service = new OutboxRelayService(
      { processPending } as never,
      dispatcher,
      {} as never,
      {} as never,
    );

    await expect(service.processHierarchyEventsOnce()).resolves.toBe(1);
    expect(handle).toHaveBeenCalledWith(event);
  });

  it('claims nothing when no hierarchy handler is registered', async () => {
    const processPending = jest.fn().mockResolvedValue(0);
    const service = new OutboxRelayService(
      { processPending } as never,
      new OutboxDispatcher(),
      {} as never,
      {} as never,
    );
    await expect(service.processHierarchyEventsOnce()).resolves.toBe(0);
    expect(processPending).not.toHaveBeenCalled();
  });
});

describe('OutboxRelayWorker', () => {
  const originalInterval = process.env['OUTBOX_RELAY_INTERVAL_MS'];

  afterEach(() => {
    jest.useRealTimers();
    if (originalInterval === undefined) {
      delete process.env['OUTBOX_RELAY_INTERVAL_MS'];
    } else {
      process.env['OUTBOX_RELAY_INTERVAL_MS'] = originalInterval;
    }
  });

  const makeWorker = (dbEnabled = true, delivered = 0) => {
    const relay = {
      processPlatformEventsOnce: jest.fn().mockResolvedValue(delivered),
    };
    const worker = new OutboxRelayWorker(
      { isEnabled: () => dbEnabled } as never,
      relay as never,
    );
    return { worker, relay };
  };

  it('delivers on a timer without anyone having to configure it', () => {
    jest.useFakeTimers();
    delete process.env['OUTBOX_RELAY_INTERVAL_MS'];
    const { worker, relay } = makeWorker();

    worker.onModuleInit();
    jest.advanceTimersByTime(DEFAULT_OUTBOX_RELAY_INTERVAL_MS);

    expect(relay.processPlatformEventsOnce).toHaveBeenCalledTimes(1);
    worker.onModuleDestroy();
  });

  it('stops when the module is destroyed', () => {
    jest.useFakeTimers();
    const { worker, relay } = makeWorker();

    worker.onModuleInit();
    worker.onModuleDestroy();
    jest.advanceTimersByTime(DEFAULT_OUTBOX_RELAY_INTERVAL_MS * 3);

    expect(relay.processPlatformEventsOnce).not.toHaveBeenCalled();
  });

  it('stays inert without a database', () => {
    jest.useFakeTimers();
    const { worker, relay } = makeWorker(false);

    worker.onModuleInit();
    jest.advanceTimersByTime(DEFAULT_OUTBOX_RELAY_INTERVAL_MS * 2);

    expect(relay.processPlatformEventsOnce).not.toHaveBeenCalled();
  });

  it('can be switched off explicitly', () => {
    jest.useFakeTimers();
    process.env['OUTBOX_RELAY_INTERVAL_MS'] = '0';
    const { worker, relay } = makeWorker();

    worker.onModuleInit();
    jest.advanceTimersByTime(DEFAULT_OUTBOX_RELAY_INTERVAL_MS * 2);

    expect(relay.processPlatformEventsOnce).not.toHaveBeenCalled();
  });

  describe('hierarchy grant/revoke jobs', () => {
    const originalMode = process.env['HIERARCHY_GITHUB_SYNC_MODE'];
    afterEach(() => {
      if (originalMode === undefined) {
        delete process.env['HIERARCHY_GITHUB_SYNC_MODE'];
      } else {
        process.env['HIERARCHY_GITHUB_SYNC_MODE'] = originalMode;
      }
    });

    const makeBoth = (platform = 1, hierarchy = 2) => {
      const relay = {
        processPlatformEventsOnce: jest.fn().mockResolvedValue(platform),
        processHierarchyEventsOnce: jest.fn().mockResolvedValue(hierarchy),
      };
      const worker = new OutboxRelayWorker(
        { isEnabled: () => true } as never,
        relay as never,
      );
      return { worker, relay };
    };

    it('drains them in-process when HIERARCHY_GITHUB_SYNC_MODE is live', async () => {
      process.env['HIERARCHY_GITHUB_SYNC_MODE'] = 'live';
      const { worker, relay } = makeBoth(1, 2);
      await expect(worker.deliver()).resolves.toBe(3);
      expect(relay.processHierarchyEventsOnce).toHaveBeenCalledTimes(1);
    });

    it.each(['stub', undefined, 'LIVE', ''])(
      'leaves them to the manual script / cron when the mode is %p',
      async (mode) => {
        if (mode === undefined) {
          delete process.env['HIERARCHY_GITHUB_SYNC_MODE'];
        } else {
          process.env['HIERARCHY_GITHUB_SYNC_MODE'] = mode;
        }
        const { worker, relay } = makeBoth();
        await expect(worker.deliver()).resolves.toBe(1);
        expect(relay.processHierarchyEventsOnce).not.toHaveBeenCalled();
      },
    );

    it('still delivers audit and notifications when the hierarchy pass throws', async () => {
      process.env['HIERARCHY_GITHUB_SYNC_MODE'] = 'live';
      const { worker, relay } = makeBoth();
      relay.processHierarchyEventsOnce.mockRejectedValue(new Error('github'));
      await expect(worker.deliver()).rejects.toThrow('github');
      expect(relay.processPlatformEventsOnce).toHaveBeenCalledTimes(1);
      // The guard is released, so the next tick can run again.
      relay.processHierarchyEventsOnce.mockResolvedValue(0);
      await expect(worker.deliver()).resolves.toBe(1);
    });
  });

  it('never runs two passes over each other', async () => {
    let release: () => void = () => undefined;
    const relay = {
      processPlatformEventsOnce: jest.fn(
        () =>
          new Promise<number>((resolve) => {
            release = () => resolve(1);
          }),
      ),
    };
    const worker = new OutboxRelayWorker(
      { isEnabled: () => true } as never,
      relay as never,
    );

    const first = worker.deliver();
    await expect(worker.deliver()).resolves.toBe(0);
    release();
    await expect(first).resolves.toBe(1);
    expect(relay.processPlatformEventsOnce).toHaveBeenCalledTimes(1);
  });
});

describe('resolveOutboxRelayIntervalMs', () => {
  it('uses the default when unset or blank', () => {
    expect(resolveOutboxRelayIntervalMs(undefined)).toBe(
      DEFAULT_OUTBOX_RELAY_INTERVAL_MS,
    );
    expect(resolveOutboxRelayIntervalMs('  ')).toBe(
      DEFAULT_OUTBOX_RELAY_INTERVAL_MS,
    );
  });

  it('treats 0 as off', () => {
    expect(resolveOutboxRelayIntervalMs('0')).toBe(0);
  });

  /*
   * A typo must not quietly switch off audit logs and notifications - that is
   * exactly the silent failure this worker exists to end.
   */
  it('falls back to the default rather than disabling on a bad value', () => {
    expect(resolveOutboxRelayIntervalMs('fifteen')).toBe(
      DEFAULT_OUTBOX_RELAY_INTERVAL_MS,
    );
    expect(resolveOutboxRelayIntervalMs('-5')).toBe(
      DEFAULT_OUTBOX_RELAY_INTERVAL_MS,
    );
  });

  it('honours an explicit interval', () => {
    expect(resolveOutboxRelayIntervalMs('60000')).toBe(60_000);
  });
});
