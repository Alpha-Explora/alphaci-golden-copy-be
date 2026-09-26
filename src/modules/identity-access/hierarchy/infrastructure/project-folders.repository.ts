import { Injectable } from '@nestjs/common';

import { DatabaseService } from '#kernel/db/database.service';
import type { RepositoryStatus } from '../domain/hierarchy.types';

/**
 * One row per (delivery project, repository). A delivery project with no
 * repository yields one row with null repository columns.
 */
export interface ProjectFolderRow {
  delivery_project_id: string;
  system_id: string;
  name: string;
  created_at: string;
  repository_id: string | null;
  repository_name: string | null;
  repo_full_name: string | null;
  repository_status: RepositoryStatus | null;
  provisioned_project_id: string | null;
}

@Injectable()
export class ProjectFoldersRepository {
  constructor(private readonly databaseService: DatabaseService) {}

  /** Every unarchived project of a team with its unarchived repositories. */
  async listFolderRows(groupId: string): Promise<ProjectFolderRow[]> {
    const result = await this.databaseService.query<ProjectFolderRow>(
      `
        SELECT
          dp.id   AS delivery_project_id,
          dp.system_id,
          dp.name,
          dp.created_at,
          r.id    AS repository_id,
          r.name  AS repository_name,
          r.repo_full_name,
          r.status AS repository_status,
          r.provisioned_project_id
        FROM hierarchy.delivery_projects dp
        JOIN hierarchy.systems s ON s.id = dp.system_id
        LEFT JOIN hierarchy.repositories r
          ON r.delivery_project_id = dp.id
         AND r.status <> 'archived'
        WHERE dp.group_id = $1
          AND dp.status <> 'archived'
          AND s.status <> 'archived'
        ORDER BY lower(dp.name), dp.created_at, r.created_at;
      `,
      [groupId],
    );
    return result.rows;
  }

  /**
   * Project ids that already have a repository row in this team, archived or
   * not, so an archived repository's project does not resurface as unfiled.
   */
  async listLinkedProjectIds(groupId: string): Promise<Set<string>> {
    const result = await this.databaseService.query<{
      provisioned_project_id: string;
    }>(
      `
        SELECT provisioned_project_id
        FROM hierarchy.repositories
        WHERE group_id = $1 AND provisioned_project_id IS NOT NULL;
      `,
      [groupId],
    );
    return new Set(result.rows.map((row) => row.provisioned_project_id));
  }
}
