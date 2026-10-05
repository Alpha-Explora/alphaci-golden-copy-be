import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Observable, type Subscriber } from 'rxjs';

import type {
  DeploymentLogLine,
  DeploymentLogsQuery,
  DeploymentLogsResponse,
  DeploymentLogsSource,
  LogFilterKey,
} from '../core/deployment-logs.types';
import { ProviderRateLimitedError } from '../core/provider-rate-limited.error';
import {
  advanceAppendCursor,
  type AppendCursor,
} from './deployment-logs-append-cursor';
import { ProviderCooldownRegistry } from './provider-cooldown.registry';
import { ShortTtlCoalescer } from './short-ttl-coalescer';

export const LOG_STREAM_POLL_INTERVAL_MS = 5_000;

/** Bounds one catch-up read's forward paging so a chatty deployment cannot run away. */
export const APPEND_TICK_PAGE_CAP = 5;

/** Page size of the shared poll and of every direct read (the 1..100 contract maximum). */
const LOG_PAGE_LIMIT = 100;

/**
 * Legacy (non-append) subscribers each want the SAME full snapshot every
 * interval; a result younger than this is shared instead of refetched. Just
 * under the poll interval so a subscriber that polls a little out of phase
 * still shares its neighbour's read rather than doubling the call rate.
 */
const LEGACY_SHARE_TTL_MS = LOG_STREAM_POLL_INTERVAL_MS - 500;

/**
 * What the hub needs from one deployment target, resolved (and access-checked)
 * once per subscriber by DeploymentTargetsService.openLogsReader. `read` may
 * throw ProviderRateLimitedError; any other provider failure comes back as a
 * `source: 'unavailable'` response, never a throw.
 */
export interface DeploymentLogsReader {
  provider: string;
  /** Filters this provider supports, for responses the hub cannot get from a read. */
  filters: LogFilterKey[];
  /** Identifies the provider rate-limit bucket (never a raw token). */
  bucketKey: string;
  /** Identifies the target within that bucket; shared poller / coalescing key. */
  targetKey: string;
  read(query: DeploymentLogsQuery): Promise<DeploymentLogsResponse>;
}

/** Append-mode stream events, exactly as the SSE `data` payload. */
export type DeploymentLogStreamEvent =
  | ({ kind: 'snapshot' } & DeploymentLogsResponse)
  | { kind: 'append'; source: DeploymentLogsSource; logs: DeploymentLogLine[] }
  | { kind: 'status'; source: 'unavailable'; reason?: string | undefined }
  | {
      kind: 'status';
      source: 'live';
      rateLimited: true;
      retryAfterMs: number;
    };

/** Legacy (non-append) stream events: a full snapshot per tick, the rate-limit notice, or a terminal failure. */
export type LegacyDeploymentLogStreamEvent =
  | DeploymentLogsResponse
  | { source: 'simulated'; reason: string; logs: [] }
  | {
      source: 'live';
      rateLimited: true;
      retryAfterMs: number;
      logs: [];
    };

interface TailSubscriber {
  out: Subscriber<DeploymentLogStreamEvent>;
  cursor: AppendCursor | null;
  /** Lower bound of "new" while no line has been seen yet (the snapshot's end). */
  floor: string;
  /** A catch-up read is running; skip its shared-page tick rather than overlap. */
  busy: boolean;
  /** Cooldown end this subscriber was last told about (one notice per cooldown). */
  announcedUntil: number;
}

interface TailPoller {
  key: string;
  reader: DeploymentLogsReader;
  /** Content filters only; the poller owns time range, direction and limit. */
  tickFilters: DeploymentLogsQuery;
  subscribers: Set<TailSubscriber>;
  timer: ReturnType<typeof setInterval>;
  /** The shared read is in flight; the next interval does not stack another. */
  running: boolean;
}

/**
 * Shares provider log reads between viewers.
 *
 * Render (and Vercel) rate-limit per API key, not per browser tab, yet every
 * open log console used to run its own 5s poll: 12 provider calls/min per
 * console, multiplied by viewers and tabs, until the key was limited and the
 * whole product lost logs. This hub makes the provider cost a function of how
 * many TARGETS are being watched, not how many people watch:
 *
 * - one tail poller per target + filter set, one provider read per interval,
 *   fanned out to every subscriber (each dedupes by its own cursor);
 * - identical concurrent reads (snapshots) collapse into one request;
 * - a 429 opens a cooldown for the whole credential bucket - no poller reads
 *   until it ends - and is reported to each subscriber as a status event
 *   instead of ending the stream.
 */
