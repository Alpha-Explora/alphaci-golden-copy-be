import { ConflictException, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';

import { DatabaseService } from '#kernel/db/database.service';
import type {
  DeploymentHistoryItem,
  DeploymentHistoryStatus,
} from '../../core/deployment-provisioning.contract';
import { ONPREM_COMPOSE_PROVIDER_ID } from '../providers/onprem/onprem-compose.provider';
import type {
  ReleaseArtifact,
  ReleaseManifest,
  ReleaseSlot,
  WorkflowRun,
} from '../../domain/release-manifest';

export type DeploymentStatus =
  | 'pending'
  | 'deploying'
  | 'healthy'
  | 'failed'
  | 'rolled_back';

/** Who carries a deployment out: the generated workflow, or the environment's host. */
export type DeploymentDelivery = 'workflow' | 'host';

export interface ReleaseRecord {
  id: string;
  projectId: string;
  sourceEnvironmentId: string;
  sourceBranch: string;
  commitSha: string;
  workflowRun: WorkflowRun;
  artifacts: ReleaseArtifact[];
  verificationStatus: 'pending' | 'verified';
  manifest: ReleaseManifest | null;
  manifestSha256: string | null;
  signature: { algorithm: string; keyId: string; value: string } | null;
  createdAt: string;
  verifiedAt: string | null;
}

export interface EnvironmentDeploymentRecord {
  id: string;
  projectId: string;
  environmentId: string;
  releaseId: string;
  trigger: 'automatic' | 'promotion';
  delivery: DeploymentDelivery;
  targetIds: string[];
  status: DeploymentStatus;
  detail: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OnpremHostRecord {
  id: string;
  projectId: string;
  environmentId: string;
  name: string;
  tokenPrefix: string;
}

interface ReleaseRow {
  id: string;
  project_id: string;
  source_environment_id: string;
  source_branch: string;
  commit_sha: string;
  workflow_provider: 'github_actions';
  workflow_repo: string;
  workflow_run_id: string;
  workflow_run_url: string;
  verification_status: 'pending' | 'verified';
  manifest: ReleaseManifest | null;
  manifest_sha256: string | null;
  signature_algorithm: string | null;
  signature_key_id: string | null;
  signature_value: string | null;
  created_at: Date;
  verified_at: Date | null;
  artifacts: Array<{ slot: ReleaseSlot; image: string; digest: string }> | null;
}

export interface DeploymentRow {
  id: string;
  project_id: string;
  environment_id: string;
  release_id: string;
  trigger: 'automatic' | 'promotion';
  delivery: DeploymentDelivery;
  target_ids: string[];
  status: DeploymentStatus;
  detail: string | null;
  created_at: Date;
  updated_at: Date;
}

const RELEASE_COLUMNS = `
  release.*,
  COALESCE(
    (SELECT json_agg(json_build_object('slot', a.slot, 'image', a.image, 'digest', a.digest) ORDER BY a.slot)
       FROM env_provisioning.release_artifacts AS a
      WHERE a.release_id = release.id),
    '[]'::json
  ) AS artifacts`;

const DEPLOYMENT_TRANSITIONS: Record<DeploymentStatus, DeploymentStatus[]> = {
  pending: ['deploying', 'failed'],
  deploying: ['healthy', 'failed', 'rolled_back'],
  healthy: [],
  failed: [],
  rolled_back: [],
};

/** Statuses a deployment may move to from where it is now. */
export function allowedDeploymentTransitions(
  status: DeploymentStatus,
): DeploymentStatus[] {
  return DEPLOYMENT_TRANSITIONS[status];
}

@Injectable()
export class ReleaseRegistryRepository {
  constructor(private readonly databaseService: DatabaseService) {}

  async listTargetDeploymentHistory(
    projectId: string,
    targetId: string,
  ): Promise<DeploymentHistoryItem[]> {
    const result = await this.databaseService.query<{
      id: string;
      status: DeploymentStatus;
      created_at: Date;
      updated_at: Date;
      commit_sha: string;
      source_branch: string;
      branch_name: string;
      slot: DeploymentHistoryItem['slot'];
      provider_project_name: string;
      environment_id: string;
      public_url: string | null;
    }>(
      `SELECT d.id, d.status, d.created_at, d.updated_at, r.commit_sha,
              r.source_branch, t.branch_name, t.slot, t.provider_project_name, t.environment_id,
              address.public_url
         FROM env_provisioning.project_deployment_targets t
         JOIN env_provisioning.environment_deployments d
           ON d.project_id = t.project_id AND d.environment_id = t.environment_id
          AND t.id = ANY(d.target_ids)
         JOIN env_provisioning.releases r ON r.id = d.release_id AND r.project_id = d.project_id
        -- Where the environment answers now: its configured address, or the
        -- tunnel's while it runs. QA Studio and the previews open this.
        LEFT JOIN LATERAL (
          SELECT COALESCE(
                   NULLIF(h.assignment_config->'ingress'->>'publicUrl', ''),
                   CASE WHEN h.tunnel_status = 'running' THEN h.tunnel_url END
                 ) AS public_url
            FROM env_provisioning.onprem_hosts h
           WHERE h.project_id = t.project_id AND h.environment_id = t.environment_id
             AND h.revoked_at IS NULL
           ORDER BY h.created_at DESC LIMIT 1
        ) address ON true
        WHERE t.project_id = $1 AND t.id = $2 AND d.delivery = 'host'
        ORDER BY d.created_at DESC, d.id DESC LIMIT 100`,
      [projectId, targetId],
    );
    const statuses: Record<DeploymentStatus, DeploymentHistoryStatus> = {
      pending: 'queued',
      deploying: 'building',
      healthy: 'ready',
      failed: 'failed',
      rolled_back: 'failed',
    };
    const url = `/projects/${projectId}`;
    return result.rows.map((row) => ({
      id: row.id,
      targetId,
      targetName: row.provider_project_name,
      provider: ONPREM_COMPOSE_PROVIDER_ID,
      slot: row.slot,
      environment: row.branch_name === 'main' ? 'production' : row.branch_name,
      branch: row.branch_name,
      commitSha: row.commit_sha,
      commitMessage: null,
      createdBy: null,
      status: statuses[row.status],
      createdAt: iso(row.created_at) ?? '',
      readyAt: row.status === 'healthy' ? iso(row.updated_at) : null,
      deploymentUrl: row.public_url ?? null,
      pullRequestNumber: null,
      inspectorUrl: null,
      dashboardUrl: url,
      consoleUrl: url,
    }));
  }

  /**
   * Register a release with its artifacts and the automatic deployment of the
   * project's first environment, all or nothing.
   */
  async registerRelease(input: {
    projectId: string;
    sourceEnvironmentId: string;
    sourceBranch: string;
    commitSha: string;
    workflowRun: WorkflowRun;
    artifacts: ReleaseArtifact[];
    automaticTargetIds: string[];
    automaticDelivery: DeploymentDelivery;
  }): Promise<ReleaseRecord> {
    const releaseId = await this.databaseService.withTransaction(
      async (client) => {
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO env_provisioning.releases (
           project_id, source_environment_id, source_branch, commit_sha,
           workflow_provider, workflow_repo, workflow_run_id, workflow_run_url
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id`,
          [
            input.projectId,
            input.sourceEnvironmentId,
            input.sourceBranch,
            input.commitSha,
            input.workflowRun.provider,
            input.workflowRun.repo,
            input.workflowRun.runId,
            input.workflowRun.url,
          ],
        );
        const id = inserted.rows[0]?.id;
        if (!id)
          throw new Error('env_provisioning.releases INSERT returned no row');
        for (const artifact of input.artifacts) {
          await client.query(
            `INSERT INTO env_provisioning.release_artifacts (release_id, slot, image, digest)
           VALUES ($1, $2, $3, $4)`,
            [id, artifact.slot, artifact.image, artifact.digest],
          );
        }
        await client.query(
          `INSERT INTO env_provisioning.environment_deployments
           (project_id, environment_id, release_id, trigger, target_ids, delivery)
         VALUES ($1, $2, $3, 'automatic', $4::uuid[], $5)`,
          [
            input.projectId,
            input.sourceEnvironmentId,
            id,
            input.automaticTargetIds,
            input.automaticDelivery,
          ],
        );
        return id;
      },
    );
    const release = await this.findRelease(input.projectId, releaseId);
    if (!release)
      throw new Error('Registered release ' + releaseId + ' is not readable');
    return release;
  }

  async findRelease(
    projectId: string,
    releaseId: string,
  ): Promise<ReleaseRecord | null> {
    const result = await this.databaseService.query<ReleaseRow>(
      `SELECT ${RELEASE_COLUMNS}
         FROM env_provisioning.releases AS release
        WHERE release.project_id = $1 AND release.id = $2`,
      [projectId, releaseId],
    );
    const row = result.rows[0];
    return row ? toRelease(row) : null;
  }

  /** Signing and unsigned-deployment cleanup serialize on the release row. */
  async attachManifest(input: {
    releaseId: string;
    manifest: ReleaseManifest;
    manifestSha256: string;
    signature: { algorithm: string; keyId: string; value: string };
  }): Promise<boolean> {
    return this.databaseService.withTransaction(async (client) => {
      await client.query(
        'SELECT id FROM env_provisioning.releases WHERE id = $1 FOR UPDATE',
        [input.releaseId],
      );
      const result = await client.query(
        `UPDATE env_provisioning.releases
          SET verification_status = 'verified', manifest = $2, manifest_sha256 = $3,
              signature_algorithm = $4, signature_key_id = $5, signature_value = $6,
              verified_at = NOW()
        WHERE id = $1 AND verification_status = 'pending'
          AND NOT EXISTS (
            SELECT 1 FROM env_provisioning.environment_deployments
             WHERE release_id = $1 AND trigger = 'automatic'
               AND delivery = 'host' AND status <> 'pending'
          )`,
        [
          input.releaseId,
          JSON.stringify(input.manifest),
          input.manifestSha256,
          input.signature.algorithm,
          input.signature.keyId,
          input.signature.value,
        ],
      );
      return (result.rowCount ?? 0) === 1;
    });
  }

  /** CI may clean up a failed signer, but never take over a signed host release. */
  async failUnsignedHostDeployment(
    releaseId: string,
    detail: string | null,
  ): Promise<EnvironmentDeploymentRecord | null> {
    return this.databaseService.withTransaction(async (client) => {
      const release = await client.query<{ verification_status: string }>(
        `SELECT verification_status FROM env_provisioning.releases
          WHERE id = $1 FOR UPDATE`,
        [releaseId],
      );
      if (release.rows[0]?.verification_status !== 'pending') return null;
      const result = await client.query<DeploymentRow>(
        `UPDATE env_provisioning.environment_deployments
            SET status = 'failed', detail = $2, updated_at = NOW()
          WHERE release_id = $1 AND trigger = 'automatic' AND delivery = 'host'
            AND status IN ('pending', 'failed')
          RETURNING *`,
        [releaseId, detail],
      );
      return result.rows[0] ? toDeployment(result.rows[0]) : null;
    });
  }

  /** The release an environment currently runs: its latest healthy deployment. */
  async pinnedReleaseId(environmentId: string): Promise<string | null> {
    const result = await this.databaseService.query<{ release_id: string }>(
      `SELECT release_id FROM env_provisioning.environment_deployments
        WHERE environment_id = $1 AND status = 'healthy'
        ORDER BY updated_at DESC, created_at DESC
        LIMIT 1`,
      [environmentId],
    );
    return result.rows[0]?.release_id ?? null;
  }

  async createPromotion(input: {
    projectId: string;
    environmentId: string;
    releaseId: string;
    targetIds: string[];
    delivery: DeploymentDelivery;
    requestedBy: string;
  }): Promise<EnvironmentDeploymentRecord> {
    const result = await this.databaseService.query<DeploymentRow>(
      `INSERT INTO env_provisioning.environment_deployments
         (project_id, environment_id, release_id, trigger, target_ids, requested_by, delivery)
       VALUES ($1, $2, $3, 'promotion', $4::uuid[], $5, $6)
       RETURNING *`,
      [
        input.projectId,
        input.environmentId,
        input.releaseId,
        input.targetIds,
        input.requestedBy,
        input.delivery,
      ],
    );
    return toDeployment(requiredRow(result.rows[0]));
  }

  /**
   * Who asked for a deployment and the public address of its environment's
   * on-prem host (configured, else a running tunnel's): what the verify stage
   * is started with once the deployment is healthy.
   */
  async verifyTarget(
    deploymentId: string,
  ): Promise<{ requestedBy: string | null; address: string | null } | null> {
    const result = await this.databaseService.query<{
      requested_by: string | null;
      public_url: string | null;
    }>(
      `SELECT d.requested_by, address.public_url
         FROM env_provisioning.environment_deployments d
         LEFT JOIN LATERAL (
           SELECT COALESCE(
                    NULLIF(h.assignment_config->'ingress'->>'publicUrl', ''),
                    CASE WHEN h.tunnel_status = 'running' THEN h.tunnel_url END
                  ) AS public_url
             FROM env_provisioning.onprem_hosts h
            WHERE h.project_id = d.project_id
              AND h.environment_id = d.environment_id
              AND h.revoked_at IS NULL
            ORDER BY h.created_at DESC
            LIMIT 1
         ) address ON true
        WHERE d.id = $1`,
      [deploymentId],
    );
    const row = result.rows[0];
    return row
      ? { requestedBy: row.requested_by, address: row.public_url }
      : null;
  }

  async findDeployment(
    deploymentId: string,
  ): Promise<EnvironmentDeploymentRecord | null> {
    const result = await this.databaseService.query<DeploymentRow>(
      'SELECT * FROM env_provisioning.environment_deployments WHERE id = $1',
      [deploymentId],
    );
    const row = result.rows[0];
    return row ? toDeployment(row) : null;
  }

  async findAutomaticDeployment(
    releaseId: string,
  ): Promise<EnvironmentDeploymentRecord | null> {
    const result = await this.databaseService.query<DeploymentRow>(
      `SELECT * FROM env_provisioning.environment_deployments
        WHERE release_id = $1 AND trigger = 'automatic'`,
      [releaseId],
    );
    const row = result.rows[0];
    return row ? toDeployment(row) : null;
  }

  async listReleaseDeployments(
    releaseId: string,
  ): Promise<EnvironmentDeploymentRecord[]> {
    const result = await this.databaseService.query<DeploymentRow>(
      `SELECT * FROM env_provisioning.environment_deployments
        WHERE release_id = $1 ORDER BY created_at`,
      [releaseId],
    );
    return result.rows.map(toDeployment);
  }

  /** A project's releases, newest first. */
  async listProjectReleases(
    projectId: string,
    limit: number,
  ): Promise<ReleaseRecord[]> {
    const result = await this.databaseService.query<ReleaseRow>(
      `SELECT ${RELEASE_COLUMNS}
         FROM env_provisioning.releases AS release
        WHERE release.project_id = $1
        ORDER BY release.created_at DESC
        LIMIT $2`,
      [projectId, limit],
    );
    return result.rows.map(toRelease);
  }

  /** One environment's deployments, newest first. */
  async listEnvironmentDeployments(
    environmentId: string,
    limit: number,
  ): Promise<EnvironmentDeploymentRecord[]> {
    const result = await this.databaseService.query<DeploymentRow>(
      `SELECT * FROM env_provisioning.environment_deployments
        WHERE environment_id = $1
        ORDER BY updated_at DESC, created_at DESC
        LIMIT $2`,
      [environmentId, limit],
    );
    return result.rows.map(toDeployment);
  }

  /** Move a deployment on only from the status it was read in. */
  async transitionDeployment(input: {
    deploymentId: string;
    from: DeploymentStatus;
    to: DeploymentStatus;
    detail: string | null;
  }): Promise<EnvironmentDeploymentRecord | null> {
    const result = await this.databaseService.query<DeploymentRow>(
      `UPDATE env_provisioning.environment_deployments
          SET status = $3, detail = $4, updated_at = NOW()
        WHERE id = $1 AND status = $2
        RETURNING *`,
      [input.deploymentId, input.from, input.to, input.detail],
    );
    const row = result.rows[0];
    return row ? toDeployment(row) : null;
  }

  async createHost(input: {
    projectId: string;
    environmentId: string;
    name: string;
    tokenPrefix: string;
    tokenSha256: string;
    createdBy: string;
  }): Promise<OnpremHostRecord> {
    return this.databaseService.withTransaction(async (client) => {
      // Serialize registrations even when no host exists yet. Keep the lock
      // in Runtime instead of locking another module's environment table.
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        ['onprem-host:' + input.environmentId],
      );
      const bound = await client.query<{ machine_id: string | null }>(
        `SELECT machine_id FROM env_provisioning.onprem_hosts
          WHERE environment_id=$1 AND revoked_at IS NULL FOR UPDATE`,
        [input.environmentId],
      );
      if (bound.rows[0]?.machine_id)
        throw new ConflictException(
          'Unassign the reusable machine explicitly before registering a legacy host.',
        );
      await client.query(
        `UPDATE env_provisioning.onprem_hosts SET revoked_at = NOW()
          WHERE environment_id = $1 AND revoked_at IS NULL`,
        [input.environmentId],
      );
      const result = await client.query<{
        id: string;
        project_id: string;
        environment_id: string;
        name: string;
        token_prefix: string;
      }>(
        `INSERT INTO env_provisioning.onprem_hosts
         (project_id, environment_id, name, token_prefix, token_sha256, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, project_id, environment_id, name, token_prefix`,
        [
          input.projectId,
          input.environmentId,
          input.name,
          input.tokenPrefix,
          input.tokenSha256,
          input.createdBy,
        ],
      );
      const row = requiredRow(result.rows[0]);
      return {
        id: row.id,
        projectId: row.project_id,
        environmentId: row.environment_id,
        name: row.name,
        tokenPrefix: row.token_prefix,
      };
    });
  }

  async findActiveHostByTokenHash(
    tokenSha256: string,
  ): Promise<OnpremHostRecord | null> {
    const result = await this.databaseService.query<{
      id: string;
      project_id: string;
      environment_id: string;
      name: string;
      token_prefix: string;
    }>(
      `SELECT id, project_id, environment_id, name, token_prefix
         FROM env_provisioning.onprem_hosts
        WHERE token_sha256 = $1 AND revoked_at IS NULL`,
      [tokenSha256],
    );
    const row = result.rows[0];
    return row
      ? {
          id: row.id,
          projectId: row.project_id,
          environmentId: row.environment_id,
          name: row.name,
          tokenPrefix: row.token_prefix,
        }
      : null;
  }

  /** In-flight deployments for one environment whose release has a signed manifest. */
  async listHostAssignments(
    environmentId: string,
    client?: PoolClient,
  ): Promise<
    Array<{ deployment: EnvironmentDeploymentRecord; release: ReleaseRecord }>
  > {
    const sql = `SELECT deployment.*,
              (SELECT row_to_json(r) FROM (
                 SELECT ${RELEASE_COLUMNS}
                   FROM env_provisioning.releases AS release
                  WHERE release.id = deployment.release_id
              ) AS r) AS release
         FROM env_provisioning.environment_deployments AS deployment
         JOIN env_provisioning.releases AS signed
           ON signed.id = deployment.release_id AND signed.verification_status = 'verified'
        WHERE deployment.environment_id = $1
          AND deployment.delivery = 'host'
          AND deployment.status IN ('pending', 'deploying')
        ORDER BY deployment.created_at`;
    const result = client
      ? await client.query<DeploymentRow & { release: ReleaseRow }>(sql, [
          environmentId,
        ])
      : await this.databaseService.query<
          DeploymentRow & { release: ReleaseRow }
        >(sql, [environmentId]);
    return result.rows.map((row) => ({
      deployment: toDeployment(row),
      release: toRelease(row.release),
    }));
  }
}

function requiredRow<T>(row: T | undefined): T {
  if (!row) throw new Error('Expected a row, got none');
  return row;
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

function toRelease(row: ReleaseRow): ReleaseRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    sourceEnvironmentId: row.source_environment_id,
    sourceBranch: row.source_branch,
    commitSha: row.commit_sha,
    workflowRun: {
      provider: row.workflow_provider,
      repo: row.workflow_repo,
      runId: row.workflow_run_id,
      url: row.workflow_run_url,
    },
    artifacts: row.artifacts ?? [],
    verificationStatus: row.verification_status,
    manifest: row.manifest,
    manifestSha256: row.manifest_sha256,
    signature:
      row.signature_algorithm && row.signature_key_id && row.signature_value
        ? {
            algorithm: row.signature_algorithm,
            keyId: row.signature_key_id,
            value: row.signature_value,
          }
        : null,
    createdAt: iso(row.created_at) ?? '',
    verifiedAt: iso(row.verified_at),
  };
}

export function toDeployment(row: DeploymentRow): EnvironmentDeploymentRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    environmentId: row.environment_id,
    releaseId: row.release_id,
    trigger: row.trigger,
    delivery: row.delivery,
    targetIds: row.target_ids,
    status: row.status,
    detail: row.detail,
    createdAt: iso(row.created_at) ?? '',
    updatedAt: iso(row.updated_at) ?? '',
  };
}
