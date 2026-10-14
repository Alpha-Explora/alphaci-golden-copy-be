import { Injectable } from '@nestjs/common';

import { DatabaseService } from '#kernel/db/database.service';
import type {
  QaAttachmentContentTypeName,
  QaAttachmentKind,
  QaAttachmentSource,
} from '../application/qa-runs/qa-runs.contracts';
import {
  acceptsFixProof,
  type QaFixProofItemState,
} from '../domain/qa-fix-proof.rules';
import { lockOpenRunForItemWrite } from './qa-runs.repository';

export interface QaRunItemAttachmentRow {
  id: string;
  run_id: string;
  run_item_id: string;
  kind: QaAttachmentKind;
  storage_path: string;
  content_type: QaAttachmentContentTypeName;
  byte_size: number;
  width: number;
  height: number;
  caption: string | null;
  source: QaAttachmentSource;
  test_title: string | null;
  created_by: string | null;
  created_by_login: string | null;
  created_at: string | Date;
}

export interface InsertQaAttachmentInput {
  id: string;
  runId: string;
  runItemId: string;
  kind: QaAttachmentKind;
  storagePath: string;
  contentType: QaAttachmentContentTypeName;
  byteSize: number;
  width: number;
  height: number;
  caption: string | null;
  source: QaAttachmentSource;
  createdBy: string;
  createdByLogin: string;
  /** At most this many attachments of the SAME kind per item, checked under the item lock. */
  maxPerKind: number;
}

/** The item already holds its maximum number of attachments of this kind. Raised inside the insert transaction. */
export class QaAttachmentLimitReachedError extends Error {
  constructor(
    public readonly max: number,
    public readonly kind: QaAttachmentKind,
  ) {
    super(`QA run item already holds ${max} ${kind} attachments`);
    this.name = 'QaAttachmentLimitReachedError';
  }
}

/** Proof of a fix was refused: the item is no longer (or not yet) in a state that accepts it. Raised inside the insert transaction. */
export class QaFixProofNotRequestedError extends Error {
  constructor(itemId: string) {
    super(`QA run item ${itemId} does not accept proof of a fix right now`);
    this.name = 'QaFixProofNotRequestedError';
  }
}

/** The run item vanished (its run was deleted) between the service's read and the write. */
export class QaAttachmentItemGoneError extends Error {
  constructor(itemId: string) {
    super(`QA run item ${itemId} no longer exists`);
    this.name = 'QaAttachmentItemGoneError';
  }
}

const COLUMNS = `id, run_id, run_item_id, kind, storage_path, content_type,
  byte_size, width, height, caption, source, test_title, created_by,
  created_by_login, created_at`;

/**
 * projects.qa_run_item_attachments. Writes follow the run-lock discipline of
 * item writes: run row FOR SHARE first (a sign-off holds it FOR UPDATE, so the
 * two serialize and a signed-off run accepts nothing), then the item row.
 */
@Injectable()
export class QaRunAttachmentsRepository {
  constructor(private readonly databaseService: DatabaseService) {}

  /**
   * Inserts one attachment. Throws QaRunNotOpenError when the run is signed off,
   * QaFixProofNotRequestedError when a `fix_proof` arrives for an item that is
   * not awaiting a fix, and QaAttachmentLimitReachedError when the item already
   * holds its maximum of this kind. The state check and the count are both taken
   * under a lock on the run item row, so a concurrent status change or a second
   * upload cannot slip past either.
   */
  async insert(
    input: InsertQaAttachmentInput,
  ): Promise<QaRunItemAttachmentRow> {
    return this.databaseService.withTransaction(async (client) => {
      await lockOpenRunForItemWrite(client, input.runId);
      const item = await client.query<QaFixProofItemState>(
        `SELECT status, fix_requested_at FROM projects.qa_run_items WHERE id = $1 AND run_id = $2 FOR UPDATE;`,
        [input.runItemId, input.runId],
      );
      const locked = item.rows[0];
      if (!locked) {
        throw new QaAttachmentItemGoneError(input.runItemId);
      }
      if (input.kind === 'fix_proof' && !acceptsFixProof(locked)) {
        throw new QaFixProofNotRequestedError(input.runItemId);
      }
      const counted = await client.query<{ count: string }>(
        `
          SELECT COUNT(*) AS count
          FROM projects.qa_run_item_attachments
          WHERE run_item_id = $1 AND kind = $2;
        `,
        [input.runItemId, input.kind],
      );
      if (Number(counted.rows[0]?.count ?? 0) >= input.maxPerKind) {
        throw new QaAttachmentLimitReachedError(input.maxPerKind, input.kind);
      }
      const result = await client.query<QaRunItemAttachmentRow>(
        `
          INSERT INTO projects.qa_run_item_attachments (
            id, run_id, run_item_id, kind, storage_path, content_type, byte_size,
            width, height, caption, source, created_by, created_by_login
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
          RETURNING ${COLUMNS};
        `,
        [
          input.id,
          input.runId,
          input.runItemId,
          input.kind,
          input.storagePath,
          input.contentType,
          input.byteSize,
          input.width,
          input.height,
          input.caption,
          input.source,
          input.createdBy,
          input.createdByLogin,
        ],
      );
      const row = result.rows[0];
      if (!row) {
        throw new Error('qa_run_item_attachments INSERT returned no row');
      }
      return row;
    });
  }

