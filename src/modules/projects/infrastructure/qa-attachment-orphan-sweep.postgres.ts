import { Injectable } from '@nestjs/common';

import { DatabaseService } from '#kernel/db/database.service.js';

/**
 * How old an object must be before it can count as orphaned. An upload writes
 * the bytes first and the metadata row second, so a fresh object with no row
 * yet is normal. One hour covers that gap and a slow or retried request.
 */
export const QA_ORPHAN_GRACE_SECONDS = 60 * 60;

/** Objects deleted per pass, so one pass holds its transaction briefly. */
export const QA_ORPHAN_SWEEP_BATCH_SIZE = 500;

/** Transaction-scoped advisory lock: one replica sweeps at a time, and a crash releases it. */
const SWEEP_LOCK_KEY = 'projects.qa_attachment_objects.orphan_sweep';

/**
 * Deletes screenshot bytes that no attachment row references, for deployments
 * on STORAGE_DRIVER=postgres. A run or project delete cascades the metadata
 * rows but not these bytes (see the note in the table's migration).
 *
 * Each pass is one transaction that takes the sweep lock first, so two api
 * replicas never sweep together. The lock is taken with try-semantics: a
 * replica that finds it held gets null back and does nothing, rather than
 * queueing behind the other.
 */
@Injectable()
export class PostgresQaAttachmentOrphanSweep {
  constructor(private readonly database: DatabaseService) {}

  /**
   * One batch of orphans, oldest first. Returns the number deleted, or null
   * when another replica holds the sweep lock.
   */
  async sweepOnce(
    batchSize: number = QA_ORPHAN_SWEEP_BATCH_SIZE,
    graceSeconds: number = QA_ORPHAN_GRACE_SECONDS,
  ): Promise<number | null> {
    return this.database.withTransaction(async (client) => {
      const lock = await client.query<{ acquired: boolean }>(
        'SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS acquired',
        [SWEEP_LOCK_KEY],
      );
      if (lock.rows[0]?.acquired !== true) {
        return null;
      }

      // The anti-join probes the UNIQUE index on
      // qa_run_item_attachments.storage_path; the age filter and ORDER BY use
      // idx_qa_attachment_objects_created_at, so a pass stops at its batch.
      const result = await client.query(
        `DELETE FROM projects.qa_attachment_objects AS objects
         WHERE objects.storage_path IN (
           SELECT candidate.storage_path
           FROM projects.qa_attachment_objects AS candidate
           WHERE candidate.created_at < NOW() - ($1::int * INTERVAL '1 second')
             AND NOT EXISTS (
               SELECT 1
               FROM projects.qa_run_item_attachments AS attachment
               WHERE attachment.storage_path = candidate.storage_path
             )
           ORDER BY candidate.created_at, candidate.storage_path
           LIMIT $2::int
         )`,
        [graceSeconds, batchSize],
      );
      return result.rowCount ?? 0;
    });
  }
}