@Injectable()
export class DeploymentLogsHubService implements OnModuleDestroy {
  private readonly logger = new Logger(DeploymentLogsHubService.name);
  private readonly cooldowns = new ProviderCooldownRegistry();
  private readonly reads = new ShortTtlCoalescer<DeploymentLogsResponse>();
  private readonly pollers = new Map<string, TailPoller>();

  onModuleDestroy(): void {
    for (const poller of this.pollers.values()) {
      clearInterval(poller.timer);
    }
    this.pollers.clear();
  }

  /**
   * One provider read, gated by the credential's cooldown and coalesced with
   * identical in-flight (or, with `ttlMs`, very recent) reads. Throws
   * ProviderRateLimitedError - carrying the REMAINING cooldown - rather than
   * touching the provider while limited.
   */
  async read(
    reader: DeploymentLogsReader,
    query: DeploymentLogsQuery,
    ttlMs = 0,
  ): Promise<DeploymentLogsResponse> {
    const remaining = this.cooldowns.remainingMs(reader.bucketKey);
    if (remaining > 0) {
      throw new ProviderRateLimitedError(reader.provider, remaining);
    }

    return this.reads.run(
      `${reader.targetKey}|${stableKey(query)}`,
      ttlMs,
      async () => {
        try {
          const response = await reader.read(query);
          if (response.source === 'live') {
            this.cooldowns.recordSuccess(reader.bucketKey);
          }

          return response;
        } catch (err) {
          if (err instanceof ProviderRateLimitedError) {
            throw this.openCooldown(reader, err);
          }
          throw err;
        }
      },
    );
  }

  /**
   * `mode=append`: a snapshot (newest page, backward), then - unless endTime
   * closed the window - new lines only, served from the shared poller.
   * Survives a 429 by reporting it and carrying on once the cooldown ends.
   */
  appendStream(
    reader: DeploymentLogsReader,
    filters: DeploymentLogsQuery,
  ): Observable<DeploymentLogStreamEvent> {
    return new Observable<DeploymentLogStreamEvent>((out) => {
      const closedWindow = Boolean(filters.endTime);
      const snapshotEndTime = filters.endTime ?? new Date().toISOString();
      let disposed = false;
      let retryTimer: ReturnType<typeof setTimeout> | undefined;
      let leaveTail: (() => void) | undefined;

      const loadSnapshot = async (): Promise<void> => {
        try {
          const snapshot = await this.read(reader, {
            ...filters,
            endTime: snapshotEndTime,
            direction: 'backward',
            limit: LOG_PAGE_LIMIT,
          });
          if (disposed) {
            return;
          }
          out.next({ kind: 'snapshot', ...snapshot });
          if (closedWindow) {
            out.complete();
            return;
          }
          // Seed the tail cursor from the snapshot without treating any of
          // its lines as "appended" - the snapshot event already carried them.
          leaveTail = this.joinTail(
            reader,
            filters,
            advanceAppendCursor(null, snapshot.logs).cursor,
            snapshotEndTime,
            out,
          );
        } catch (err) {
          if (disposed) {
            return;
          }
          if (err instanceof ProviderRateLimitedError) {
            out.next(rateLimitedEvent(err.retryAfterMs));
            retryTimer = setTimeout(() => {
              void loadSnapshot();
            }, err.retryAfterMs);
            return;
          }
          out.next(unavailableEvent(err));
          out.complete();
        }
      };

      void loadSnapshot();

      return () => {
        disposed = true;
        if (retryTimer) {
          clearTimeout(retryTimer);
        }
        leaveTail?.();
      };
    });
  }

  /**
   * Legacy (no `mode`) stream: the full snapshot every interval. Same wire
   * shape as before; reads are shared through the coalescer, and a 429 is
   * reported once per cooldown instead of ending the stream.
   */
  legacyStream(
    reader: DeploymentLogsReader,
    filters: DeploymentLogsQuery,
  ): Observable<LegacyDeploymentLogStreamEvent> {
    return new Observable<LegacyDeploymentLogStreamEvent>((out) => {
      let disposed = false;
      let busy = false;
      let announcedUntil = 0;

      const announce = (until: number, retryAfterMs: number): void => {
        if (announcedUntil !== until) {
          announcedUntil = until;
          out.next({
            source: 'live',
            rateLimited: true,
            retryAfterMs,
            logs: [],
          });
        }
      };

      const tick = async (): Promise<void> => {
        if (busy) {
          return;
        }
        busy = true;
        try {
          const until = this.cooldowns.untilMs(reader.bucketKey);
          if (until > 0) {
            announce(until, until - Date.now());
            return;
          }
          const result = await this.read(reader, filters, LEGACY_SHARE_TTL_MS);
          if (!disposed) {
            out.next(result);
          }
        } catch (err) {
          if (disposed) {
            return;
          }
          if (err instanceof ProviderRateLimitedError) {
            announce(
              this.cooldowns.untilMs(reader.bucketKey),
              err.retryAfterMs,
            );
            return;
          }
          out.next({
            source: 'simulated',
            reason: err instanceof Error ? err.message : String(err),
            logs: [],
          });
          out.complete();
        } finally {
          busy = false;
        }
      };

      void tick();
      const timer = setInterval(() => {
        void tick();
      }, LOG_STREAM_POLL_INTERVAL_MS);
      unrefTimer(timer);

      return () => {
        disposed = true;
        clearInterval(timer);
      };
    });
  }

