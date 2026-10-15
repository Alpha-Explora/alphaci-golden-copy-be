import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import { QA_PROMOTION_TARGET_BRANCH } from '#kernel/config/pipeline-branches';
import {
  AuditEventPublisher,
  NotificationEventPublisher,
} from '#kernel/events/platform-event-publisher.js';
import {
  GITHUB_PROJECT_PORT,
  type GithubProjectPort,
} from '#kernel/ports/github.port';
import {
  coveredRepositoriesOf,
  deliveryEntryFor,
  describeCovered,
  isDeliveryComplete,
  mainContainsHead,
  parseDeliveryEntries,
  type RunCoverageRepository,
} from '../../domain/project-delivery.rules';
import {
  evaluateProjectPromotionGate,
  type QaProjectGateResult,
} from '../../domain/qa-promotion.rules';
import { canMergeQaPromotion } from '../../domain/qa-run-access.rules';
import type { ProjectIterationRow } from '../../infrastructure/project-iterations.repository';
import {
  QaProjectRunsRepository,
  type QaProjectLatestSignoff,
} from '../../infrastructure/qa-project-runs.repository';
import { QaRequirementsRepository } from '../../infrastructure/qa-requirements.repository';
import type {
  DeliveredRepository,
  ProjectIterationCurrent,
} from '../qa-checklists/project-iterations.contracts';
import { ProjectIterationsService } from '../qa-checklists/project-iterations.service';
import { QaAccessService } from '../qa-checklists/qa-access.service';
import {
  QaProjectContextService,
  type QaProjectContext,
  type QaProjectRepository,
} from '../qa-checklists/qa-project-context.service';
import type { QaRunActorContext } from './qa-runs.contracts';
import { QaUatHeadsService } from './qa-uat-heads.service';

/** The audit event (and notification code) recorded once, when an Iteration is delivered. */
export const QA_ITERATION_DELIVERED_EVENT = 'qa.iteration.delivered';

const NOTIFICATION_BODY_TRUNCATE_LENGTH = 300;
/** `iterations/current` is a display path: reuse a head reading this young. */
const DISPLAY_HEADS_MAX_AGE_MS = 30_000;

/** The Merge to main gate for a whole Project, with what it was computed from. */
export interface ProjectGateEvaluation {
  iteration: ProjectIterationRow;
  /** The Iteration's active requirements (id and name are what the promotion PR lists). */
  requirements: Array<{ id: string; name: string }>;
  latest: QaProjectLatestSignoff | null;
  gate: QaProjectGateResult;
  /** The repositories the signed-off run covered that are still in the Project; [] without a run. */
  covered: RunCoverageRepository[];
}

export interface DeliverySettleInput {
  project: QaProjectContext;
  /** The ACTIVE Iteration the gate was evaluated for. */
  iteration: ProjectIterationRow;
  runId: string;
  covered: readonly RunCoverageRepository[];
  actor: QaRunActorContext;
  /** The repository this call just delivered, if any. */
  entry: DeliveredRepository | null;
  /** Also check whether the OTHER covered repositories already have the head in main. */
  probeOthers: boolean;
}

export interface DeliverySettleResult {
  /** The Iteration as stored after this call. */
  iteration: ProjectIterationRow;
  /** True only for the one caller whose UPDATE made the Iteration Delivered. */
  deliveredNow: boolean;
}

/**
 * Delivery of a Project's Iteration (ITERATIONS_PLAN.md P4-P7, D1): the Merge
 * to main gate for the whole Project, the incremental per-repository state and
 * the atomic Delivered transition.
 *
 * The transition is a single `UPDATE ... WHERE status = 'active'`; only the
 * caller whose UPDATE returns the row records the audit event and notifies, so
 * a double click or two merges finishing together deliver and announce once.
 */
@Injectable()
export class QaProjectDeliveryService {
  private readonly logger = new Logger(QaProjectDeliveryService.name);

