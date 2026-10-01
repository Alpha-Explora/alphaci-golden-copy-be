import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';

import { DatabaseService } from '#kernel/db/database.service';
import type { QaChecklistVerificationType } from '../application/qa-checklists/qa-checklists.contracts';
import type {
  QaProgress,
  QaRequirementKind,
  RequirementItemInput,
} from '../application/qa-checklists/qa-requirements.contracts';
import type {
  QaChecklistItemRow,
  QaChecklistRow,
} from './qa-checklists.repository';

/** Patch for one requirement item's definition. `undefined` = leave unchanged; `null` clears a nullable field. */
export interface UpdateRequirementItemPatch {
  title?: string;
  acceptanceCriteria?: string | null;
  verificationType?: QaChecklistVerificationType;
  testIdentifier?: string | null;
}

export interface RequirementProgressActor {
  id: string;
  login: string;
}

/**
 * Item-level and Project-scope persistence for requirements. The checklist
 * rows themselves (create, meta update, archive, listing) live in
 * QaChecklistsRepository, which this sits beside: same tables, but this class
 * owns everything that must NOT delete-and-reinsert items, because Progress
 * lives on the item row and has to survive edits.
 *
 * Every definition change (add, edit, delete, reorder) touches the owning
 * checklist's updated_at; that is what "requirements changed since sign-off"
 * is computed from. A Progress write deliberately does not.
 */
@Injectable()
export class QaRequirementsRepository {
  constructor(private readonly databaseService: DatabaseService) {}

  async findItem(
    checklistId: string,
    itemId: string,
  ): Promise<QaChecklistItemRow | null> {
    const result = await this.databaseService.query<QaChecklistItemRow>(
      `SELECT * FROM projects.qa_checklist_items WHERE id = $1 AND checklist_id = $2;`,
      [itemId, checklistId],
    );
    return result.rows[0] ?? null;
  }

  /** Appends one item after the current last position and touches the requirement. */
  async appendItem(
    checklistId: string,
    input: RequirementItemInput,
  ): Promise<QaChecklistItemRow> {
    return this.databaseService.withTransaction(async (client) => {
      const result = await client.query<QaChecklistItemRow>(
        `
          INSERT INTO projects.qa_checklist_items (
            checklist_id, "position", title, target_persona, verification_type,
            test_identifier, acceptance_criteria
          )
          SELECT $1, COALESCE(MAX("position") + 1, 0), $2, 'all', $3, $4, $5
          FROM projects.qa_checklist_items
          WHERE checklist_id = $1
          RETURNING *;
        `,
        [
          checklistId,
          input.title,
          input.verificationType ?? 'manual',
          input.testIdentifier ?? null,
          input.acceptanceCriteria ?? null,
        ],
      );
      const row = result.rows[0];
      if (!row) {
        throw new Error('projects.qa_checklist_items INSERT returned no row');
      }
      await this.touchChecklist(client, checklistId);
      return row;
    });
  }

  /**
   * Edits an item's definition in place (never delete-and-reinsert, so
   * Progress survives). Null = the row_version had moved or the item is gone.
   */
  async updateItemDefinition(
    checklistId: string,
    itemId: string,
    expectedRowVersion: number,
    patch: UpdateRequirementItemPatch,
  ): Promise<QaChecklistItemRow | null> {
    return this.databaseService.withTransaction(async (client) => {
      const result = await client.query<QaChecklistItemRow>(
        `
          UPDATE projects.qa_checklist_items
          SET
            title = COALESCE($4, title),
            acceptance_criteria = CASE WHEN $5::boolean THEN $6 ELSE acceptance_criteria END,
            verification_type = COALESCE($7, verification_type),
            test_identifier = CASE WHEN $8::boolean THEN $9 ELSE test_identifier END,
            row_version = row_version + 1,
            updated_at = NOW()
          WHERE id = $1 AND checklist_id = $2 AND row_version = $3
          RETURNING *;
        `,
        [
          itemId,
          checklistId,
          expectedRowVersion,
          patch.title ?? null,
          patch.acceptanceCriteria !== undefined,
          patch.acceptanceCriteria ?? null,
          patch.verificationType ?? null,
          patch.testIdentifier !== undefined,
          patch.testIdentifier ?? null,
        ],
      );
      const row = result.rows[0];
      if (!row) {
        return null;
      }
      await this.touchChecklist(client, checklistId);
      return row;
    });
  }

  /**
   * Deletes one item. Open run items keep their snapshot: qa_run_items.
   * source_item_id is ON DELETE SET NULL. Returns false when it was not there.
   */
  async deleteItem(checklistId: string, itemId: string): Promise<boolean> {
    return this.databaseService.withTransaction(async (client) => {
      const result = await client.query(
        `DELETE FROM projects.qa_checklist_items WHERE id = $1 AND checklist_id = $2;`,
        [itemId, checklistId],
      );
      if ((result.rowCount ?? 0) === 0) {
        return false;
      }
      await this.touchChecklist(client, checklistId);
      return true;
    });
  }

