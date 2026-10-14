import { Injectable } from '@nestjs/common';

import {
  canStartNextIteration,
  isIterationWritable,
} from '../../domain/project-iteration.rules';
import {
  ProjectIterationsRepository,
  type ProjectIterationRow,
} from '../../infrastructure/project-iterations.repository';
import type {
  DeliveredRepository,
  ProjectIteration,
  ProjectIterationCurrent,
  ProjectIterationList,
  ProjectIterationRef,
} from './project-iterations.contracts';
import {
  iterationDelivered,
  iterationNotFound,
} from './project-iterations.errors';
import { QaAccessService } from './qa-access.service';
import { QaProjectContextService } from './qa-project-context.service';

/** The only fields a write guard needs; run and requirement rows carry the id. */
type HasIteration = { iteration_id: string | null };

/**
 * Project Iterations (ITERATIONS_PLAN.md). A Project's requirements and
 * Project-scope QA runs belong to one Iteration; at most one is `active`.
 *
 * Every Project-scoped reader and writer resolves the Iteration here, once per
 * call, and passes `iterationId` down to the repositories (P3). There is
 * deliberately no cross-request cache: an Iteration's status can change at any
 * time (delivery, phase 2), and one indexed read is cheaper than a stale guard.
 *
 * Phase 1 creates "Iteration 1" lazily, on first use, because Projects are
 * created in another context (identity-access). The migration already gave
 * every existing Project one.
 */
@Injectable()
export class ProjectIterationsService {
  constructor(
    private readonly iterations: ProjectIterationsRepository,
    private readonly access: QaAccessService,
    private readonly projectContext: QaProjectContextService,
  ) {}

  // ---------------------------------------------------------------------
  // Resolution (used by every Project-scoped reader and writer)
  // ---------------------------------------------------------------------

  /**
   * The Project's current Iteration, created as "Iteration 1" when it has none
   * (idempotent, race-safe). It is the ACTIVE one; between delivery and the
   * next start it is the latest DELIVERED one, which reads still show and the
   * guard still refuses writes against. No authorization: callers have already
   * resolved the Project through QaProjectContextService.
   */
  async ensureActiveIteration(
    deliveryProjectId: string,
  ): Promise<ProjectIterationRow> {
    const existing = await this.iterations.findCurrent(deliveryProjectId);
    if (existing) {
      return existing;
    }
    await this.iterations.insertFirstIfNone([deliveryProjectId]);
    const created = await this.iterations.findCurrent(deliveryProjectId);
    if (!created) {
      throw new Error(
        `Could not create Iteration 1 for Project ${deliveryProjectId}`,
      );
    }
    return created;
  }

  /** ensureActiveIteration for many Projects, in at most three queries. */
  async ensureForProjects(
    deliveryProjectIds: readonly string[],
  ): Promise<Map<string, ProjectIterationRow>> {
    const found =
      await this.iterations.findCurrentByDeliveryProjects(deliveryProjectIds);
    const missing = deliveryProjectIds.filter((id) => !found.has(id));
    if (missing.length === 0) {
      return found;
    }
    await this.iterations.insertFirstIfNone(missing);
    return this.iterations.findCurrentByDeliveryProjects(deliveryProjectIds);
  }

  /** Read-only: a Project that has no Iteration yet is absent (it has no requirements either). */
  findCurrentForProjects(
    deliveryProjectIds: readonly string[],
  ): Promise<Map<string, ProjectIterationRow>> {
    return this.iterations.findCurrentByDeliveryProjects(deliveryProjectIds);
  }

  async findRef(iterationId: string): Promise<ProjectIterationRef | null> {
    const row = await this.iterations.findById(iterationId);
    return row ? this.toRef(row) : null;
  }

  toRef(
    row: Pick<ProjectIterationRow, 'id' | 'number' | 'status'>,
  ): ProjectIterationRef {
    return { id: row.id, number: row.number, status: row.status };
  }

  // ---------------------------------------------------------------------
  // The iteration guard (P8)
  // ---------------------------------------------------------------------

  /** 409 ITERATION_DELIVERED unless the Iteration is active. */
  assertWritable(
    iteration: Pick<ProjectIterationRow, 'number' | 'status'>,
  ): void {
    if (!isIterationWritable(iteration.status)) {
      throw iterationDelivered(iteration.number);
    }
  }

  /**
   * The same guard for a row that carries its own Iteration (a requirement or
   * a Project run): the row's Iteration decides, not the Project's current one,
   * so a run of a delivered Iteration stays read-only after the next one
   * starts. A row with no Iteration (an unassigned legacy checklist) is not
   * Project-scoped and is never guarded.
   */
  async assertRowWritable(row: HasIteration): Promise<void> {
    if (row.iteration_id === null) {
      return;
    }
    const iteration = await this.iterations.findById(row.iteration_id);
    if (!iteration) {
      throw iterationNotFound();
    }
    this.assertWritable(iteration);
  }

  // ---------------------------------------------------------------------
  // API reads
  // ---------------------------------------------------------------------

  /** GET /delivery-projects/:id/iterations (404 for a non-member). */
  async listForProject(
    deliveryProjectId: string,
    userId: string,
  ): Promise<ProjectIterationList> {
    await this.projectContext.requireProject(deliveryProjectId, userId);
    // Make sure a Project nobody has touched yet still lists "Iteration 1".
    await this.ensureActiveIteration(deliveryProjectId);
    const rows = await this.iterations.list(deliveryProjectId);
    return { iterations: rows.map((row) => this.toIteration(row)) };
  }

  /** GET /delivery-projects/:id/iterations/current (404 for a non-member). */
  async currentForProject(
    deliveryProjectId: string,
    userId: string,
  ): Promise<ProjectIterationCurrent> {
    await this.projectContext.requireProject(deliveryProjectId, userId);
    const iteration = await this.ensureActiveIteration(deliveryProjectId);
    return {
      iteration: this.toIteration(iteration),
      canStartNext: canStartNextIteration({
        mayManage: await this.access.canManage(userId),
        hasActiveIteration: iteration.status === 'active',
      }),
      deliveredRepositories: this.toDeliveredRepositories(iteration),
    };
  }

  // ---------------------------------------------------------------------
  // Mapping
  // ---------------------------------------------------------------------

  toIteration(row: ProjectIterationRow): ProjectIteration {
    return {
      ...this.toRef(row),
      deliveryProjectId: row.delivery_project_id,
      goal: row.goal,
      startedAt: toIso(row.started_at),
      startedBy: row.started_by_login
        ? { id: row.started_by, login: row.started_by_login }
        : null,
      deliveredAt: row.delivered_at ? toIso(row.delivered_at) : null,
      deliveredBy: row.delivered_by_login
        ? { id: row.delivered_by, login: row.delivered_by_login }
        : null,
      signoffRunId: row.signoff_run_id,
    };
  }

  /** `delivery_json` is written by phase 2; anything that is not a list reads as "none". */
  private toDeliveredRepositories(
    row: ProjectIterationRow,
  ): DeliveredRepository[] {
    if (row.status !== 'delivered' || !Array.isArray(row.delivery_json)) {
      return [];
    }
    return (row.delivery_json as DeliveredRepository[]).map((entry) => ({
      projectId: entry.projectId,
      repoFullName: entry.repoFullName,
      uatHeadSha: entry.uatHeadSha,
      mergeSha: entry.mergeSha ?? null,
      prNumber: entry.prNumber ?? null,
      how: entry.how,
    }));
  }
}

function toIso(value: string | Date): string {
  return new Date(value).toISOString();
}
