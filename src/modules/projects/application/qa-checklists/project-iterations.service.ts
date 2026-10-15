import { Injectable } from '@nestjs/common';

import { parseDeliveryEntries } from '../../domain/project-delivery.rules';
import {
  canStartNextIteration,
  isIterationWritable,
} from '../../domain/project-iteration.rules';
import {
  ITERATION_UNIQUE_VIOLATION,
  ProjectIterationsRepository,
  type ProjectIterationRow,
} from '../../infrastructure/project-iterations.repository';
import type {
  DeliveredRepository,
  ProjectIteration,
  ProjectIterationCurrentBase,
  ProjectIterationList,
  ProjectIterationRef,
} from './project-iterations.contracts';
import {
  iterationActive,
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

  /** GET /delivery-projects/:id/iterations/current, minus the delivery view (404 for a non-member). */
  async currentForProject(
    deliveryProjectId: string,
    userId: string,
  ): Promise<ProjectIterationCurrentBase> {
    await this.projectContext.requireProject(deliveryProjectId, userId);
    const iteration = await this.ensureActiveIteration(deliveryProjectId);
    return this.describeCurrent(iteration, userId);
  }

  /** The current Iteration with what only this service knows: start-next and the stored delivery state. */
  async describeCurrent(
    iteration: ProjectIterationRow,
    userId: string,
  ): Promise<ProjectIterationCurrentBase> {
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

  /** The stored per-repository delivery state, during both active and delivered. */
  toDeliveredRepositories(row: ProjectIterationRow): DeliveredRepository[] {
    return parseDeliveryEntries(row.delivery_json);
  }

  // ---------------------------------------------------------------------
  // Delivery writes (phase 2)
  // ---------------------------------------------------------------------

  /**
   * Records one repository as delivered in the still-active Iteration, atomic
   * against a concurrent record (see the repository). Null when the Iteration
   * is no longer active.
   */
  recordRepositoryDelivery(
    iterationId: string,
    entry: DeliveredRepository,
  ): Promise<ProjectIterationRow | null> {
    return this.iterations.recordRepositoryDelivery(iterationId, entry);
  }

  /**
   * The atomic Delivered transition: returns the row ONLY to the caller whose
   * UPDATE changed it, so only that caller audits and notifies.
   */
  markDelivered(
    iterationId: string,
    input: {
      deliveredBy: string;
      deliveredByLogin: string;
      signoffRunId: string;
      repositories: DeliveredRepository[];
    },
  ): Promise<ProjectIterationRow | null> {
    return this.iterations.markDelivered(iterationId, {
      deliveredBy: input.deliveredBy,
      deliveredByLogin: input.deliveredByLogin,
      signoffRunId: input.signoffRunId,
      deliveryJson: { repositories: input.repositories },
    });
  }

  /** The Iteration as it is stored right now (null when it is gone). */
  findRow(iterationId: string): Promise<ProjectIterationRow | null> {
    return this.iterations.findById(iterationId);
  }

  // ---------------------------------------------------------------------
  // Start the next Iteration
  // ---------------------------------------------------------------------

  /**
   * Creates the next Iteration, empty. The caller has checked access and that
   * `source` is the latest delivered Iteration. A unique violation (a
   * concurrent start) becomes 409 ITERATION_ACTIVE.
   */
  async startNext(input: {
    source: ProjectIterationRow;
    startedBy: string;
    startedByLogin: string;
    goal: string | null;
  }): Promise<ProjectIterationRow> {
    try {
      return await this.iterations.startNext({
        deliveryProjectId: input.source.delivery_project_id,
        startedBy: input.startedBy,
        startedByLogin: input.startedByLogin,
        goal: input.goal,
      });
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        (error as { code?: unknown }).code === ITERATION_UNIQUE_VIOLATION
      ) {
        // Lost the race: the winner's Iteration is the active one now.
        const winner = await this.iterations.findCurrent(
          input.source.delivery_project_id,
        );
        throw iterationActive(winner?.number ?? input.source.number + 1);
      }
      throw error;
    }
  }
}

function toIso(value: string | Date): string {
  return new Date(value).toISOString();
}
