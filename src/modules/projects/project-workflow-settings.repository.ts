import { Injectable } from '@nestjs/common';

import { DatabaseService } from '../../kernel/db/database.service';

export interface ProjectWorkflowSettingsRowValue {
  id: string;
  projectId: string;
  settings: Record<string, unknown>;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ProjectWorkflowSettingsRow {
  id: string;
  project_id: string;
  settings_json: Record<string, unknown> | string;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

@Injectable()
export class ProjectWorkflowSettingsRepository {
  constructor(private readonly databaseService: DatabaseService) {}

  async findByProject(
    projectId: string,
  ): Promise<ProjectWorkflowSettingsRowValue | null> {
    const result = await this.databaseService.query<ProjectWorkflowSettingsRow>(
      `
          SELECT
            id,
            project_id,
            settings_json,
            created_by,
            updated_by,
            created_at,
            updated_at
          FROM projects.project_workflow_settings
          WHERE project_id = $1
          LIMIT 1;
        `,
      [projectId],
    );

    const row = result.rows[0];
    return row ? this.toValue(row) : null;
  }

  private toValue(
    row: ProjectWorkflowSettingsRow,
  ): ProjectWorkflowSettingsRowValue {
    return {
      id: row.id,
      projectId: row.project_id,
      settings:
        typeof row.settings_json === 'string'
          ? (JSON.parse(row.settings_json) as Record<string, unknown>)
          : row.settings_json,
      createdBy: row.created_by,
      updatedBy: row.updated_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
