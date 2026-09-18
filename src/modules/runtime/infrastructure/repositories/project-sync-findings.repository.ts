import { Inject, Injectable } from '@nestjs/common';

import { DatabaseService } from '#kernel/db/database.service';
import {
  TENANT_CONTEXT,
  type TenantContextPort,
} from '#kernel/tenancy/tenant-context.port.js';
import type { DeploymentDriftFindingsStore } from '../../core/deployment-provisioning.contract';
import type {
  ProjectDriftFinding,
  ProjectDriftFindingInput,
  ProjectDriftSeverity,
  ProjectDriftSource,
  ProjectDriftStatus,
} from '../../application/project-drift.types';

interface ProjectSyncFindingRow {
  id: string;
  project_id: string;
  target_id: string | null;
  source: ProjectDriftSource;
  severity: ProjectDriftSeverity;
  code: string;
  message: string;
  details_json: Record<string, unknown> | string;
  status: ProjectDriftStatus;
  detected_at: string;
  resolved_at: string | null;
}

function projectTenantPredicate(
  projectAlias: string,
  tenantParam: string,
): string {
  return `
    ${projectAlias}.tenant_id = ${tenantParam}::uuid
    AND (
      ${projectAlias}.workspace_id IS NULL
      OR EXISTS (
        SELECT 1
        FROM orgs.workspaces AS tenant_workspace
        WHERE tenant_workspace.id = ${projectAlias}.workspace_id
          AND tenant_workspace.tenant_id = ${tenantParam}::uuid
      )
    )
  `;
}

@Injectable()
export class ProjectSyncFindingsRepository implements DeploymentDriftFindingsStore {
  /**
   * This adapter is project-scoped even when detection is initiated by a
   * worker. There is intentionally no deployment-global reconciliation method;
   * a worker must establish the validated tenant context before calling it.
   */
  constructor(
    private readonly databaseService: DatabaseService,
    @Inject(TENANT_CONTEXT)
    private readonly tenantContext: TenantContextPort,
  ) {}

  async findActiveByProject(projectId: string): Promise<ProjectDriftFinding[]> {
    const tenantId = this.requireTenantId();
    const result = await this.databaseService.query<ProjectSyncFindingRow>(
      `
        SELECT finding.*
        FROM projects.project_sync_findings AS finding
        JOIN projects.provisioned_projects AS project
          ON project.id = finding.project_id
        WHERE finding.project_id = $1
          AND ${projectTenantPredicate('project', '$2')}
          AND finding.status = 'active'
        ORDER BY finding.detected_at DESC, finding.code ASC;
      `,
      [projectId, tenantId],
    );

    return result.rows.map((row) => this.toFinding(row));
  }

  async findByIdForProject(
    projectId: string,
    findingId: string,
  ): Promise<ProjectDriftFinding | null> {
    const tenantId = this.requireTenantId();
    const result = await this.databaseService.query<ProjectSyncFindingRow>(
      `
        SELECT finding.*
        FROM projects.project_sync_findings AS finding
        JOIN projects.provisioned_projects AS project
          ON project.id = finding.project_id
        WHERE finding.project_id = $1
          AND finding.id = $2
          AND ${projectTenantPredicate('project', '$3')}
        LIMIT 1;
      `,
      [projectId, findingId, tenantId],
    );

    const row = result.rows[0];
    return row ? this.toFinding(row) : null;
  }

  async markStatus(
    findingId: string,
    status: 'resolved' | 'ignored',
  ): Promise<void> {
    const tenantId = this.requireTenantId();
    await this.databaseService.query(
      `
        UPDATE projects.project_sync_findings AS finding
        SET status = $2,
            resolved_at = NOW()
        FROM projects.provisioned_projects AS project
        WHERE finding.id = $1
          AND project.id = finding.project_id
          AND ${projectTenantPredicate('project', '$3')};
      `,
      [findingId, status, tenantId],
    );
  }

  async replaceActiveFindings(
    projectId: string,
    findings: ProjectDriftFindingInput[],
  ): Promise<ProjectDriftFinding[]> {
    const tenantId = this.requireTenantId();
    const existing = await this.findActiveByProject(projectId);
    const nextKeys = new Set(findings.map((finding) => this.key(finding)));

    await Promise.all(
      existing
        .filter((finding) => !nextKeys.has(this.key(finding)))
        .map((finding) =>
          this.databaseService.query(
            `
              UPDATE projects.project_sync_findings AS finding
              SET status = 'resolved',
                  resolved_at = NOW()
              FROM projects.provisioned_projects AS project
              WHERE finding.id = $1
                AND finding.project_id = $2
                AND project.id = finding.project_id
                AND ${projectTenantPredicate('project', '$3')};
            `,
            [finding.id, projectId, tenantId],
          ),
        ),
    );

    for (const finding of findings) {
      const current = existing.find(
        (candidate) => this.key(candidate) === this.key(finding),
      );
      if (current) {
        await this.databaseService.query(
          `
            UPDATE projects.project_sync_findings AS current_finding
            SET severity = $2,
                message = $3,
                details_json = $4::jsonb,
                detected_at = NOW()
            FROM projects.provisioned_projects AS project
            WHERE current_finding.id = $1
              AND current_finding.project_id = $5
              AND project.id = current_finding.project_id
              AND ${projectTenantPredicate('project', '$6')};
          `,
          [
            current.id,
            finding.severity,
            finding.message,
            JSON.stringify(finding.details ?? {}),
            projectId,
            tenantId,
          ],
        );
      } else {
        await this.databaseService.query(
          `
            INSERT INTO projects.project_sync_findings (
              project_id,
              target_id,
              source,
              severity,
              code,
              message,
              details_json,
              status
            )
            SELECT $1, $2, $3, $4, $5, $6, $7::jsonb, 'active'
            FROM projects.provisioned_projects AS project
            WHERE project.id = $1
              AND ${projectTenantPredicate('project', '$8')}
              AND (
                $2::uuid IS NULL
                OR EXISTS (
                  SELECT 1
                  FROM env_provisioning.project_deployment_targets AS target
                  WHERE target.id = $2::uuid
                    AND target.project_id = project.id
                )
              );
          `,
          [
            projectId,
            finding.targetId ?? null,
            finding.source,
            finding.severity,
            finding.code,
            finding.message,
            JSON.stringify(finding.details ?? {}),
            tenantId,
          ],
        );
      }
    }

    return this.findActiveByProject(projectId);
  }

  private key(finding: Pick<ProjectDriftFindingInput, 'code' | 'targetId'>) {
    return `${finding.code}:${finding.targetId ?? ''}`;
  }

  private toFinding(row: ProjectSyncFindingRow): ProjectDriftFinding {
    const details =
      typeof row.details_json === 'string'
        ? (JSON.parse(row.details_json) as Record<string, unknown>)
        : row.details_json;

    return {
      id: row.id,
      projectId: row.project_id,
      targetId: row.target_id,
      source: row.source,
      severity: row.severity,
      code: row.code,
      message: row.message,
      details,
      status: row.status,
      detectedAt: row.detected_at,
      resolvedAt: row.resolved_at,
    };
  }

  private requireTenantId(): string {
    return this.tenantContext.require().tenantId;
  }
}
