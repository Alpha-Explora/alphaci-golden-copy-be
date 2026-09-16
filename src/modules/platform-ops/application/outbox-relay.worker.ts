import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';

import { DatabaseService } from '#kernel/db/database.service';
import { OutboxRelayService } from './outbox-relay.service';

/** How often to deliver when OUTBOX_RELAY_INTERVAL_MS is not set. */
export const DEFAULT_OUTBOX_RELAY_INTERVAL_MS = 15_000;

/**
 * Delivers audit and notification events on a timer.
 *
 * Producers stopped writing those rows directly when events moved behind the
 * outbox, and nothing in the running service ever read the outbox back. The
 * relay existed, but only a manual script called it, and nothing ran the
 * script. For about four weeks every audit event and every notification the
 * product raised went into platform.outbox_events as `pending` and stayed there:
 * 54 of them at the time this was written, the newest being two GitHub
 * repository deletions GitHub had refused. The user was never told, and the
 * audit table's newest row was three weeks old.
 *
 * Runs only the platform topics. Hierarchy grant/revoke also live in the
 * outbox, but their handlers change GitHub team membership, so they stay behind
 * the explicit manual path rather than firing every fifteen seconds.
 *
 * Safe with several instances running: rows are claimed one at a time under a
 * lease with SKIP LOCKED, so two relays cannot deliver the same event.
 *
 * On by default, because this is plumbing the product depends on rather than an
 * optional feature. OUTBOX_RELAY_INTERVAL_MS=0 turns it off.
 */
@Injectable()
export class OutboxRelayWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxRelayWorker.name);
  private intervalHandle: ReturnType<typeof setInterval> | undefined;
  /** Guards against a slow pass overlapping the next tick. */
  private running = false;

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly relay: OutboxRelayService,
  ) {}

  onModuleInit(): void {
    const intervalMs = resolveOutboxRelayIntervalMs(
      process.env['OUTBOX_RELAY_INTERVAL_MS'],
    );

    if (intervalMs === 0 || !this.databaseService.isEnabled()) {
      return;
    }

    this.logger.log(
      `Delivering audit and notification events every ${String(intervalMs)}ms.`,
    );

    // Caught at the scheduling boundary: a connect-level database failure
    // rejects the promise before any handler runs, and an unawaited rejection
    // exits the process under Node's default policy - turning a transient
    // outage into a restart loop.
    this.intervalHandle = setInterval(() => {
      this.deliver().catch((error: unknown) => {
        this.logger.error(
          `Outbox delivery pass failed: ${
            error instanceof Error ? error.message : JSON.stringify(error)
          }`,
        );
      });
    }, intervalMs);

    // A delivery timer must never be what keeps the process alive.
    this.intervalHandle.unref();
  }

  onModuleDestroy(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = undefined;
    }
  }

  /** One delivery pass. Exposed so tests and a manual trigger can run it. */
  async deliver(): Promise<number> {
    if (this.running) {
      return 0;
    }

    this.running = true;
    try {
      const delivered = await this.relay.processPlatformEventsOnce();
      if (delivered > 0) {
        this.logger.log(`Delivered ${String(delivered)} outbox event(s).`);
      }
      return delivered;
    } finally {
      this.running = false;
    }
  }
}

/**
 * The delivery interval, with 0 meaning "off".
 *
 * Unset, blank or unreadable falls back to the default rather than disabling:
 * a typo in an environment variable should not quietly switch off audit logs
 * and notifications, which is the failure this worker exists to end.
 */
export function resolveOutboxRelayIntervalMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_OUTBOX_RELAY_INTERVAL_MS;
  }

  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    return DEFAULT_OUTBOX_RELAY_INTERVAL_MS;
  }

  return Math.floor(value);
}
