import { Inject, Injectable, Optional } from '@nestjs/common';

import { DatabaseService } from '#kernel/db/database.service';
import {
  TENANT_CONTEXT,
  type TenantContextPort,
} from '#kernel/tenancy/tenant-context.port.js';
import { TenantContextRequiredError } from '#kernel/tenancy/tenant-context.js';
import type { FriendlyMessage } from '../application/translate-results';
import type { StageId } from '../application/stages';

export type CiRunStatus = 'success' | 'failure' | 'running' | 'cancelled';

export interface UpsertCiRunReportInput {
  userId: string;
  tenantId: string;
  repoFullName: string;
  branch: string;
  commitSha: string;
  runId: number;
  stage: StageId;
  status: CiRunStatus;
  results: Record<string, unknown>;
  friendlyMessages: FriendlyMessage[];
  rawLogs?: string;
}

export interface CiRunReportRow {
  id: string;
  user_id: string;
  repo_full_name: string;
  branch: string;
  commit_sha: string;
  run_id: string; // bigint comes back as string from pg driver
  stage: StageId;
  status: CiRunStatus;
  results: Record<string, unknown>;
  friendly_messages: FriendlyMessage[];
  raw_logs: string | null;
  created_at: string;
  updated_at: string;
}

@Injectable()
export class CiRunReportsRepository {
  constructor(
    private readonly databaseService: DatabaseService,
    @Optional()
    @Inject(TENANT_CONTEXT)
    private readonly tenantContext?: TenantContextPort,
  ) {}

  /**
   * Explicit deployment-global ingestion path for bearer-authenticated worker
   * reports. The token validation path has already authorized the repository;
   * request-facing reads are tenant-scoped below.
   */
  async upsertDeploymentGlobal(data: UpsertCiRunReportInput): Promise<void> {
    // Cap raw logs at 50 000 characters to keep the column bounded.
    const rawLogs =
      data.rawLogs !== undefined && data.rawLogs !== null
        ? data.rawLogs.slice(0, 50_000)
        : null;

    await this.databaseService.query(
      `
        INSERT INTO workflow.ci_run_reports (
          user_id,
          tenant_id,
          repo_full_name,
          branch,
          commit_sha,
          run_id,
          stage,
          status,
          results,
          friendly_messages,
          raw_logs
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        ON CONFLICT (tenant_id, repo_full_name, run_id, stage)
        DO UPDATE SET
          status            = EXCLUDED.status,
          results           = EXCLUDED.results,
          friendly_messages = EXCLUDED.friendly_messages,
          raw_logs          = EXCLUDED.raw_logs,
          updated_at        = NOW();
      `,
      [
        data.userId,
        data.tenantId,
        data.repoFullName,
        data.branch,
        data.commitSha,
        data.runId,
        data.stage,
        data.status,
        JSON.stringify(data.results),
        JSON.stringify(data.friendlyMessages),
        rawLogs,
      ],
    );
  }

  /** Compatibility name retained for existing ingestion callers. */
  async upsert(data: UpsertCiRunReportInput): Promise<void> {
    return this.upsertDeploymentGlobal(data);
  }

  /**
   * Fetch run-stage rows for a repo, ordered most-recent run first then stages
   * in consistent order within each run.
   *
   * @param repoFullName - The repository to filter by.
   * @param limit - Maximum rows to return (default 150, max 500).
   * @param offset - Rows to skip for pagination (default 0).
   */
  async findRecentByRepo(
    repoFullName: string,
    limit = 150,
    offset = 0,
  ): Promise<CiRunReportRow[]> {
    const tenantId = this.requireTenantId();
    const result = await this.databaseService.query<CiRunReportRow>(
      `
        SELECT
          report.id,
          report.user_id,
          report.repo_full_name,
          report.branch,
          report.commit_sha,
          report.run_id::text AS run_id,
          report.stage,
          report.status,
          report.results,
          report.friendly_messages,
          report.raw_logs,
          report.created_at,
          report.updated_at
        FROM workflow.ci_run_reports AS report
        WHERE report.repo_full_name = $1
          AND report.tenant_id = $4::uuid
          AND EXISTS (
            SELECT 1
            FROM projects.provisioned_projects AS project
            WHERE project.repo_full_name = report.repo_full_name
              AND project.user_id = report.user_id
              AND project.tenant_id = $4::uuid
          )
        ORDER BY report.run_id DESC, report.stage ASC
        LIMIT $2 OFFSET $3;
      `,
      [repoFullName, limit, offset, tenantId],
    );

    return result.rows;
  }

  /**
   * Fetch run-stage rows across all repos owned by a user, ordered most-recent
   * run first. Used when GET /ci/runs is called without a repoFullName filter.
   *
   * @param userId - The authenticated user whose runs to return.
   * @param limit - Maximum rows to return (default 150, max 500).
   * @param offset - Rows to skip for pagination (default 0).
   */
  async findRecentByUser(
    userId: string,
    limit = 150,
    offset = 0,
  ): Promise<CiRunReportRow[]> {
    const tenantId = this.requireTenantId();
    const result = await this.databaseService.query<CiRunReportRow>(
      `
        SELECT
          report.id,
          report.user_id,
          report.repo_full_name,
          report.branch,
          report.commit_sha,
          report.run_id::text AS run_id,
          report.stage,
          report.status,
          report.results,
          report.friendly_messages,
          report.raw_logs,
          report.created_at,
          report.updated_at
        FROM workflow.ci_run_reports AS report
        WHERE report.user_id = $1
          AND report.tenant_id = $4::uuid
          AND EXISTS (
            SELECT 1
            FROM projects.provisioned_projects AS project
            WHERE project.user_id = report.user_id
              AND project.repo_full_name = report.repo_full_name
              AND project.tenant_id = $4::uuid
          )
        ORDER BY report.run_id DESC, report.stage ASC
        LIMIT $2 OFFSET $3;
      `,
      [userId, limit, offset, tenantId],
    );

    return result.rows;
  }

  private requireTenantId(): string {
    if (!this.tenantContext) {
      throw new TenantContextRequiredError();
    }

    return this.tenantContext.require().tenantId;
  }
}
