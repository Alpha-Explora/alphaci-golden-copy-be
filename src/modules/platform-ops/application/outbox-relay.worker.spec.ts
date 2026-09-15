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
