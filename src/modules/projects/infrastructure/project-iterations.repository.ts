import { Injectable } from '@nestjs/common';

import { DatabaseService } from '#kernel/db/database.service';

export type ProjectIterationStatus = 'active' | 'delivered';

/**
 * A Project's unit of work (projects.project_iterations). Timestamps are typed
 * as strings like every other row in this context; pg hands back Dates and the
 * service renders both through `new Date(...)`.
 */
export interface ProjectIterationRow {
  id: string;
  delivery_project_id: string;
  number: number;
  goal: string | null;
  status: ProjectIterationStatus;
  started_at: string;
  started_by: string | null;
  started_by_login: string | null;
  delivered_at: string | null;
  delivered_by: string | null;
  delivered_by_login: string | null;
  /** The APPROVED run that was delivered (phase 2). */
  signoff_run_id: string | null;
  /** Per-repository delivery state (phase 2); null until delivered. */
  delivery_json: unknown;
}

/**
 * Persistence for Project Iterations. Phase 1 only reads them and creates the
 * first one lazily; the delivered transition (phase 2) and "start the next"
 * (phase 3) add their writes here, next to the same unique keys:
 * (delivery_project_id, number) and at most one `active` per Project.
 */
@Injectable()
export class ProjectIterationsRepository {
  constructor(private readonly databaseService: DatabaseService) {}

  async findById(id: string): Promise<ProjectIterationRow | null> {
    const result = await this.databaseService.query<ProjectIterationRow>(
      `SELECT * FROM projects.project_iterations WHERE id = $1;`,
      [id],
    );
    return result.rows[0] ?? null;
  }

  /**
   * The Project's current Iteration: its active one, else (between delivery
   * and the next start) the latest delivered one. Null when it has none yet.
   */
  async findCurrent(
    deliveryProjectId: string,
  ): Promise<ProjectIterationRow | null> {
    const result = await this.databaseService.query<ProjectIterationRow>(
      `
        SELECT * FROM projects.project_iterations
        WHERE delivery_project_id = $1
        ORDER BY (status = 'active') DESC, number DESC
        LIMIT 1;
      `,
      [deliveryProjectId],
    );
    return result.rows[0] ?? null;
  }

  /** Newest first. */
  async list(deliveryProjectId: string): Promise<ProjectIterationRow[]> {
    const result = await this.databaseService.query<ProjectIterationRow>(
      `
        SELECT * FROM projects.project_iterations
        WHERE delivery_project_id = $1
        ORDER BY number DESC;
      `,
      [deliveryProjectId],
    );
    return result.rows;
  }

  /**
   * Creates "Iteration 1" for a Project that has no Iteration at all. One
   * statement, race-safe: a concurrent creator hits the unique
   * (delivery_project_id, number) key and this inserts nothing.
   */
  async insertFirstIfNone(
    deliveryProjectIds: readonly string[],
  ): Promise<void> {
    if (deliveryProjectIds.length === 0) {
      return;
    }
    await this.databaseService.query(
      `
        INSERT INTO projects.project_iterations (delivery_project_id, number, status)
        SELECT p.id, 1, 'active'
        FROM unnest($1::uuid[]) AS p(id)
        WHERE NOT EXISTS (
          SELECT 1 FROM projects.project_iterations i
          WHERE i.delivery_project_id = p.id
        )
        ON CONFLICT DO NOTHING;
      `,
      [deliveryProjectIds],
    );
  }

  /**
   * The current Iteration of each Project in ONE query (same rule as
   * findCurrent). A Project with no Iteration is absent.
   */
  async findCurrentByDeliveryProjects(
    deliveryProjectIds: readonly string[],
  ): Promise<Map<string, ProjectIterationRow>> {
    const map = new Map<string, ProjectIterationRow>();
    if (deliveryProjectIds.length === 0) {
      return map;
    }
    const result = await this.databaseService.query<ProjectIterationRow>(
      `
        SELECT DISTINCT ON (delivery_project_id) *
        FROM projects.project_iterations
        WHERE delivery_project_id = ANY($1::uuid[])
        ORDER BY delivery_project_id, (status = 'active') DESC, number DESC;
      `,
      [deliveryProjectIds],
    );
    for (const row of result.rows) {
      map.set(row.delivery_project_id, row);
    }
    return map;
  }
}
