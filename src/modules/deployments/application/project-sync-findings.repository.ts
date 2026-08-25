import { Injectable } from '@nestjs/common';

import { DatabaseService } from '../../../kernel/db/database.service';
import type { DeploymentDriftFindingsStore } from '../core/deployment-provisioning.contract';
import type {
  ProjectDriftFinding,
  ProjectDriftFindingInput,
  ProjectDriftSeverity,
  ProjectDriftSource,
  ProjectDriftStatus,
} from './project-drift.types';

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

@Injectable()
export class ProjectSyncFindingsRepository implements DeploymentDriftFindingsStore {
  constructor(private readonly databaseService: DatabaseService) {}

  async findActiveByProject(projectId: string): Promise<ProjectDriftFinding[]> {
    const result = await this.databaseService.query<ProjectSyncFindingRow>(
      `
        SELECT *
        FROM projects.project_sync_findings
        WHERE project_id = $1
          AND status = 'active'
        ORDER BY detected_at DESC, code ASC;
      `,
      [projectId],
    );

    return result.rows.map((row) => this.toFinding(row));
  }

  async findByIdForProject(
    projectId: string,
    findingId: string,
  ): Promise<ProjectDriftFinding | null> {
    const result = await this.databaseService.query<ProjectSyncFindingRow>(
      `
        SELECT *
        FROM projects.project_sync_findings
        WHERE project_id = $1
          AND id = $2
        LIMIT 1;
      `,
      [projectId, findingId],
    );

    const row = result.rows[0];
    return row ? this.toFinding(row) : null;
  }

  async markStatus(
    findingId: string,
    status: 'resolved' | 'ignored',
  ): Promise<void> {
    await this.databaseService.query(
      `
        UPDATE projects.project_sync_findings
        SET status = $2,
            resolved_at = NOW()
        WHERE id = $1;
      `,
      [findingId, status],
    );
  }

  async replaceActiveFindings(
    projectId: string,
    findings: ProjectDriftFindingInput[],
  ): Promise<ProjectDriftFinding[]> {
    const existing = await this.findActiveByProject(projectId);
    const nextKeys = new Set(findings.map((finding) => this.key(finding)));

    await Promise.all(
      existing
        .filter((finding) => !nextKeys.has(this.key(finding)))
        .map((finding) =>
          this.databaseService.query(
            `
              UPDATE projects.project_sync_findings
              SET status = 'resolved',
                  resolved_at = NOW()
              WHERE id = $1;
            `,
            [finding.id],
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
            UPDATE projects.project_sync_findings
            SET severity = $2,
                message = $3,
                details_json = $4::jsonb,
                detected_at = NOW()
            WHERE id = $1;
          `,
          [
            current.id,
            finding.severity,
            finding.message,
            JSON.stringify(finding.details ?? {}),
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
            VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'active');
          `,
          [
            projectId,
            finding.targetId ?? null,
            finding.source,
            finding.severity,
            finding.code,
            finding.message,
            JSON.stringify(finding.details ?? {}),
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
}