  /** Number of live tail pollers; exposed so tests can prove teardown. */
  get activePollerCount(): number {
    return this.pollers.size;
  }

  private openCooldown(
    reader: DeploymentLogsReader,
    error: ProviderRateLimitedError,
  ): ProviderRateLimitedError {
    const { retryAfterMs, started } = this.cooldowns.trip(
      reader.bucketKey,
      error.retryAfterMs,
    );
    if (started) {
      // Once per cooldown - not per subscriber, not per tick.
      this.logger.warn(
        `${error.provider} rate limit hit for ${reader.bucketKey}; pausing log reads for ${String(Math.ceil(retryAfterMs / 1000))}s`,
      );
    }

    return new ProviderRateLimitedError(error.provider, retryAfterMs);
  }

  private joinTail(
    reader: DeploymentLogsReader,
    filters: DeploymentLogsQuery,
    cursor: AppendCursor | null,
    floor: string,
    out: Subscriber<DeploymentLogStreamEvent>,
  ): () => void {
    // Tail ticks always read an open window up to "now"; only the content
    // filters carry over from the stream's own query.
    const tickFilters: DeploymentLogsQuery = {
      ...(filters.type ? { type: filters.type } : {}),
      ...(filters.level ? { level: filters.level } : {}),
      ...(filters.text ? { text: filters.text } : {}),
      ...(filters.instance ? { instance: filters.instance } : {}),
    };
    const key = `${reader.targetKey}|${stableKey(tickFilters)}`;
    const subscriber: TailSubscriber = {
      out,
      cursor,
      floor,
      busy: false,
      announcedUntil: 0,
    };

    let poller = this.pollers.get(key);
    if (!poller) {
      const created: TailPoller = {
        key,
        reader,
        tickFilters,
        subscribers: new Set(),
        running: false,
        timer: setInterval(() => {
          void this.tick(created);
        }, LOG_STREAM_POLL_INTERVAL_MS),
      };
      unrefTimer(created.timer);
      this.pollers.set(key, created);
      poller = created;
    }
    poller.subscribers.add(subscriber);

    // Joining mid-cooldown: tell the newcomer now rather than leaving it
    // silent until the pause ends.
    const until = this.cooldowns.untilMs(reader.bucketKey);
    if (until > 0) {
      this.announce(subscriber, until, until - Date.now());
    }

    const joined = poller;
    return () => {
      joined.subscribers.delete(subscriber);
      if (joined.subscribers.size === 0) {
        clearInterval(joined.timer);
        if (this.pollers.get(key) === joined) {
          this.pollers.delete(key);
        }
      }
    };
  }

  /** One shared interval tick: at most one provider read, however many subscribers. */
  private async tick(poller: TailPoller): Promise<void> {
    if (poller.running) {
      return;
    }
    poller.running = true;
    try {
      const until = this.cooldowns.untilMs(poller.reader.bucketKey);
      if (until > 0) {
        this.announceAll(poller, until, until - Date.now());
        return;
      }

      let shared: DeploymentLogsResponse;
      try {
        shared = await this.read(poller.reader, {
          ...poller.tickFilters,
          direction: 'backward',
          limit: LOG_PAGE_LIMIT,
        });
      } catch (err) {
        if (err instanceof ProviderRateLimitedError) {
          this.announceAll(
            poller,
            this.cooldowns.untilMs(poller.reader.bucketKey),
            err.retryAfterMs,
          );
        } else {
          for (const subscriber of [...poller.subscribers]) {
            subscriber.out.next(unavailableEvent(err));
          }
        }
        return;
      }

      await Promise.all(
        [...poller.subscribers].map((subscriber) =>
          this.serve(poller, subscriber, shared),
        ),
      );
    } finally {
      poller.running = false;
    }
  }

