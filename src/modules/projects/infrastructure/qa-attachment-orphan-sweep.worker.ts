import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '#kernel/config/app.config.js';
import { DatabaseService } from '#kernel/db/database.service.js';
import {
  PostgresQaAttachmentOrphanSweep,
  QA_ORPHAN_SWEEP_BATCH_SIZE,
} from './qa-attachment-orphan-sweep.postgres';

/** How often the sweep runs. Orphans are unreachable, so minutes of delay cost nothing. */
export const QA_ORPHAN_SWEEP_INTERVAL_MS = 15 * 60 * 1000;

/** Batches one tick may run, so a large backlog drains without holding the lock for long. */
export const QA_ORPHAN_SWEEP_MAX_PASSES_PER_TICK = 10;

/**
 * Runs the orphaned-bytes sweep on a timer, the same way the outbox relay and
 * the GitHub team-role reconciler do: an in-process interval, no broker.
 *
 * Inert unless STORAGE_DRIVER=postgres and a database is configured. On SaaS
 * the bytes live in Supabase Storage and this table is never written, so there
 * is nothing to sweep. With several api replicas, every pass takes the
 * advisory lock in PostgresQaAttachmentOrphanSweep, so only one of them deletes
 * at a time.
 */
@Injectable()
export class QaAttachmentOrphanSweepWorker
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(QaAttachmentOrphanSweepWorker.name);
  private intervalHandle: ReturnType<typeof setInterval> | undefined;
  /** Guards against a slow tick overlapping the next one. */
  private running = false;

  constructor(
    private readonly configService: ConfigService,
    private readonly databaseService: DatabaseService,
    private readonly sweep: PostgresQaAttachmentOrphanSweep,
  ) {}

  onModuleInit(): void {
    const config = this.configService.getOrThrow<AppConfig>('app');
    if (
      config.storage.driver !== 'postgres' ||
      !this.databaseService.isEnabled()
    ) {
      return;
    }

    this.logger.log(
      `Sweeping orphaned QA screenshot bytes every ${String(QA_ORPHAN_SWEEP_INTERVAL_MS)}ms.`,
    );

    // Caught at the scheduling boundary: an unawaited rejection exits the
    // process under Node's default policy, which would turn a transient
    // database outage into a restart loop.
    this.intervalHandle = setInterval(() => {
      this.sweepOrphans().catch((error: unknown) => {
        this.logger.error(
          `Orphaned QA bytes sweep failed: ${
            error instanceof Error ? error.message : JSON.stringify(error)
          }`,
        );
      });
    }, QA_ORPHAN_SWEEP_INTERVAL_MS);

    // A maintenance timer must never be what keeps the process alive.
    this.intervalHandle.unref();
  }

  onModuleDestroy(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = undefined;
    }
  }

  /**
   * One tick: batches until a batch comes back short, the cap is reached, or
   * another replica holds the lock. Returns the rows deleted this tick.
   * Exposed so tests and a manual trigger can run it.
   */
  async sweepOrphans(): Promise<number> {
    if (this.running) {
      return 0;
    }

    this.running = true;
    try {
      let total = 0;
      for (
        let pass = 0;
        pass < QA_ORPHAN_SWEEP_MAX_PASSES_PER_TICK;
        pass += 1
      ) {
        const deleted = await this.sweep.sweepOnce(QA_ORPHAN_SWEEP_BATCH_SIZE);
        if (deleted === null) {
          this.logger.debug('Another replica holds the orphan sweep lock.');
          break;
        }
        total += deleted;
        if (deleted < QA_ORPHAN_SWEEP_BATCH_SIZE) {
          break;
        }
      }
      if (total > 0) {
        this.logger.log(
          `Deleted ${String(total)} orphaned QA screenshot object(s).`,
        );
      }
      return total;
    } finally {
      this.running = false;
    }
  }
}
