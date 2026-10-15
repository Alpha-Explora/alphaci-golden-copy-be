import { Injectable } from '@nestjs/common';

import { DatabaseService } from '#kernel/db/database.service';

export type ProjectIterationStatus = 'active' | 'delivered';

/** Postgres unique_violation: a concurrent start (one active per Project, or the same number). */
export const ITERATION_UNIQUE_VIOLATION = '23505';

export interface StartNextIterationInput {
  deliveryProjectId: string;
  startedBy: string;
  startedByLogin: string;
  goal: string | null;
}

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
 * Persistence for Project Iterations: reads, the lazily created first one, the
 * incremental per-repository delivery record and the atomic Delivered
 * transition (phase 2). "Start the next" (phase 3) adds its write here, next to
 * the same unique keys: (delivery_project_id, number) and at most one `active`
 * per Project.
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

  /**
   * Records one repository as delivered inside `delivery_json`, in ONE
   * statement so two merges finishing together cannot lose each other's entry
   * (the row lock serializes them and the second re-reads the first's json).
   *
   * An entry for the same repository and the same uat head is kept as it is
   * (the first "how" wins: a later "already in main" must not overwrite
   * "merged"); an entry for an OLDER head of the repository is replaced.
   * Returns the updated row, or null when the Iteration is no longer active.
   */
  async recordRepositoryDelivery(
    iterationId: string,
    entry: { projectId: string; uatHeadSha: string },
  ): Promise<ProjectIterationRow | null> {
    const result = await this.databaseService.query<ProjectIterationRow>(
      `
        UPDATE projects.project_iterations i
        SET delivery_json = jsonb_build_object(
          'repositories',
          COALESCE(
            (
              SELECT jsonb_agg(e ORDER BY e->>'repoFullName')
              FROM jsonb_array_elements(
                COALESCE(i.delivery_json->'repositories', '[]'::jsonb)
              ) e
              WHERE NOT (e->>'projectId' = $2 AND e->>'uatHeadSha' <> $3)
            ),
            '[]'::jsonb
          )
          || CASE
            WHEN EXISTS (
              SELECT 1
              FROM jsonb_array_elements(
                COALESCE(i.delivery_json->'repositories', '[]'::jsonb)
              ) e
              WHERE e->>'projectId' = $2 AND e->>'uatHeadSha' = $3
            ) THEN '[]'::jsonb
            ELSE jsonb_build_array($4::jsonb)
          END
        )
        WHERE i.id = $1 AND i.status = 'active'
        RETURNING i.*;
      `,
      [iterationId, entry.projectId, entry.uatHeadSha, JSON.stringify(entry)],
    );
    return result.rows[0] ?? null;
  }

  /**
   * The atomic Delivered transition. `WHERE status = 'active'` makes it
   * idempotent: of any number of concurrent callers exactly ONE gets the row
   * back, and only that caller records the audit event and notifies (P7).
   */
  async markDelivered(
    iterationId: string,
    input: {
      deliveredBy: string;
      deliveredByLogin: string;
      signoffRunId: string;
      deliveryJson: unknown;
    },
  ): Promise<ProjectIterationRow | null> {
    const result = await this.databaseService.query<ProjectIterationRow>(
      `
        UPDATE projects.project_iterations
        SET status = 'delivered',
            delivered_at = NOW(),
            delivered_by = $2,
            delivered_by_login = $3,
            signoff_run_id = $4,
            delivery_json = $5::jsonb
        WHERE id = $1 AND status = 'active'
        RETURNING *;
      `,
      [
        iterationId,
        input.deliveredBy,
        input.deliveredByLogin,
        input.signoffRunId,
        JSON.stringify(input.deliveryJson),
      ],
    );
    return result.rows[0] ?? null;
  }

  // ---------------------------------------------------------------------
  // Start the next Iteration (phase 3)
  // ---------------------------------------------------------------------

  /**
   * Creates Iteration N+1, empty: every item of a delivered Iteration was
   * passed before it could merge (ITERATIONS_PLAN.md 6a), so nothing is
   * carried and the delivered rows are never touched. A concurrent second
   * start, or a start while an Iteration is active, raises a unique violation
   * (code 23505) from the partial unique index uq_project_iterations_one_active
   * or the (project, number) key; the caller maps it to 409 ITERATION_ACTIVE.
   */
  async startNext(
    input: StartNextIterationInput,
  ): Promise<ProjectIterationRow> {
    const created = await this.databaseService.query<ProjectIterationRow>(
      `
        INSERT INTO projects.project_iterations
          (delivery_project_id, number, status, goal, started_by, started_by_login)
        SELECT $1, COALESCE(MAX(number), 0) + 1, 'active', $2, $3, $4
        FROM projects.project_iterations
        WHERE delivery_project_id = $1
        RETURNING *;
      `,
      [
        input.deliveryProjectId,
        input.goal,
        input.startedBy,
        input.startedByLogin,
      ],
    );
    const iteration = created.rows[0];
    if (!iteration) {
      throw new Error('projects.project_iterations INSERT returned no row');
    }
    return iteration;
  }
}