  /**
   * Deletes one attachment of the run under the run lock. Throws
   * QaRunNotOpenError when the run is signed off; returns the deleted row, or
   * null when it was already gone.
   */
  async deleteById(
    runId: string,
    attachmentId: string,
  ): Promise<QaRunItemAttachmentRow | null> {
    return this.databaseService.withTransaction(async (client) => {
      await lockOpenRunForItemWrite(client, runId);
      const result = await client.query<QaRunItemAttachmentRow>(
        `
          DELETE FROM projects.qa_run_item_attachments
          WHERE id = $1 AND run_id = $2
          RETURNING ${COLUMNS};
        `,
        [attachmentId, runId],
      );
      return result.rows[0] ?? null;
    });
  }

  async findForRun(
    runId: string,
    attachmentId: string,
  ): Promise<QaRunItemAttachmentRow | null> {
    const result = await this.databaseService.query<QaRunItemAttachmentRow>(
      `SELECT ${COLUMNS} FROM projects.qa_run_item_attachments WHERE id = $1 AND run_id = $2;`,
      [attachmentId, runId],
    );
    return result.rows[0] ?? null;
  }

  /** Newest first. */
  async listByItem(
    runId: string,
    runItemId: string,
  ): Promise<QaRunItemAttachmentRow[]> {
    const result = await this.databaseService.query<QaRunItemAttachmentRow>(
      `
        SELECT ${COLUMNS}
        FROM projects.qa_run_item_attachments
        WHERE run_id = $1 AND run_item_id = $2
        ORDER BY created_at DESC, id DESC;
      `,
      [runId, runItemId],
    );
    return result.rows;
  }

  /** Newest first, every item of the run. */
  async listByRun(runId: string): Promise<QaRunItemAttachmentRow[]> {
    const result = await this.databaseService.query<QaRunItemAttachmentRow>(
      `
        SELECT ${COLUMNS}
        FROM projects.qa_run_item_attachments
        WHERE run_id = $1
        ORDER BY created_at DESC, id DESC;
      `,
      [runId],
    );
    return result.rows;
  }

  /** run item id -> number of `fix_proof` attachments (items with none are absent), for the run payload. */
  async fixProofCountsByItem(runId: string): Promise<Map<string, number>> {
    const result = await this.databaseService.query<{
      run_item_id: string;
      count: string;
    }>(
      `
        SELECT run_item_id, COUNT(*) AS count
        FROM projects.qa_run_item_attachments
        WHERE run_id = $1 AND kind = 'fix_proof'
        GROUP BY run_item_id;
      `,
      [runId],
    );
    return new Map(
      result.rows.map((row) => [row.run_item_id, Number(row.count)]),
    );
  }

  /** How many `fix_proof` attachments the given run items hold in all, for the Ready for QA notification. */
  async countFixProofs(runItemIds: readonly string[]): Promise<number> {
    if (runItemIds.length === 0) {
      return 0;
    }
    const result = await this.databaseService.query<{ count: string }>(
      `
        SELECT COUNT(*) AS count
        FROM projects.qa_run_item_attachments
        WHERE kind = 'fix_proof' AND run_item_id = ANY($1::uuid[]);
      `,
      [runItemIds],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  /** run item id -> number of attachments, for the run payload. */
  async countsByItem(runId: string): Promise<Map<string, number>> {
    const result = await this.databaseService.query<{
      run_item_id: string;
      count: string;
    }>(
      `
        SELECT run_item_id, COUNT(*) AS count
        FROM projects.qa_run_item_attachments
        WHERE run_id = $1
        GROUP BY run_item_id;
      `,
      [runId],
    );
    return new Map(
      result.rows.map((row) => [row.run_item_id, Number(row.count)]),
    );
  }
}
