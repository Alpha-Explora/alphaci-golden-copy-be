import { Inject, Injectable, Optional } from '@nestjs/common';

import { DatabaseService } from '#kernel/db/database.service';
import {
  TENANT_CONTEXT,
  type TenantContextPort,
} from '#kernel/tenancy/tenant-context.port.js';
import { TenantContextRequiredError } from '#kernel/tenancy/tenant-context.js';

export type WorkflowUpdateRequestStatus = 'created' | 'failed';

export interface CreateWorkflowUpdateRequestInput {
  projectId: string;
  requestedBy: string | null;
  branchName: string;
  baseBranch: string;
  pullRequestNumber: number;
  pullRequestUrl: string;
  status: WorkflowUpdateRequestStatus;
  settings: Record<string, unknown>;
  workflowFiles: Array<Record<string, unknown>>;
}

export interface WorkflowUpdateRequestRecord {
  id: string;
  projectId: string;
  requestedBy: string | null;
  branchName: string;
  baseBranch: string;
  pullRequestNumber: number;
  pullRequestUrl: string;
  status: WorkflowUpdateRequestStatus;
  settings: Record<string, unknown>;
  workflowFiles: Array<Record<string, unknown>>;
  createdAt: string;
  updatedAt: string;
}

interface WorkflowUpdateRequestRow {
  id: string;
  project_id: string;
  requested_by: string | null;
  branch_name: string;
  base_branch: string;
  pull_request_number: number;
  pull_request_url: string;
  status: WorkflowUpdateRequestStatus;
  settings_json: Record<string, unknown> | string;
  workflow_files_json: Array<Record<string, unknown>> | string;
  created_at: string;
  updated_at: string;
}

@Injectable()
export class ProjectWorkflowUpdateRequestsRepository {
  constructor(
    private readonly databaseService: DatabaseService,
    @Optional()
    @Inject(TENANT_CONTEXT)
    private readonly tenantContext?: TenantContextPort,
  ) {}

  async createRequest(
    input: CreateWorkflowUpdateRequestInput,
  ): Promise<WorkflowUpdateRequestRecord> {
    const tenantId = this.requireTenantId();
    const result = await this.databaseService.query<WorkflowUpdateRequestRow>(
      `
        INSERT INTO projects.project_workflow_update_requests (
          project_id,
          requested_by,
          branch_name,
          base_branch,
          pull_request_number,
          pull_request_url,
          status,
          settings_json,
          workflow_files_json
        )
        SELECT
          $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb
        FROM projects.provisioned_projects AS project
        WHERE project.id = $1
          AND project.tenant_id = $10::uuid
        RETURNING *;
      `,
      [
        input.projectId,
        input.requestedBy,
        input.branchName,
        input.baseBranch,
        input.pullRequestNumber,
        input.pullRequestUrl,
        input.status,
        JSON.stringify(input.settings),
        JSON.stringify(input.workflowFiles),
        tenantId,
      ],
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error(
        'projects.project_workflow_update_requests INSERT returned no row',
      );
    }

    return this.toRecord(row);
  }

  private toRecord(row: WorkflowUpdateRequestRow): WorkflowUpdateRequestRecord {
    return {
      id: row.id,
      projectId: row.project_id,
      requestedBy: row.requested_by,
      branchName: row.branch_name,
      baseBranch: row.base_branch,
      pullRequestNumber: row.pull_request_number,
      pullRequestUrl: row.pull_request_url,
      status: row.status,
      settings:
        typeof row.settings_json === 'string'
          ? (JSON.parse(row.settings_json) as Record<string, unknown>)
          : row.settings_json,
      workflowFiles:
        typeof row.workflow_files_json === 'string'
          ? (JSON.parse(row.workflow_files_json) as Array<
              Record<string, unknown>
            >)
          : row.workflow_files_json,
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
