import { Injectable } from '@nestjs/common';

import { DatabaseService } from '#kernel/db/database.service';

export type ProjectDashboardSnapshotStatus = 'ok' | 'warning' | 'error';

export interface ProjectDashboardSnapshotFinding {
  code: string;
  severity: ProjectDashboardSnapshotStatus;
  message: string;
  source: 'local_snapshot';
}

export interface ProjectDashboardSnapshot {
  id: string;
  projectId: string;
  status: ProjectDashboardSnapshotStatus;
  summary: Record<string, unknown>;
  findings: ProjectDashboardSnapshotFinding[];
  startedAt: string;
  completedAt: string;
  createdBy: string | null;
  createdAt: string;
}

export interface CreateProjectDashboardSnapshotInput {
  projectId: string;
  status: ProjectDashboardSnapshotStatus;
  summary: Record<string, unknown>;
  findings: ProjectDashboardSnapshotFinding[];
  startedAt: string;
  completedAt: string;
  createdBy: string | null;
}

interface ProjectDashboardSnapshotRow {
  id: string;
  project_id: string;
  status: ProjectDashboardSnapshotStatus;
  summary_json: Record<string, unknown> | string;
  findings_json: ProjectDashboardSnapshotFinding[] | string;
  started_at: string;
  completed_at: string;
  created_by: string | null;
  created_at: string;
}

@Injectable()
export class ProjectDashboardSnapshotsRepository {
  constructor(private readonly databaseService: DatabaseService) {}

  async createSnapshot(
    input: CreateProjectDashboardSnapshotInput,
  ): Promise<ProjectDashboardSnapshot> {
    const result =
      await this.databaseService.query<ProjectDashboardSnapshotRow>(
        `
          INSERT INTO projects.project_dashboard_snapshots (
            project_id,
            status,
            summary_json,
            findings_json,
            started_at,
            completed_at,
            created_by
          )
          VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7)
          RETURNING *;
        `,
        [
          input.projectId,
          input.status,
          JSON.stringify(input.summary),
          JSON.stringify(input.findings),
          input.startedAt,
          input.completedAt,
          input.createdBy,
        ],
      );

    const row = result.rows[0];
    if (!row) {
      throw new Error(
        'projects.project_dashboard_snapshots INSERT returned no row',
      );
    }

    return this.toSnapshot(row);
  }

  async findLatestByProject(
    projectId: string,
  ): Promise<ProjectDashboardSnapshot | null> {
    const result =
      await this.databaseService.query<ProjectDashboardSnapshotRow>(
        `
          SELECT *
          FROM projects.project_dashboard_snapshots
          WHERE project_id = $1
          ORDER BY created_at DESC
          LIMIT 1;
        `,
        [projectId],
      );

    const row = result.rows[0];
    return row ? this.toSnapshot(row) : null;
  }

  private toSnapshot(
    row: ProjectDashboardSnapshotRow,
  ): ProjectDashboardSnapshot {
    const summary =
      typeof row.summary_json === 'string'
        ? (JSON.parse(row.summary_json) as Record<string, unknown>)
        : row.summary_json;
    const findings =
      typeof row.findings_json === 'string'
        ? (JSON.parse(row.findings_json) as ProjectDashboardSnapshotFinding[])
        : row.findings_json;

    return {
      id: row.id,
      projectId: row.project_id,
      status: row.status,
      summary,
      findings,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      createdBy: row.created_by,
      createdAt: row.created_at,
    };
  }
}
