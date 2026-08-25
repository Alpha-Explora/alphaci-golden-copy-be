import { Injectable } from '@nestjs/common';

import { DatabaseService } from '../../kernel/db/database.service';
import type { FriendlyMessage } from './translate-results';

export type CiRunStatus = 'success' | 'failure' | 'running' | 'cancelled';

export interface UpsertCiRunReportInput {
  userId: string;
  repoFullName: string;
  branch: string;
  commitSha: string;
  runId: number;
  stage: 'access' | 'quality' | 'package';
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
  stage: 'access' | 'quality' | 'package';
  status: CiRunStatus;
  results: Record<string, unknown>;
  friendly_messages: FriendlyMessage[];
  raw_logs: string | null;
  created_at: string;
  updated_at: string;
}

@Injectable()
export class CiRunReportsRepository {
  constructor(private readonly databaseService: DatabaseService) {}

  /**
   * Upsert a CI run report. The unique key is (repo_full_name, run_id, stage).
   * On conflict the status, results, friendly_messages, raw_logs, and updated_at
   * are refreshed.
   */
  async upsert(data: UpsertCiRunReportInput): Promise<void> {
    // Cap raw logs at 50 000 characters to keep the column bounded.
    const rawLogs =
      data.rawLogs !== undefined && data.rawLogs !== null
        ? data.rawLogs.slice(0, 50_000)
        : null;

    await this.databaseService.query(
      `
        INSERT INTO workflow.ci_run_reports (
          user_id,
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
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (repo_full_name, run_id, stage)
        DO UPDATE SET
          status            = EXCLUDED.status,
          results           = EXCLUDED.results,
          friendly_messages = EXCLUDED.friendly_messages,
          raw_logs          = EXCLUDED.raw_logs,
          updated_at        = NOW();
      `,
      [
        data.userId,
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
    const result = await this.databaseService.query<CiRunReportRow>(
      `
        SELECT
          id,
          user_id,
          repo_full_name,
          branch,
          commit_sha,
          run_id::text AS run_id,
          stage,
          status,
          results,
          friendly_messages,
          raw_logs,
          created_at,
          updated_at
        FROM workflow.ci_run_reports
        WHERE repo_full_name = $1
        ORDER BY run_id DESC, stage ASC
        LIMIT $2 OFFSET $3;
      `,
      [repoFullName, limit, offset],
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
    const result = await this.databaseService.query<CiRunReportRow>(
      `
        SELECT
          id,
          user_id,
          repo_full_name,
          branch,
          commit_sha,
          run_id::text AS run_id,
          stage,
          status,
          results,
          friendly_messages,
          raw_logs,
          created_at,
          updated_at
        FROM workflow.ci_run_reports
        WHERE user_id = $1
        ORDER BY run_id DESC, stage ASC
        LIMIT $2 OFFSET $3;
      `,
      [userId, limit, offset],
    );

    return result.rows;
  }
}
