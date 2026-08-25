import { Injectable } from '@nestjs/common';

import { DatabaseService } from '../../../../kernel/db/database.service';

export interface CreateProvisioningJobInput {
  idempotencyKey: string;
  workspaceId: string;
  projectId: string;
  deploymentTargetId?: string | null;
  payload: Record<string, unknown>;
}

export interface ProvisioningJobSummary {
  id: string;
  status: string;
  payload: Record<string, unknown>;
}

export interface ClaimedProvisioningJob extends ProvisioningJobSummary {
  jobType: 'provision_target';
  workspaceId: string;
  projectId: string;
  deploymentTargetId: string | null;
}

export interface ProvisioningJobFailure {
  code: string;
  safeMessage: string;
}

interface ProvisioningJobRow {
  id: string;
  job_type?: 'provision_target';
  workspace_id?: string;
  project_id?: string;
  deployment_target_id?: string | null;
  status: string;
  payload: Record<string, unknown> | null;
}

@Injectable()
export class ProvisioningJobsRepository {
  constructor(private readonly databaseService: DatabaseService) {}

  async create(
    input: CreateProvisioningJobInput,
  ): Promise<ProvisioningJobSummary> {
    const result = await this.databaseService.query<ProvisioningJobRow>(
      `
        INSERT INTO gcp_operations.provisioning_jobs (
          job_type,
          idempotency_key,
          workspace_id,
          project_id,
          deployment_target_id,
          payload
        )
        VALUES ($1, $2, $3, $4, $5, $6::jsonb)
        ON CONFLICT (idempotency_key)
        DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
        RETURNING *;
      `,
      [
        'provision_target',
        input.idempotencyKey,
        input.workspaceId,
        input.projectId,
        input.deploymentTargetId ?? null,
        JSON.stringify(input.payload),
      ],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error('GCP provisioning job create returned no row');
    }

    return {
      id: row.id,
      status: row.status,
      payload: row.payload ?? {},
    };
  }

  async claimNext(workerId: string): Promise<ClaimedProvisioningJob | null> {
    const result = await this.databaseService.query<ProvisioningJobRow>(
      `
        WITH next_job AS (
          SELECT id
          FROM gcp_operations.provisioning_jobs
          WHERE status = 'queued'
            AND (next_retry_at IS NULL OR next_retry_at <= NOW())
          ORDER BY created_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        UPDATE gcp_operations.provisioning_jobs AS job
        SET
          status = 'running',
          locked_at = NOW(),
          locked_by = $1,
          attempt_count = attempt_count + 1,
          updated_at = NOW()
        FROM next_job
        WHERE job.id = next_job.id
        RETURNING job.*;
      `,
      [workerId],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    if (!row.job_type || !row.workspace_id || !row.project_id) {
      throw new Error('Claimed GCP provisioning job is missing required fields');
    }

    return {
      id: row.id,
      jobType: row.job_type,
      workspaceId: row.workspace_id,
      projectId: row.project_id,
      deploymentTargetId: row.deployment_target_id ?? null,
      status: row.status,
      payload: row.payload ?? {},
    };
  }

  async complete(jobId: string): Promise<void> {
    await this.databaseService.query(
      `
        UPDATE gcp_operations.provisioning_jobs
        SET status = 'succeeded',
            locked_at = NULL,
            locked_by = NULL,
            next_retry_at = NULL,
            updated_at = NOW()
        WHERE id = $1
          AND status = 'running';
      `,
      [jobId],
    );
  }

  async fail(jobId: string, failure: ProvisioningJobFailure): Promise<void> {
    await this.databaseService.query(
      `
        UPDATE gcp_operations.provisioning_jobs
        SET
          status = CASE WHEN attempt_count >= max_attempts THEN 'dead_letter' ELSE 'queued' END,
          locked_at = NULL,
          locked_by = NULL,
          next_retry_at = CASE
            WHEN attempt_count >= max_attempts THEN NULL
            ELSE NOW() + INTERVAL '60 seconds'
          END,
          safe_error_code = $1,
          safe_error_message = $2,
          updated_at = NOW()
        WHERE id = $3
          AND status = 'running';
      `,
      [failure.code, failure.safeMessage, jobId],
    );
  }
}
