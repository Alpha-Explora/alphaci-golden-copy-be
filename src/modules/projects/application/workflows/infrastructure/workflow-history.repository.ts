import { Inject, Injectable, Optional } from '@nestjs/common';

import { DatabaseService } from '#kernel/db/database.service';
import {
  TENANT_CONTEXT,
  type TenantContextPort,
} from '#kernel/tenancy/tenant-context.port.js';
import { TenantContextRequiredError } from '#kernel/tenancy/tenant-context.js';

export interface WorkflowHistoryEntry {
  id: string;
  createdAt: string;
  templateId: string;
  templateName: string;
  stack: string;
  serviceName: string;
  outputFileName: string;
  sourceWorkflowFile: string;
  sourcePropertiesFile: string;
  lineCount: number;
  yaml: string;
}

interface WorkflowHistoryRow {
  id: string;
  created_at: string;
  template_id: string;
  template_name: string;
  stack: string;
  service_name: string;
  output_file_name: string;
  source_workflow_file: string;
  source_properties_file: string;
  line_count: number;
  yaml: string;
}

interface CreateWorkflowHistoryInput {
  userId: string;
  templateId: string;
  templateName: string;
  stack: string;
  serviceName: string;
  outputFileName: string;
  sourceWorkflowFile: string;
  sourcePropertiesFile: string;
  lineCount: number;
  yaml: string;
  sha256: string;
}

@Injectable()
export class WorkflowHistoryRepository {
  constructor(
    private readonly databaseService: DatabaseService,
    @Optional()
    @Inject(TENANT_CONTEXT)
    private readonly tenantContext?: TenantContextPort,
  ) {}

  async create(input: CreateWorkflowHistoryInput): Promise<void> {
    const tenantId = this.requireTenantId();
    await this.databaseService.query(
      `
        INSERT INTO workflow_generations (
          tenant_id,
          user_id,
          template_id,
          template_name,
          stack,
          service_name,
          output_file_name,
          source_workflow_file,
          source_properties_file,
          line_count,
          yaml,
          sha256,
          metadata
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, '{}'::jsonb);
      `,
      [
        tenantId,
        input.userId,
        input.templateId,
        input.templateName,
        input.stack,
        input.serviceName,
        input.outputFileName,
        input.sourceWorkflowFile,
        input.sourcePropertiesFile,
        input.lineCount,
        input.yaml,
        input.sha256,
      ],
    );
  }

  async listByUser(
    userId: string,
    limit = 25,
  ): Promise<WorkflowHistoryEntry[]> {
    const tenantId = this.requireTenantId();
    const safeLimit = Number.isFinite(limit)
      ? Math.max(1, Math.min(100, limit))
      : 25;

    const result = await this.databaseService.query<WorkflowHistoryRow>(
      `
        SELECT
          id,
          created_at,
          template_id,
          template_name,
          stack,
          service_name,
          output_file_name,
          source_workflow_file,
          source_properties_file,
          line_count,
          yaml
        FROM workflow_generations
        WHERE user_id = $1
          AND tenant_id = $2::uuid
        ORDER BY created_at DESC
        LIMIT $3;
      `,
      [userId, tenantId, safeLimit],
    );

    return result.rows.map((row) => this.toEntry(row));
  }

  async listForProjectIdentity(input: {
    userId: string;
    serviceName: string;
    templateId: string | null;
    limit?: number;
  }): Promise<WorkflowHistoryEntry[]> {
    const tenantId = this.requireTenantId();
    const safeLimit = Number.isFinite(input.limit)
      ? Math.max(1, Math.min(100, input.limit ?? 5))
      : 5;

    const result = await this.databaseService.query<WorkflowHistoryRow>(
      `
        SELECT
          id,
          created_at,
          template_id,
          template_name,
          stack,
          service_name,
          output_file_name,
          source_workflow_file,
          source_properties_file,
          line_count,
          yaml
        FROM workflow_generations
        WHERE user_id = $1
          AND tenant_id = $4::uuid
          AND (
            service_name = $2
            OR ($3::text IS NOT NULL AND template_id = $3)
          )
        ORDER BY created_at DESC
        LIMIT $5;
      `,
      [input.userId, input.serviceName, input.templateId, tenantId, safeLimit],
    );

    return result.rows.map((row) => this.toEntry(row));
  }

  private toEntry(row: WorkflowHistoryRow): WorkflowHistoryEntry {
    return {
      id: row.id,
      createdAt: row.created_at,
      templateId: row.template_id,
      templateName: row.template_name,
      stack: row.stack,
      serviceName: row.service_name,
      outputFileName: row.output_file_name,
      sourceWorkflowFile: row.source_workflow_file,
      sourcePropertiesFile: row.source_properties_file,
      lineCount: row.line_count,
      yaml: row.yaml,
    };
  }

  private requireTenantId(): string {
    if (!this.tenantContext) {
      throw new TenantContextRequiredError();
    }

    return this.tenantContext.require().tenantId;
  }
}
