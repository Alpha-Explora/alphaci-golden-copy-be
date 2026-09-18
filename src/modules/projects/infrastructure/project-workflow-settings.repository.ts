import { Inject, Injectable, Optional } from '@nestjs/common';

import { DatabaseService } from '#kernel/db/database.service';
import {
  TENANT_CONTEXT,
  type TenantContextPort,
} from '#kernel/tenancy/tenant-context.port.js';
import { TenantContextRequiredError } from '#kernel/tenancy/tenant-context.js';

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
  constructor(
    private readonly databaseService: DatabaseService,
    @Optional()
    @Inject(TENANT_CONTEXT)
    private readonly tenantContext?: TenantContextPort,
  ) {}

  async findByProject(
    projectId: string,
  ): Promise<ProjectWorkflowSettingsRowValue | null> {
    const tenantId = this.requireTenantId();
    const result = await this.databaseService.query<ProjectWorkflowSettingsRow>(
      `
          SELECT
            settings.id,
            settings.project_id,
            settings.settings_json,
            settings.created_by,
            settings.updated_by,
            settings.created_at,
            settings.updated_at
          FROM projects.project_workflow_settings AS settings
          JOIN projects.provisioned_projects AS project
            ON project.id = settings.project_id
          WHERE settings.project_id = $1
            AND project.tenant_id = $2::uuid
          LIMIT 1;
        `,
      [projectId, tenantId],
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

  private requireTenantId(): string {
    if (!this.tenantContext) {
      throw new TenantContextRequiredError();
    }

    return this.tenantContext.require().tenantId;
  }
}