  /**
   * Rewrites positions 0..n-1 in the given order, in one transaction (the
   * unique (checklist_id, position) constraint is deferrable). Returns false,
   * writing nothing, unless `itemIds` is exactly the requirement's current set
   * of items.
   */
  async reorderItems(checklistId: string, itemIds: string[]): Promise<boolean> {
    return this.databaseService.withTransaction(async (client) => {
      const current = await client.query<{ id: string }>(
        `SELECT id FROM projects.qa_checklist_items WHERE checklist_id = $1 FOR UPDATE;`,
        [checklistId],
      );
      const currentIds = new Set(current.rows.map((row) => row.id));
      if (
        itemIds.length !== currentIds.size ||
        new Set(itemIds).size !== itemIds.length ||
        !itemIds.every((id) => currentIds.has(id))
      ) {
        return false;
      }
      for (const [position, id] of itemIds.entries()) {
        await client.query(
          `UPDATE projects.qa_checklist_items SET "position" = $3 WHERE id = $1 AND checklist_id = $2;`,
          [id, checklistId, position],
        );
      }
      await this.touchChecklist(client, checklistId);
      return true;
    });
  }

  /**
   * Conditional UPDATE on (id, checklist_id, row_version): null = the version
   * had moved or the item is gone. Touches only the item, never the
   * checklist - Progress is not a requirements change.
   */
  async setProgress(
    checklistId: string,
    itemId: string,
    expectedRowVersion: number,
    progress: QaProgress,
    actor: RequirementProgressActor,
  ): Promise<QaChecklistItemRow | null> {
    const result = await this.databaseService.query<QaChecklistItemRow>(
      `
        UPDATE projects.qa_checklist_items
        SET
          progress = $4,
          progress_by = $5,
          progress_by_login = $6,
          progress_at = NOW(),
          row_version = row_version + 1,
          updated_at = NOW()
        WHERE id = $1 AND checklist_id = $2 AND row_version = $3
        RETURNING *;
      `,
      [
        itemId,
        checklistId,
        expectedRowVersion,
        progress,
        actor.id,
        actor.login,
      ],
    );
    return result.rows[0] ?? null;
  }

  /** The item rows (current Progress) behind a set of ids; used to decorate run items. */
  async listItemsByIds(
    ids: string[],
  ): Promise<Map<string, QaChecklistItemRow>> {
    const map = new Map<string, QaChecklistItemRow>();
    if (ids.length === 0) {
      return map;
    }
    const result = await this.databaseService.query<QaChecklistItemRow>(
      `SELECT * FROM projects.qa_checklist_items WHERE id = ANY($1::uuid[]);`,
      [ids],
    );
    for (const row of result.rows) {
      map.set(row.id, row);
    }
    return map;
  }

  /**
   * True when any requirement of the Project was created, edited, archived,
   * had an item added/edited/deleted, or was reordered after `since`.
   * Progress writes touch only items, so they never count.
   */
  async requirementsChangedSince(
    deliveryProjectId: string,
    since: string,
  ): Promise<boolean> {
    const result = await this.databaseService.query<{ changed: boolean }>(
      `
        SELECT EXISTS (
          SELECT 1 FROM projects.qa_checklists
          WHERE delivery_project_id = $1 AND updated_at > $2::timestamptz
        ) AS changed;
      `,
      [deliveryProjectId, since],
    );
    return result.rows[0]?.changed ?? false;
  }

  /** Active requirement rows of a Project, with their kind, for run snapshots and the gate. */
  async listActiveByDeliveryProject(
    deliveryProjectId: string,
  ): Promise<QaChecklistRow[]> {
    const result = await this.databaseService.query<QaChecklistRow>(
      `
        SELECT * FROM projects.qa_checklists
        WHERE delivery_project_id = $1 AND archived_at IS NULL
        ORDER BY (kind = 'functional') DESC, created_at, id;
      `,
      [deliveryProjectId],
    );
    return result.rows;
  }

  /** Active requirements per Project for a workspace (the team-level overview). */
  async listByWorkspace(
    workspaceId: string,
    includeArchived: boolean,
  ): Promise<QaChecklistRow[]> {
    const result = await this.databaseService.query<QaChecklistRow>(
      `
        SELECT * FROM projects.qa_checklists
        WHERE workspace_id = $1 AND ($2::boolean OR archived_at IS NULL)
        ORDER BY (kind = 'functional') DESC, created_at, id;
      `,
      [workspaceId, includeArchived],
    );
    return result.rows;
  }

  async countActiveByDeliveryProject(
    deliveryProjectId: string,
    kind?: QaRequirementKind,
  ): Promise<number> {
    const result = await this.databaseService.query<{ n: string }>(
      `
        SELECT COUNT(*) AS n FROM projects.qa_checklists
        WHERE delivery_project_id = $1 AND archived_at IS NULL
          AND ($2::text IS NULL OR kind = $2);
      `,
      [deliveryProjectId, kind ?? null],
    );
    return Number(result.rows[0]?.n ?? 0);
  }

  private async touchChecklist(
    client: Pick<PoolClient, 'query'>,
    checklistId: string,
  ): Promise<void> {
    await client.query(
      `UPDATE projects.qa_checklists SET updated_at = NOW() WHERE id = $1;`,
      [checklistId],
    );
  }
}