  constructor(
    private readonly access: QaAccessService,
    private readonly projectContext: QaProjectContextService,
    private readonly requirements: QaRequirementsRepository,
    private readonly projectRuns: QaProjectRunsRepository,
    private readonly heads: QaUatHeadsService,
    private readonly iterations: ProjectIterationsService,
    @Inject(GITHUB_PROJECT_PORT)
    private readonly githubService: GithubProjectPort,
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

  // ---------------------------------------------------------------------
  // The gate
  // ---------------------------------------------------------------------

  /**
   * evaluateProjectPromotionGate for the Project's current Iteration: its
   * requirements, its latest signed-off run and every repository's uat head.
   * `maxAgeMs` lets a display path reuse a recent head reading; the merge
   * paths always read fresh.
   */
  async evaluateGate(
    deliveryProjectId: string,
    repositories: readonly QaProjectRepository[],
    actor: QaRunActorContext,
    options: { maxAgeMs?: number } = {},
  ): Promise<ProjectGateEvaluation> {
    const iteration =
      await this.iterations.ensureActiveIteration(deliveryProjectId);
    const [readings, requirementRows, latest] = await Promise.all([
      this.heads.readHeads(
        repositories,
        actor,
        options.maxAgeMs ? { maxAgeMs: options.maxAgeMs } : {},
      ),
      this.requirements.listActiveByIteration(iteration.id),
      this.projectRuns.findLatestSignedOff(iteration.id),
    ]);
    const [itemsNotPassed, requirementsChangedAfterSignoff] = latest
      ? await Promise.all([
          this.projectRuns.countIterationItemsNotPassed(
            iteration.id,
            latest.run.id,
          ),
          this.requirements.requirementsChangedSince(
            iteration.id,
            latest.signoff.signed_at,
          ),
        ])
      : [0, false];

    const gate = evaluateProjectPromotionGate({
      repositories: readings.map((reading) => ({
        projectId: reading.repository.projectId,
        repoFullName: reading.repository.repoFullName,
        currentSha: reading.kind === 'ok' ? reading.sha : null,
      })),
      requirementCount: requirementRows.length,
      latestSignedOffRun: latest
        ? {
            id: latest.run.id,
            verdict: latest.signoff.verdict,
            signedAt: latest.signoff.signed_at,
            coverage: latest.repositories.map((row) => ({
              projectId: row.project_id,
              headSha: row.head_sha,
            })),
          }
        : null,
      itemsNotPassed,
      requirementsChangedAfterSignoff,
    });

    return {
      iteration,
      requirements: requirementRows.map((row) => ({
        id: row.id,
        name: row.name,
      })),
      latest,
      gate,
      covered: latest
        ? coveredRepositoriesOf(
            latest.repositories.map((row) => ({
              projectId: row.project_id,
              repoFullName: row.repo_full_name,
              headSha: row.head_sha,
            })),
            new Set(repositories.map((repository) => repository.projectId)),
          )
        : [],
    };
  }

  // ---------------------------------------------------------------------
  // GET /delivery-projects/:id/iterations/current
  // ---------------------------------------------------------------------

  async current(
    deliveryProjectId: string,
    actor: QaRunActorContext,
  ): Promise<ProjectIterationCurrent> {
    const project = await this.projectContext.requireProject(
      deliveryProjectId,
      actor.userId,
    );
    const iteration =
      await this.iterations.ensureActiveIteration(deliveryProjectId);
    const base = await this.iterations.describeCurrent(iteration, actor.userId);
    const entries = this.iterations.toDeliveredRepositories(iteration);

    // A delivered Iteration is a frozen record: what it covered is what it stored.
    if (iteration.status === 'delivered') {
      return {
        ...base,
        coveredRepositories: entries.map((entry) => ({
          projectId: entry.projectId,
          repoFullName: entry.repoFullName,
          delivered: true,
          how: entry.how,
        })),
        canMergeAll: false,
      };
    }

    const latest = await this.projectRuns.findLatestSignedOff(iteration.id);
    if (latest?.signoff.verdict !== 'APPROVED') {
      return { ...base, coveredRepositories: [], canMergeAll: false };
    }
    const covered = coveredRepositoriesOf(
      latest.repositories.map((row) => ({
        projectId: row.project_id,
        repoFullName: row.repo_full_name,
        headSha: row.head_sha,
      })),
      new Set(project.repositories.map((repository) => repository.projectId)),
    );
    const coveredRepositories = describeCovered(covered, entries, 'active');

    // The gate reads every uat head on GitHub: only worth it for a caller who
    // could act on it, and from the short-lived display cache.
    let canMergeAll = false;
    if (
      covered.length > 0 &&
      canMergeQaPromotion(await this.access.findAppRole(actor.userId))
    ) {
      const evaluation = await this.evaluateGate(
        deliveryProjectId,
        project.repositories,
        actor,
        { maxAgeMs: DISPLAY_HEADS_MAX_AGE_MS },
      );
      canMergeAll = evaluation.gate.eligible;
    }
    return { ...base, coveredRepositories, canMergeAll };
  }

  // ---------------------------------------------------------------------
  // GitHub: is the head already in main?
  // ---------------------------------------------------------------------

  /**
   * Does `main` already contain the signed-off uat head? Anything GitHub cannot
   * answer (a missing ref, an error) reads as "no": delivery is then decided
   * by an actual merge instead of a guess.
   */
  async mainContainsHead(
    token: string,
    repoFullName: string,
    headSha: string,
  ): Promise<boolean> {
    try {
      // base = the uat head, head = main: `ahead` or `identical` means main
      // has everything the uat head has (see mainContainsHead in the rules).
      return mainContainsHead(
        await this.githubService.getBranchRelation(
          token,
          repoFullName,
          headSha,
          QA_PROMOTION_TARGET_BRANCH,
        ),
      );
    } catch (error) {
      this.logger.warn(
        `Could not compare ${headSha.slice(0, 7)} with ${QA_PROMOTION_TARGET_BRANCH} in ${repoFullName}: ${String(error)}`,
      );
      return false;
    }
  }

  // ---------------------------------------------------------------------
  // Record + deliver
  // ---------------------------------------------------------------------

  /**
   * Records this call's delivered repository, optionally discovers the other
   * repositories whose main already holds the head, and delivers the
   * Iteration when every covered repository is in. Safe to call twice.
   */
  async settle(input: DeliverySettleInput): Promise<DeliverySettleResult> {
    let row = input.iteration;
    if (input.entry) {
      const updated = await this.iterations.recordRepositoryDelivery(
        row.id,
        input.entry,
      );
      row = updated ?? (await this.iterations.findRow(row.id)) ?? row;
    }
    if (row.status === 'delivered') {
      return { iteration: row, deliveredNow: false };
    }
    if (input.probeOthers) {
      row = await this.recordAlreadyInMain(input, row);
    }
    return this.deliverIfComplete(input, row);
  }

  private async recordAlreadyInMain(
    input: DeliverySettleInput,
    start: ProjectIterationRow,
  ): Promise<ProjectIterationRow> {
    const entries = parseDeliveryEntries(start.delivery_json);
    const missing = input.covered.filter(
      (repository) => !deliveryEntryFor(entries, repository, 'active'),
    );
    const found = (
      await Promise.all(
        missing.map(async (repository) => {
          const token = await this.heads.resolveReadToken(
            repository.repoFullName,
            input.actor.userId,
            input.actor.oauthToken,
          );
          return token &&
            (await this.mainContainsHead(
              token,
              repository.repoFullName,
              repository.headSha,
            ))
            ? repository
            : null;
        }),
      )
    ).filter((repository) => repository !== null);

    let row = start;
    for (const repository of found) {
      const updated = await this.iterations.recordRepositoryDelivery(row.id, {
        projectId: repository.projectId,
        repoFullName: repository.repoFullName,
        uatHeadSha: repository.headSha,
        mergeSha: null,
        prNumber: null,
        how: 'already_in_main',
        at: new Date().toISOString(),
      });
      if (!updated) {
        // Delivered by a concurrent caller in the meantime.
        return (await this.iterations.findRow(row.id)) ?? row;
      }
      row = updated;
    }
    return row;
  }

  private async deliverIfComplete(
    input: DeliverySettleInput,
    row: ProjectIterationRow,
  ): Promise<DeliverySettleResult> {
    const entries = parseDeliveryEntries(row.delivery_json);
    if (!isDeliveryComplete(input.covered, entries, 'active')) {
      return { iteration: row, deliveredNow: false };
    }
    const repositories = input.covered.flatMap((repository) => {
      const entry = deliveryEntryFor(entries, repository, 'active');
      return entry ? [entry] : [];
    });

    const won = await this.iterations.markDelivered(row.id, {
      deliveredBy: input.actor.userId,
      deliveredByLogin: input.actor.userLogin,
      signoffRunId: input.runId,
      repositories,
    });
    if (!won) {
      // Another caller delivered it first: it records and notifies, not us.
      return {
        iteration: (await this.iterations.findRow(row.id)) ?? row,
        deliveredNow: false,
      };
    }
    await this.announce(input.project, won, repositories, input.actor);
    return { iteration: won, deliveredNow: true };
  }

  // ---------------------------------------------------------------------
  // Audit + notifications (winner of the transition only)
  // ---------------------------------------------------------------------

  private async announce(
    project: QaProjectContext,
    iteration: ProjectIterationRow,
    repositories: readonly DeliveredRepository[],
    actor: QaRunActorContext,
  ): Promise<void> {
    // The Iteration is already Delivered; a failure here must not turn that
    // committed change into an error for the caller.
    try {
      const anchor = await this.projectContext.anchorProjectId(project);
      await this.auditEventsService?.recordProjectEvent({
        workspaceId: project.groupId,
        projectId: anchor,
        actorUserId: actor.userId,
        eventCode: QA_ITERATION_DELIVERED_EVENT,
        message: `Iteration ${String(iteration.number)} of Project "${project.name}" was delivered`,
        metadata: {
          deliveryProjectId: project.deliveryProjectId,
          iterationId: iteration.id,
          number: iteration.number,
          signoffRunId: iteration.signoff_run_id,
          repositories: repositories.map((repository) => ({ ...repository })),
        },
      });
      await this.notifyTeam(project, iteration, repositories, actor, anchor);
    } catch (error) {
      this.logger.warn(
        `Iteration ${iteration.id} was delivered but announcing it failed: ${String(error)}`,
      );
    }
  }

  private async notifyTeam(
    project: QaProjectContext,
    iteration: ProjectIterationRow,
    repositories: readonly DeliveredRepository[],
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
    const names = repositories
      .map((repository) => repository.repoFullName)
      .join(', ');
    const body = this.truncate(
      `Now on main: ${names}.`,
      NOTIFICATION_BODY_TRUNCATE_LENGTH,
    );
    await Promise.all(
      [...recipients].map((userId) =>
        notifications.record({
          userId,
          projectId: anchor,
          eventCode: QA_ITERATION_DELIVERED_EVENT,
          title: `Iteration ${String(iteration.number)} of ${project.name} was delivered`,
          body,
        }),
      ),
    );
  }

  private truncate(value: string, max: number): string {
    return value.length > max ? `${value.slice(0, max)}…` : value;
  }
}
