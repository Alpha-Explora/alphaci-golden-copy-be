import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';

import { DatabaseService } from '#kernel/db/database.service';
import type {
  QaChecklistItemInput,
  QaChecklistTargetPersona,
  QaChecklistVerificationType,
} from '../application/qa-checklists/qa-checklists.contracts';

/** Postgres SQLSTATE for a unique-constraint violation (the active-name index). */
export const QA_UNIQUE_VIOLATION = '23505';

export interface QaChecklistRow {
  id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  version: number;
  archived_at: string | null;
  created_by: string;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface QaChecklistItemRow {
  id: string;
  checklist_id: string;
  position: number;
  title: string;
  description: string | null;
  target_persona: QaChecklistTargetPersona;
  verification_type: QaChecklistVerificationType;
  test_identifier: string | null;
}

export interface CreateQaChecklistInput {
  workspaceId: string;
  name: string;
  description: string | null;
  createdBy: string;
  items: QaChecklistItemInput[];
}

export interface UpdateQaChecklistMetaPatch {
  name?: string;
  /** `undefined` = leave unchanged; `null` = clear the description. */
  description?: string | null;
}

@Injectable()
export class QaChecklistsRepository {
  constructor(private readonly databaseService: DatabaseService) {}

  async createWithItems(
    input: CreateQaChecklistInput,
  ): Promise<{ checklist: QaChecklistRow; items: QaChecklistItemRow[] }> {
    return this.databaseService.withTransaction(async (client) => {
      const result = await client.query<QaChecklistRow>(
        `
          INSERT INTO projects.qa_checklists (workspace_id, name, description, created_by)
          VALUES ($1, $2, $3, $4)
          RETURNING *;
        `,
        [input.workspaceId, input.name, input.description, input.createdBy],
      );
      const checklist = result.rows[0];
      if (!checklist) {
        throw new Error('projects.qa_checklists INSERT returned no row');
      }

      const items = await this.insertItemsWithClient(
        client,
        checklist.id,
        input.items,
      );
      return { checklist, items };
    });
  }

  async findById(id: string): Promise<QaChecklistRow | null> {
    const result = await this.databaseService.query<QaChecklistRow>(
      `SELECT * FROM projects.qa_checklists WHERE id = $1;`,
      [id],
    );
    return result.rows[0] ?? null;
  }

  async listByWorkspace(
    workspaceId: string,
    includeArchived: boolean,
  ): Promise<QaChecklistRow[]> {
    const result = await this.databaseService.query<QaChecklistRow>(
      `
        SELECT * FROM projects.qa_checklists
        WHERE workspace_id = $1
          AND ($2::boolean OR archived_at IS NULL)
        ORDER BY created_at DESC;
      `,
      [workspaceId, includeArchived],
    );
    return result.rows;
  }

  /** Non-archived checklists shared to this project — the contract's stated scope. */
  async listByProject(projectId: string): Promise<QaChecklistRow[]> {
    const result = await this.databaseService.query<QaChecklistRow>(
      `
        SELECT c.*
        FROM projects.qa_checklists c
        JOIN projects.qa_checklist_projects s ON s.checklist_id = c.id
        WHERE s.project_id = $1
          AND c.archived_at IS NULL
        ORDER BY c.created_at DESC;
      `,
      [projectId],
    );
    return result.rows;
  }

  async listItemsByChecklistIds(
    checklistIds: string[],
  ): Promise<Map<string, QaChecklistItemRow[]>> {
    const map = new Map<string, QaChecklistItemRow[]>();
    if (checklistIds.length === 0) {
      return map;
    }

    const result = await this.databaseService.query<QaChecklistItemRow>(
      `
        SELECT * FROM projects.qa_checklist_items
        WHERE checklist_id = ANY($1::uuid[])
        ORDER BY checklist_id, "position";
      `,
      [checklistIds],
    );
    for (const row of result.rows) {
      const list = map.get(row.checklist_id) ?? [];
      list.push(row);
      map.set(row.checklist_id, list);
    }
    return map;
  }

  async listSharedProjectIdsByChecklistIds(
    checklistIds: string[],
  ): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>();
    if (checklistIds.length === 0) {
      return map;
    }

    const result = await this.databaseService.query<{
      checklist_id: string;
      project_id: string;
    }>(
      `
        SELECT checklist_id, project_id
        FROM projects.qa_checklist_projects
        WHERE checklist_id = ANY($1::uuid[]);
      `,
      [checklistIds],
    );
    for (const row of result.rows) {
      const list = map.get(row.checklist_id) ?? [];
      list.push(row.project_id);
      map.set(row.checklist_id, list);
    }
    return map;
  }

  /** Case-insensitive, active-only (archived_at IS NULL) name collision check. */
  async hasActiveNameConflict(
    workspaceId: string,
    name: string,
    excludeId?: string,
  ): Promise<boolean> {
    const result = await this.databaseService.query<{ exists: boolean }>(
      `
        SELECT EXISTS (
          SELECT 1 FROM projects.qa_checklists
          WHERE workspace_id = $1
            AND lower(name) = lower($2)
            AND archived_at IS NULL
            AND ($3::uuid IS NULL OR id <> $3)
        ) AS exists;
      `,
      [workspaceId, name, excludeId ?? null],
    );
    return result.rows[0]?.exists ?? false;
  }

