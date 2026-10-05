import { Logger } from '@nestjs/common';

import type {
  DeploymentLogLine,
  DeploymentLogsQuery,
  DeploymentLogsResponse,
} from '../core/deployment-logs.types';
import { ProviderRateLimitedError } from '../core/provider-rate-limited.error';
import {
  DeploymentLogsHubService,
  LOG_STREAM_POLL_INTERVAL_MS as POLL_MS,
  type DeploymentLogsReader,
} from './deployment-logs-hub.service';

const NOW = '2026-10-05T12:00:00.000Z';

const line = (id: string, timestamp: string): DeploymentLogLine => ({
  id,
  timestamp,
  message: `line ${id}`,
  level: 'info',
  type: null,
  instance: null,
  labels: {},
});

const page = (
  overrides: Partial<DeploymentLogsResponse> = {},
): DeploymentLogsResponse => ({
  source: 'live',
  logs: [],
  hasMore: false,
  next: null,
  filters: [],
  ...overrides,
});

type ReadMock = jest.Mock<
  Promise<DeploymentLogsResponse>,
  [DeploymentLogsQuery]
>;

const makeReader = (
  overrides: Partial<DeploymentLogsReader> & { read?: ReadMock } = {},
): DeploymentLogsReader & { read: ReadMock } => ({
  provider: 'render',
  filters: [],
  bucketKey: 'render:connection:conn-1',
  targetKey: 'render:connection:conn-1:target:t1',
  read: jest.fn().mockResolvedValue(page()) as ReadMock,
  ...overrides,
});

const collect = <T>(stream: {
  subscribe: (observer: { next: (event: T) => void; complete: () => void }) => {
    unsubscribe: () => void;
  };
}) => {
  const events: T[] = [];
  let completed = false;
  const subscription = stream.subscribe({
    next: (event) => events.push(event),
    complete: () => {
      completed = true;
    },
  });

  return { events, subscription, isCompleted: () => completed };
};

const settle = () => jest.advanceTimersByTimeAsync(0);
const advance = (ms: number) => jest.advanceTimersByTimeAsync(ms);

