import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import {
  AuditEventPublisher,
  NotificationEventPublisher,
} from '#kernel/events/platform-event-publisher.js';
import type { ProjectIterationRow } from '../../infrastructure/project-iterations.repository';
import type { StartedIteration } from '../qa-checklists/project-iterations.contracts';
import {
  iterationActive,
  iterationCarryInvalid,
  iterationGoalInvalid,
  iterationStartForbidden,
} from '../qa-checklists/project-iterations.errors';
import { ProjectIterationsService } from '../qa-checklists/project-iterations.service';
import { QaAccessService } from '../qa-checklists/qa-access.service';
import {
  QaProjectContextService,
  type QaProjectContext,
} from '../qa-checklists/qa-project-context.service';
import type { QaRunActorContext } from './qa-runs.contracts';

/** The audit event (and notification code) recorded once, when an Iteration is started. */
export const QA_ITERATION_STARTED_EVENT = 'qa.iteration.started';

/** Same cap as the column CHECK (project_iterations_goal_length_chk). */
export const ITERATION_GOAL_MAX_LENGTH = 120;
const NOTIFICATION_BODY_TRUNCATE_LENGTH = 300;

export interface StartIterationInput {
  goal?: string | null;
  carryOver?: { requirementItemIds?: string[] };
}

interface StartResult {
  iteration: ProjectIterationRow;
  carriedRequirements: number;
  carriedItems: number;
}

/**
 * "Start the next iteration" (ITERATIONS_PLAN.md D2, D5, P2, P13). Lead and
 * admin only; allowed only once the Project's latest Iteration is delivered.
 * The new Iteration and its carried requirements and items are created in one
 * transaction by the repository; the unique one-active-per-Project index makes
 * a double click or a race safe (the loser gets 409 ITERATION_ACTIVE).
 */
@Injectable()
export class ProjectIterationStartService {
  private readonly logger = new Logger(ProjectIterationStartService.name);

  constructor(
    private readonly access: QaAccessService,
    private readonly projectContext: QaProjectContextService,
    private readonly iterations: ProjectIterationsService,
    // Explicit tokens: a type alias erases to `Object` in design:paramtypes, so
    // without @Inject(ConcreteClass) Nest resolves no provider and @Optional()
    // silently injects undefined -- see tests/architecture/http-boot.spec.ts.
    @Optional()
    @Inject(AuditEventPublisher)
    private readonly auditEventsService?: AuditEventPublisher,
    @Optional()
    @Inject(NotificationEventPublisher)
    private readonly notificationEventsService?: NotificationEventPublisher,
  ) {}

  /** POST /delivery-projects/:id/iterations */
  async start(
    deliveryProjectId: string,
    actor: QaRunActorContext,
    input: StartIterationInput,
  ): Promise<StartedIteration> {
    // 404 for a non-member before 403 for a member who may not start.
    const project = await this.projectContext.requireProject(
      deliveryProjectId,
      actor.userId,
    );
    if (!(await this.access.canManage(actor.userId))) {
      throw iterationStartForbidden();
    }
    const goal = this.normalizeGoal(input.goal);

    const source =
      await this.iterations.ensureActiveIteration(deliveryProjectId);
    if (source.status === 'active') {
      throw iterationActive(source.number);
    }

    const itemIds = await this.validateCarryOver(
      source,
      input.carryOver?.requirementItemIds ?? [],
    );
    const result = await this.iterations.startNext({
      source,
      startedBy: actor.userId,
      startedByLogin: actor.userLogin,
      goal,
      itemIds,
    });

    await this.announce(project, result, goal, actor);
    return {
      iteration: this.iterations.toIteration(result.iteration),
      carriedRequirements: result.carriedRequirements,
      carriedItems: result.carriedItems,
    };
  }

  private normalizeGoal(goal: string | null | undefined): string | null {
    const trimmed = (goal ?? '').trim();
    if (trimmed.length > ITERATION_GOAL_MAX_LENGTH) {
      throw iterationGoalInvalid();
    }
    return trimmed === '' ? null : trimmed;
  }

  /**
   * Every id must be an item of an active requirement of the latest delivered
   * Iteration (which is `source`). Duplicates collapse; anything else, from
   * another Project, an older Iteration or an archived requirement, is
   * rejected as a whole with the offending ids.
   */
  private async validateCarryOver(
    source: ProjectIterationRow,
    requested: readonly string[],
  ): Promise<string[]> {
    const unique = [...new Set(requested)];
    if (unique.length === 0) {
      return [];
    }
    const candidates = await this.iterations.carryOverCandidates(source);
    const valid = new Set(
      (candidates?.requirements ?? []).flatMap((requirement) =>
        requirement.items.map((item) => item.id),
      ),
    );
    const invalid = unique.filter((id) => !valid.has(id));
    if (invalid.length > 0) {
      throw iterationCarryInvalid(invalid);
    }
    return unique;
  }

  // ---------------------------------------------------------------------
  // Audit + notifications
  // ---------------------------------------------------------------------

  private async announce(
    project: QaProjectContext,
    result: StartResult,
    goal: string | null,
    actor: QaRunActorContext,
  ): Promise<void> {
    // The Iteration is already started; a failure here must not turn that
    // committed change into an error for the caller.
    try {
      const anchor = await this.projectContext.anchorProjectId(project);
      const { iteration } = result;
      await this.auditEventsService?.recordProjectEvent({
        workspaceId: project.groupId,
        projectId: anchor,
        actorUserId: actor.userId,
        eventCode: QA_ITERATION_STARTED_EVENT,
        message: `Iteration ${String(iteration.number)} of Project "${project.name}" was started`,
        metadata: {
          deliveryProjectId: project.deliveryProjectId,
          iterationId: iteration.id,
          number: iteration.number,
          carriedItems: result.carriedItems,
          carriedRequirements: result.carriedRequirements,
        },
      });
      await this.notifyTeam(project, iteration, result, goal, actor, anchor);
    } catch (error) {
      this.logger.warn(
        `Iteration ${result.iteration.id} was started but announcing it failed: ${String(error)}`,
      );
    }
  }

  /** The Project's Developers (and leads) and QA, excluding the actor. */
  private async notifyTeam(
    project: QaProjectContext,
    iteration: ProjectIterationRow,
    result: StartResult,
    goal: string | null,
    actor: QaRunActorContext,
    anchor: string | null,
  ): Promise<void> {
    const notifications = this.notificationEventsService;
    if (!notifications || !anchor) {
      return;
    }
    const [leadsAndDevelopers, qa] = await Promise.all([
      this.access.listWorkspaceLeadAndDeveloperIds(project.groupId),
      this.access.listWorkspaceQaIds(project.groupId),
    ]);
    const recipients = new Set(
      [...leadsAndDevelopers, ...qa].filter((id) => id !== actor.userId),
    );
    if (recipients.size === 0) {
      return;
    }
    const carried =
      result.carriedItems === 1
        ? '1 item carried over'
        : `${String(result.carriedItems)} items carried over`;
    const body = this.truncate(
      goal ? `Goal: ${goal}. ${carried}.` : `${carried}.`,
      NOTIFICATION_BODY_TRUNCATE_LENGTH,
    );
    await Promise.all(
      [...recipients].map((userId) =>
        notifications.record({
          userId,
          projectId: anchor,
          eventCode: QA_ITERATION_STARTED_EVENT,
          title: `Iteration ${String(iteration.number)} of ${project.name} started`,
          body,
        }),
      ),
    );
  }

  private truncate(value: string, max: number): string {
    return value.length > max ? `${value.slice(0, max)}...` : value;
  }
}