  /**
   * Race-safe conditional update: 0 rows back means either the version had
   * already moved or the checklist is archived — the caller (which has
   * already read the row once) can tell which by re-checking, or just report
   * a 409 either way.
   */
  async updateMeta(
    id: string,
    expectedVersion: number,
    patch: UpdateQaChecklistMetaPatch,
    updatedBy: string,
  ): Promise<QaChecklistRow | null> {
    const result = await this.databaseService.query<QaChecklistRow>(
      `
        UPDATE projects.qa_checklists
        SET
          name = COALESCE($3, name),
          description = CASE WHEN $4::boolean THEN $5 ELSE description END,
          version = version + 1,
          updated_by = $6,
          updated_at = NOW()
        WHERE id = $1
          AND version = $2
          AND archived_at IS NULL
        RETURNING *;
      `,
      [
        id,
        expectedVersion,
        patch.name ?? null,
        patch.description !== undefined,
        patch.description ?? null,
        updatedBy,
      ],
    );
    return result.rows[0] ?? null;
  }

  /**
   * Bumps the version, then replaces the whole item list in the same
   * transaction. Returns null on the same race/archived conditions as
   * updateMeta.
   */
  async replaceItems(
    id: string,
    expectedVersion: number,
    items: QaChecklistItemInput[],
    updatedBy: string,
  ): Promise<{
    checklist: QaChecklistRow;
    items: QaChecklistItemRow[];
  } | null> {
    return this.databaseService.withTransaction(async (client) => {
      const bumped = await client.query<QaChecklistRow>(
        `
          UPDATE projects.qa_checklists
          SET version = version + 1, updated_by = $3, updated_at = NOW()
          WHERE id = $1 AND version = $2 AND archived_at IS NULL
          RETURNING *;
        `,
        [id, expectedVersion, updatedBy],
      );
      const checklist = bumped.rows[0];
      if (!checklist) {
        return null;
      }

      await client.query(
        `DELETE FROM projects.qa_checklist_items WHERE checklist_id = $1;`,
        [id],
      );
      const insertedItems = await this.insertItemsWithClient(client, id, items);
      return { checklist, items: insertedItems };
    });
  }

  /** Idempotent: archiving an already-archived checklist keeps its original archived_at. */
  async archive(id: string, updatedBy: string): Promise<QaChecklistRow | null> {
    const result = await this.databaseService.query<QaChecklistRow>(
      `
        UPDATE projects.qa_checklists
        SET archived_at = COALESCE(archived_at, NOW()), updated_by = $2, updated_at = NOW()
        WHERE id = $1
        RETURNING *;
      `,
      [id, updatedBy],
    );
    return result.rows[0] ?? null;
  }

  /** Pre-flight check: which of these ids actually belong to this workspace. */
  async validWorkspaceProjectIds(
    workspaceId: string,
    projectIds: string[],
  ): Promise<string[]> {
    if (projectIds.length === 0) {
      return [];
    }
    const result = await this.databaseService.query<{ id: string }>(
      `
        SELECT id FROM projects.provisioned_projects
        WHERE workspace_id = $1 AND id = ANY($2::uuid[]);
      `,
      [workspaceId, projectIds],
    );
    return result.rows.map((row) => row.id);
  }

  /**
   * Replaces the full share set. The INSERT...SELECT joins back to
   * qa_checklists and only matches provisioned_projects rows whose
   * workspace_id equals the checklist's — cross-workspace sharing cannot
   * happen here even if a caller's pre-validation was bypassed or raced.
   * This is defense in depth: QaChecklistsService.setSharedProjects()
   * validates the requested ids against the workspace first and rejects
   * (400) before ever calling this.
   */
  async replaceSharedProjects(
    checklistId: string,
    projectIds: string[],
    sharedBy: string,
  ): Promise<string[]> {
    return this.databaseService.withTransaction(async (client) => {
      await client.query(
        `DELETE FROM projects.qa_checklist_projects WHERE checklist_id = $1;`,
        [checklistId],
      );

      if (projectIds.length === 0) {
        return [];
      }

      const result = await client.query<{ project_id: string }>(
        `
          INSERT INTO projects.qa_checklist_projects (checklist_id, project_id, shared_by)
          SELECT c.id, pp.id, $3
          FROM projects.qa_checklists c
          JOIN projects.provisioned_projects pp
            ON pp.id = ANY($2::uuid[])
           AND pp.workspace_id = c.workspace_id
          WHERE c.id = $1
          RETURNING project_id;
        `,
        [checklistId, projectIds, sharedBy],
      );
      return result.rows.map((row) => row.project_id);
    });
  }

  private async insertItemsWithClient(
    client: Pick<PoolClient, 'query'>,
    checklistId: string,
    items: QaChecklistItemInput[],
  ): Promise<QaChecklistItemRow[]> {
    if (items.length === 0) {
      return [];
    }

    const values: unknown[] = [checklistId];
    const rowsSql = items
      .map((item, index) => {
        const base = values.length;
        values.push(
          index,
          item.title,
          item.description ?? null,
          item.targetPersona,
          item.verificationType,
          item.testIdentifier ?? null,
        );
        return `($1, $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`;
      })
      .join(',\n');

    const result = await client.query<QaChecklistItemRow>(
      `
        INSERT INTO projects.qa_checklist_items (
          checklist_id, "position", title, description, target_persona, verification_type, test_identifier
        )
        VALUES ${rowsSql}
        RETURNING *;
      `,
      values,
    );
    return result.rows.sort((a, b) => a.position - b.position);
  }
}