  /**
   * Turns the shared newest page into this subscriber's append event, by its
   * own cursor. If more lines arrived since the cursor than the page holds
   * (the page is full and its oldest line is still newer than the cursor),
   * the page cannot prove nothing was missed, so this subscriber alone falls
   * back to a direct forward read - still through the cooldown gate.
   */
  private async serve(
    poller: TailPoller,
    subscriber: TailSubscriber,
    shared: DeploymentLogsResponse,
  ): Promise<void> {
    if (subscriber.busy) {
      return;
    }
    subscriber.busy = true;
    try {
      if (shared.source === 'unavailable') {
        subscriber.out.next(unavailableEvent(undefined, shared.reason));
        return;
      }

      const floor = subscriber.cursor?.time ?? subscriber.floor;
      const oldest = shared.logs[0];
      // >= (not >): lines sharing the boundary millisecond may sit beyond the
      // page limit too, so an oldest line AT the cursor cannot prove coverage.
      if (
        shared.hasMore &&
        oldest &&
        Date.parse(oldest.timestamp) >= Date.parse(floor)
      ) {
        await this.catchUp(poller, subscriber, floor);
        return;
      }

      const fresh = shared.logs.filter(
        (line) => Date.parse(line.timestamp) >= Date.parse(floor),
      );
      const { cursor, appended } = advanceAppendCursor(
        subscriber.cursor,
        fresh,
      );
      subscriber.cursor = cursor;
      if (appended.length > 0) {
        subscriber.out.next({
          kind: 'append',
          source: shared.source,
          logs: appended,
        });
      }
    } finally {
      subscriber.busy = false;
    }
  }

  /** Direct paged forward read from `floor` for a subscriber the shared page cannot cover. */
  private async catchUp(
    poller: TailPoller,
    subscriber: TailSubscriber,
    floor: string,
  ): Promise<void> {
    let cursor = subscriber.cursor;
    let startTime = floor;
    let more = true;
    let pages = 0;
    let source: DeploymentLogsSource = 'live';
    const collected: DeploymentLogLine[] = [];
    let failure: unknown;
    let failureReason: string | undefined;

    while (more && pages < APPEND_TICK_PAGE_CAP) {
      pages += 1;
      let page: DeploymentLogsResponse;
      try {
        page = await this.read(poller.reader, {
          ...poller.tickFilters,
          startTime,
          direction: 'forward',
          limit: LOG_PAGE_LIMIT,
        });
      } catch (err) {
        failure = err;
        break;
      }

      source = page.source;
      if (page.source === 'unavailable') {
        failureReason = page.reason;
        failure = page;
        break;
      }

      const next = advanceAppendCursor(cursor, page.logs);
      cursor = next.cursor;
      collected.push(...next.appended);
      if (next.cursor) {
        startTime = next.cursor.time;
      }
      more = page.hasMore;
    }

    // Lines gathered before a failure are real and already advanced the
    // cursor, so they are sent rather than silently dropped.
    subscriber.cursor = cursor;
    if (collected.length > 0) {
      subscriber.out.next({ kind: 'append', source, logs: collected });
    }
    if (failure instanceof ProviderRateLimitedError) {
      this.announce(
        subscriber,
        this.cooldowns.untilMs(poller.reader.bucketKey),
        failure.retryAfterMs,
      );
    } else if (failure) {
      subscriber.out.next(unavailableEvent(failure, failureReason));
    }
  }

  private announceAll(
    poller: TailPoller,
    until: number,
    retryAfterMs: number,
  ): void {
    for (const subscriber of [...poller.subscribers]) {
      this.announce(subscriber, until, retryAfterMs);
    }
  }

  /** Emits the rate-limit status at most once per cooldown per subscriber. */
  private announce(
    subscriber: TailSubscriber,
    until: number,
    retryAfterMs: number,
  ): void {
    if (subscriber.announcedUntil === until) {
      return;
    }
    subscriber.announcedUntil = until;
    subscriber.out.next(rateLimitedEvent(retryAfterMs));
  }
}

function rateLimitedEvent(retryAfterMs: number): DeploymentLogStreamEvent {
  return {
    kind: 'status',
    source: 'live',
    rateLimited: true,
    retryAfterMs,
  };
}

function unavailableEvent(
  error: unknown,
  reason?: string,
): DeploymentLogStreamEvent {
  return {
    kind: 'status',
    source: 'unavailable',
    reason:
      reason ??
      (error instanceof Error
        ? error.message
        : typeof error === 'string'
          ? error
          : undefined),
  };
}

/** Order-independent key so equal queries always coalesce. */
function stableKey(query: DeploymentLogsQuery): string {
  return JSON.stringify(
    Object.entries(query)
      .filter(([, value]) => value !== undefined)
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

/** Pollers must never be the thing keeping the process alive at shutdown. */
function unrefTimer(timer: ReturnType<typeof setInterval>): void {
  (timer as { unref?: () => void }).unref?.();
}