describe('DeploymentLogsHubService', () => {
  let hub: DeploymentLogsHubService;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date(NOW));
    hub = new DeploymentLogsHubService();
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    hub.onModuleDestroy();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('append stream: sharing', () => {
    it('serves N subscribers of one target from ONE provider read per interval', async () => {
      const reader = makeReader();
      reader.read
        .mockResolvedValueOnce(
          page({ logs: [line('a', '2026-10-05T11:59:59.000Z')] }),
        )
        .mockResolvedValue(
          page({
            logs: [
              line('a', '2026-10-05T11:59:59.000Z'),
              line('b', '2026-10-05T12:00:03.000Z'),
            ],
          }),
        );

      const viewers = Array.from({ length: 5 }, () =>
        collect(hub.appendStream(reader, {})),
      );
      await settle();

      // Five concurrent identical snapshots collapse into one request.
      expect(reader.read).toHaveBeenCalledTimes(1);
      expect(hub.activePollerCount).toBe(1);

      await advance(POLL_MS);
      expect(reader.read).toHaveBeenCalledTimes(2);

      await advance(POLL_MS);
      expect(reader.read).toHaveBeenCalledTimes(3);

      for (const viewer of viewers) {
        // Each subscriber dedupes by ITS OWN cursor: 'b' once, never again.
        expect(
          viewer.events.map((event) => (event as { kind: string }).kind),
        ).toEqual(['snapshot', 'append']);
        expect(viewer.events[1]).toMatchObject({
          kind: 'append',
          logs: [line('b', '2026-10-05T12:00:03.000Z')],
        });
      }
    });

    it('sends the shared poll as a newest-page backward read of the content filters only', async () => {
      const reader = makeReader();
      collect(hub.appendStream(reader, { level: ['error'], text: 'boom' }));
      await settle();
      await advance(POLL_MS);

      expect(reader.read).toHaveBeenLastCalledWith({
        level: ['error'],
        text: 'boom',
        direction: 'backward',
        limit: 100,
      });
    });

    it('gives each distinct filter set its own poller', async () => {
      const reader = makeReader();
      collect(hub.appendStream(reader, { level: ['error'] }));
      collect(hub.appendStream(reader, { level: ['error'] }));
      collect(hub.appendStream(reader, {}));
      await settle();
      reader.read.mockClear();

      expect(hub.activePollerCount).toBe(2);
      await advance(POLL_MS);
      // One read per poller, not per subscriber.
      expect(reader.read).toHaveBeenCalledTimes(2);
    });

    it('tears the poller down when the last subscriber leaves and stops polling', async () => {
      const reader = makeReader();
      const first = collect(hub.appendStream(reader, {}));
      const second = collect(hub.appendStream(reader, {}));
      await settle();
      expect(hub.activePollerCount).toBe(1);

      first.subscription.unsubscribe();
      expect(hub.activePollerCount).toBe(1);
      second.subscription.unsubscribe();
      expect(hub.activePollerCount).toBe(0);

      reader.read.mockClear();
      await advance(POLL_MS * 4);
      expect(reader.read).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    });

    it('does not start a poller for a subscriber that left before its snapshot arrived', async () => {
      const reader = makeReader();
      const viewer = collect(hub.appendStream(reader, {}));
      viewer.subscription.unsubscribe();
      await settle();

      expect(hub.activePollerCount).toBe(0);
      expect(jest.getTimerCount()).toBe(0);
    });

    it('sends one snapshot and completes for a closed window, with no poller', async () => {
      const reader = makeReader();
      reader.read.mockResolvedValueOnce(
        page({ logs: [line('a', '2026-10-05T11:00:00.000Z')] }),
      );

      const viewer = collect(
        hub.appendStream(reader, {
          startTime: '2026-10-05T10:00:00.000Z',
          endTime: '2026-10-05T11:30:00.000Z',
        }),
      );
      await settle();

      expect(viewer.events).toHaveLength(1);
      expect(viewer.isCompleted()).toBe(true);
      expect(hub.activePollerCount).toBe(0);
      expect(reader.read).toHaveBeenCalledWith(
        expect.objectContaining({
          endTime: '2026-10-05T11:30:00.000Z',
          direction: 'backward',
          limit: 100,
        }),
      );
    });

    it('appends only lines at or after the connect time when the snapshot was empty', async () => {
      const reader = makeReader();
      reader.read.mockResolvedValueOnce(page()).mockResolvedValueOnce(
        page({
          logs: [
            line('old', '2026-10-05T11:00:00.000Z'),
            line('new', '2026-10-05T12:00:02.000Z'),
          ],
        }),
      );

      const viewer = collect(hub.appendStream(reader, {}));
      await settle();
      await advance(POLL_MS);

      expect(viewer.events[1]).toMatchObject({
        kind: 'append',
        logs: [line('new', '2026-10-05T12:00:02.000Z')],
      });
    });
  });

  describe('append stream: gap fallback', () => {
    it('falls back to a paged direct read when the shared page cannot cover the gap', async () => {
      const reader = makeReader();
      reader.read.mockImplementation((query) => {
        if (query.direction === 'forward') {
          return Promise.resolve(
            query.startTime === '2026-10-05T12:00:00.000Z'
              ? page({
                  logs: [
                    line('a', '2026-10-05T12:00:00.000Z'),
                    line('b', '2026-10-05T12:00:01.000Z'),
                  ],
                  hasMore: true,
                })
              : page({ logs: [line('c', '2026-10-05T12:00:02.000Z')] }),
          );
        }
        // Snapshot, then a full shared page whose oldest line is already
        // newer than the cursor: lines in between may be missing.
        return Promise.resolve(
          reader.read.mock.calls.length === 1
            ? page({ logs: [line('a', '2026-10-05T12:00:00.000Z')] })
            : page({
                logs: [line('z', '2026-10-05T12:00:04.000Z')],
                hasMore: true,
              }),
        );
      });

      const viewer = collect(hub.appendStream(reader, {}));
      await settle();
      await advance(POLL_MS);

      expect(viewer.events[1]).toMatchObject({
        kind: 'append',
        logs: [
          line('b', '2026-10-05T12:00:01.000Z'),
          line('c', '2026-10-05T12:00:02.000Z'),
        ],
      });
      const forward = reader.read.mock.calls.filter(
        ([query]) => query.direction === 'forward',
      );
      expect(forward).toHaveLength(2);
    });

    it('caps the catch-up at 5 provider pages', async () => {
      const reader = makeReader();
      let forward = 0;
      reader.read.mockImplementation((query) => {
        if (query.direction === 'forward') {
          forward += 1;
          return Promise.resolve(
            page({
              logs: [line(`p${forward}`, `2026-10-05T12:00:0${forward}.000Z`)],
              hasMore: true,
            }),
          );
        }
        return Promise.resolve(
          reader.read.mock.calls.length === 1
            ? page({ logs: [line('seed', '2026-10-05T12:00:00.000Z')] })
            : page({
                logs: [line('z', '2026-10-05T12:00:09.000Z')],
                hasMore: true,
              }),
        );
      });

      const viewer = collect(hub.appendStream(reader, {}));
      await settle();
      await advance(POLL_MS);

      expect(forward).toBe(5);
      expect((viewer.events[1] as { logs: unknown[] }).logs).toHaveLength(5);
    });
  });

  describe('append stream: failures', () => {
    it('reports a non-429 provider failure as unavailable and keeps going', async () => {
      const reader = makeReader();
      reader.read
        .mockResolvedValueOnce(
          page({ logs: [line('a', '2026-10-05T12:00:00.000Z')] }),
        )
        .mockResolvedValueOnce(
          page({ source: 'unavailable', reason: 'Render is down' }),
        )
        .mockResolvedValueOnce(
          page({ logs: [line('b', '2026-10-05T12:00:07.000Z')] }),
        );

      const viewer = collect(hub.appendStream(reader, {}));
      await settle();
      await advance(POLL_MS);
      await advance(POLL_MS);

      expect(viewer.events).toEqual([
        expect.objectContaining({ kind: 'snapshot' }),
        { kind: 'status', source: 'unavailable', reason: 'Render is down' },
        expect.objectContaining({
          kind: 'append',
          logs: [line('b', '2026-10-05T12:00:07.000Z')],
        }),
      ]);
      expect(warn).not.toHaveBeenCalled();
    });

    it('ends with an unavailable status when the snapshot read throws a non-429 error', async () => {
      const reader = makeReader();
      reader.read.mockRejectedValueOnce(new Error('kaboom'));

      const viewer = collect(hub.appendStream(reader, {}));
      await settle();

      expect(viewer.events).toEqual([
        { kind: 'status', source: 'unavailable', reason: 'kaboom' },
      ]);
      expect(viewer.isCompleted()).toBe(true);
      expect(hub.activePollerCount).toBe(0);
    });
  });

  describe('append stream: rate limiting', () => {
    const limited = (ms = 30_000) => new ProviderRateLimitedError('Render', ms);

    it('emits one rateLimited status per subscriber, pauses every read, then resumes', async () => {
      const reader = makeReader();
      reader.read
        .mockResolvedValueOnce(
          page({ logs: [line('a', '2026-10-05T12:00:00.000Z')] }),
        )
        .mockRejectedValueOnce(limited(30_000))
        .mockResolvedValue(
          page({
            logs: [
              line('a', '2026-10-05T12:00:00.000Z'),
              line('b', '2026-10-05T12:00:40.000Z'),
            ],
          }),
        );

      const viewers = [
        collect(hub.appendStream(reader, {})),
        collect(hub.appendStream(reader, {})),
        collect(hub.appendStream(reader, {})),
      ];
      await settle();
      await advance(POLL_MS); // tick: 429 -> cooldown until +35s
      const callsAtLimit = reader.read.mock.calls.length;

      for (const viewer of viewers) {
        expect(viewer.events).toEqual([
          expect.objectContaining({ kind: 'snapshot' }),
          {
            kind: 'status',
            source: 'live',
            rateLimited: true,
            retryAfterMs: 30_000,
          },
        ]);
      }

      // Ticks inside the cooldown never reach the provider and say nothing.
      await advance(25_000);
      expect(reader.read).toHaveBeenCalledTimes(callsAtLimit);
      for (const viewer of viewers) {
        expect(viewer.events).toHaveLength(2);
      }

      // Cooldown over: normal append ticks resume on the same stream.
      await advance(POLL_MS);
      expect(reader.read).toHaveBeenCalledTimes(callsAtLimit + 1);
      for (const viewer of viewers) {
        expect(viewer.events[2]).toMatchObject({
          kind: 'append',
          logs: [line('b', '2026-10-05T12:00:40.000Z')],
        });
      }
    });

    it('warns once per cooldown, not per subscriber or tick', async () => {
      const reader = makeReader();
      reader.read
        .mockResolvedValueOnce(page())
        .mockRejectedValueOnce(limited());
      collect(hub.appendStream(reader, {}));
      collect(hub.appendStream(reader, {}));
      await settle();
      await advance(POLL_MS);
      await advance(20_000);

      expect(warn).toHaveBeenCalledTimes(1);
      const message = String(warn.mock.calls[0]?.[0]);
      expect(message).toContain('render:connection:conn-1');
      expect(message).toContain('30s');
    });

    it('grows the cooldown on repeated 429s up to the 2 minute cap', async () => {
      const reader = makeReader();
      reader.read
        .mockResolvedValueOnce(page())
        .mockRejectedValue(limited(30_000));

      const viewer = collect(hub.appendStream(reader, {}));
      await settle();
      await advance(POLL_MS); // 429 #1 at t=5s  -> 30s
      await advance(30_000); //  429 #2 at t=35s -> 60s
      await advance(60_000); //  429 #3 at t=95s -> 120s
      await advance(120_000); // 429 #4 at t=215s -> capped 120s
      await advance(120_000); // 429 #5 at t=335s -> still 120s

      const waits = viewer.events
        .filter((event) => (event as { kind: string }).kind === 'status')
        .map((event) => (event as { retryAfterMs: number }).retryAfterMs);
      expect(waits).toEqual([30_000, 60_000, 120_000, 120_000, 120_000]);
      expect(warn).toHaveBeenCalledTimes(5);
    });

    it('resets the backoff after a successful read', async () => {
      const reader = makeReader();
      reader.read
        .mockResolvedValueOnce(page())
        .mockRejectedValueOnce(limited(30_000))
        .mockResolvedValueOnce(page())
        .mockRejectedValueOnce(limited(30_000));

      const viewer = collect(hub.appendStream(reader, {}));
      await settle();
      await advance(POLL_MS); // 429 -> 30s
      await advance(30_000); //  success
      await advance(POLL_MS); // 429 again -> back to 30s, not 60s

      const waits = viewer.events
        .filter((event) => (event as { kind: string }).kind === 'status')
        .map((event) => (event as { retryAfterMs: number }).retryAfterMs);
      expect(waits).toEqual([30_000, 30_000]);
    });

    it('shares the cooldown across every target on the same credential, but not other credentials', async () => {
      const first = makeReader();
      const sibling = makeReader({
        targetKey: 'render:connection:conn-1:target:t2',
      });
      const other = makeReader({
        bucketKey: 'render:connection:conn-2',
        targetKey: 'render:connection:conn-2:target:t3',
      });
      first.read.mockResolvedValueOnce(page()).mockRejectedValue(limited());
      collect(hub.appendStream(first, {}));
      collect(hub.appendStream(sibling, {}));
      collect(hub.appendStream(other, {}));
      await settle();
      await advance(POLL_MS);

      sibling.read.mockClear();
      other.read.mockClear();
      await advance(POLL_MS * 2);

      expect(sibling.read).not.toHaveBeenCalled();
      expect(other.read).toHaveBeenCalled();
    });

    it('tells a subscriber that joins mid-cooldown straight away', async () => {
      const reader = makeReader();
      reader.read
        .mockResolvedValueOnce(page())
        .mockRejectedValueOnce(limited(30_000));
      collect(hub.appendStream(reader, {}));
      await settle();
      await advance(POLL_MS);
      await advance(10_000);

      // The newcomer's snapshot is refused by the cooldown (no provider
      // call), so it hears about it at once and retries when it ends.
      const callsBefore = reader.read.mock.calls.length;
      const late = collect(hub.appendStream(reader, {}));
      await settle();

      expect(reader.read).toHaveBeenCalledTimes(callsBefore);
      expect(late.events).toEqual([
        {
          kind: 'status',
          source: 'live',
          rateLimited: true,
          retryAfterMs: 20_000,
        },
      ]);

      reader.read.mockResolvedValue(
        page({ logs: [line('x', '2026-10-05T12:00:30.000Z')] }),
      );
      await advance(20_000);
      expect(late.events[1]).toMatchObject({ kind: 'snapshot' });
      expect(hub.activePollerCount).toBe(1);
    });

    it('survives a 429 on the snapshot: status first, snapshot after the cooldown', async () => {
      const reader = makeReader();
      reader.read
        .mockRejectedValueOnce(limited(12_000))
        .mockResolvedValueOnce(
          page({ logs: [line('a', '2026-10-05T11:59:00.000Z')] }),
        );

      const viewer = collect(hub.appendStream(reader, {}));
      await settle();
      expect(viewer.events).toEqual([
        {
          kind: 'status',
          source: 'live',
          rateLimited: true,
          retryAfterMs: 12_000,
        },
      ]);
      expect(viewer.isCompleted()).toBe(false);

      await advance(12_000);
      expect(viewer.events[1]).toMatchObject({ kind: 'snapshot' });
      expect(hub.activePollerCount).toBe(1);
    });

    it('cancels the snapshot retry when the subscriber leaves during the cooldown', async () => {
      const reader = makeReader();
      reader.read.mockRejectedValueOnce(limited(12_000));
      const viewer = collect(hub.appendStream(reader, {}));
      await settle();
      viewer.subscription.unsubscribe();
      reader.read.mockClear();

      await advance(60_000);

      expect(reader.read).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    });

    it('never puts the provider message or body in the event', async () => {
      const reader = makeReader();
      reader.read
        .mockResolvedValueOnce(page())
        .mockRejectedValueOnce(limited(30_000));
      const viewer = collect(hub.appendStream(reader, {}));
      await settle();
      await advance(POLL_MS);

      const serialised = JSON.stringify(viewer.events[1]);
      expect(serialised).not.toContain('rate limit exceeded');
      expect(Object.keys(viewer.events[1] as object).sort()).toEqual([
        'kind',
        'rateLimited',
        'retryAfterMs',
        'source',
      ]);
    });

    it('counts a 429 on a subscriber catch-up read toward the same cooldown', async () => {
      const reader = makeReader();
      reader.read.mockImplementation((query) => {
        if (query.direction === 'forward') {
          return Promise.reject(limited(30_000));
        }
        return Promise.resolve(
          reader.read.mock.calls.length === 1
            ? page({ logs: [line('a', '2026-10-05T12:00:00.000Z')] })
            : page({
                logs: [line('z', '2026-10-05T12:00:04.000Z')],
                hasMore: true,
              }),
        );
      });

      const viewer = collect(hub.appendStream(reader, {}));
      await settle();
      await advance(POLL_MS);

      expect(viewer.events[1]).toEqual({
        kind: 'status',
        source: 'live',
        rateLimited: true,
        retryAfterMs: 30_000,
      });
      expect(warn).toHaveBeenCalledTimes(1);
    });
  });

  describe('legacy (non-append) stream', () => {
    it('pushes the full snapshot every interval in the existing shape', async () => {
      const reader = makeReader();
      reader.read.mockResolvedValue(
        page({ logs: [line('a', '2026-10-05T12:00:00.000Z')] }),
      );

      const viewer = collect(hub.legacyStream(reader, {}));
      await settle();
      await advance(POLL_MS);

      expect(viewer.events).toHaveLength(2);
      expect(viewer.events[0]).toEqual(
        page({ logs: [line('a', '2026-10-05T12:00:00.000Z')] }),
      );
    });

    it('shares reads between legacy subscribers instead of one per viewer', async () => {
      const reader = makeReader();
      collect(hub.legacyStream(reader, {}));
      collect(hub.legacyStream(reader, {}));
      collect(hub.legacyStream(reader, {}));
      await settle();
      expect(reader.read).toHaveBeenCalledTimes(1);

      await advance(POLL_MS);
      expect(reader.read).toHaveBeenCalledTimes(2);
    });

    it('emits { source: live, rateLimited, retryAfterMs, logs: [] } once, then keeps polling after the cooldown', async () => {
      const reader = makeReader();
      reader.read
        .mockRejectedValueOnce(new ProviderRateLimitedError('Render', 20_000))
        .mockResolvedValue(
          page({ logs: [line('a', '2026-10-05T12:00:25.000Z')] }),
        );

      const viewer = collect(hub.legacyStream(reader, {}));
      await settle();
      expect(viewer.events).toEqual([
        { source: 'live', rateLimited: true, retryAfterMs: 20_000, logs: [] },
      ]);

      await advance(15_000); // ticks inside the cooldown stay silent
      expect(viewer.events).toHaveLength(1);
      expect(reader.read).toHaveBeenCalledTimes(1);

      await advance(5_000); // cooldown over
      expect(viewer.events).toHaveLength(2);
      expect(viewer.events[1]).toMatchObject({ source: 'live' });
      expect(viewer.isCompleted()).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it("keeps today's terminal simulated shape for a non-429 throw", async () => {
      const reader = makeReader();
      reader.read.mockRejectedValueOnce(new Error('kaboom'));

      const viewer = collect(hub.legacyStream(reader, {}));
      await settle();

      expect(viewer.events).toEqual([
        { source: 'simulated', reason: 'kaboom', logs: [] },
      ]);
      expect(viewer.isCompleted()).toBe(true);
    });

    it('clears its interval on unsubscribe', async () => {
      const reader = makeReader();
      const viewer = collect(hub.legacyStream(reader, {}));
      await settle();
      viewer.subscription.unsubscribe();

      expect(jest.getTimerCount()).toBe(0);
    });
  });

  describe('read', () => {
    it('refuses to touch the provider during a cooldown and reports the time left', async () => {
      const reader = makeReader();
      reader.read.mockRejectedValueOnce(
        new ProviderRateLimitedError('Render', 30_000),
      );

      await expect(hub.read(reader, {})).rejects.toMatchObject({
        retryAfterMs: 30_000,
      });
      await advance(10_000);
      reader.read.mockClear();

      await expect(hub.read(reader, {})).rejects.toMatchObject({
        retryAfterMs: 20_000,
      });
      expect(reader.read).not.toHaveBeenCalled();
    });

    it('coalesces identical concurrent reads regardless of key order', async () => {
      const reader = makeReader();

      await Promise.all([
        hub.read(reader, { level: ['error'], text: 'x' }),
        hub.read(reader, { text: 'x', level: ['error'] }),
      ]);

      expect(reader.read).toHaveBeenCalledTimes(1);
    });
  });
});
