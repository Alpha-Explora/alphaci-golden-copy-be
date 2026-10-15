import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';

import {
  QA_BRANCH,
  QA_PROMOTION_TARGET_BRANCH,
} from '#kernel/config/pipeline-branches';
import {
  AuditEventPublisher,
  NotificationEventPublisher,
} from '#kernel/events/platform-event-publisher.js';
import {
  GITHUB_PROJECT_PORT,
  type GithubProjectPort,
} from '#kernel/ports/github.port';
import { deliveryEntryFor } from '../../domain/project-delivery.rules';
import { canMergeQaPromotion } from '../../domain/qa-run-access.rules';
import { QaRequirementsRepository } from '../../infrastructure/qa-requirements.repository';
import type { ProvisionedProjectRow } from '../../infrastructure/projects.repository';
import type { DeliveredRepository } from '../qa-checklists/project-iterations.contracts';
import {
  iterationDelivered,
  projectHasNoRepositories,
} from '../qa-checklists/project-iterations.errors';
import { ProjectIterationsService } from '../qa-checklists/project-iterations.service';
import { QaAccessService } from '../qa-checklists/qa-access.service';
import {
  QaProjectContextService,
  type QaProjectContext,
  type QaProjectRepository,
} from '../qa-checklists/qa-project-context.service';
import { qaProjectRequired } from '../qa-checklists/qa-errors';
import { buildQaPromotionPullRequestBody } from './qa-promotion.pr-body';
import {
  QA_PROMOTION_MERGED_EVENT,
  type QaPromotionChecklist,
  type QaPromotionMergeAllRepositoryResult,
  type QaPromotionMergeAllResult,
  type QaPromotionMergePullRequestRef,
  type QaPromotionMergeResult,
  type QaPromotionPullRequestRef,
  type QaPromotionStatus,
} from './qa-promotion.contracts';
import {
  QaProjectDeliveryService,
  type ProjectGateEvaluation,
} from './qa-project-delivery.service';
import type { QaHeadStatus, QaRunActorContext } from './qa-runs.contracts';
import {
  QaUatHeadsService,
  type QaWriteCredential,
  type QaWriteVia,
} from './qa-uat-heads.service';

export type { QaRunActorContext };

type QaPromotionStatusCore = Omit<QaPromotionStatus, 'canMerge'>;

/** What the status was computed from, kept for the merge paths (null for an unfiled repository). */
interface StatusContext {
  folder: QaProjectContext;
  evaluation: ProjectGateEvaluation;
}

/** What asking GitHub to carry one repository's uat head to main came to. */
type RepositoryMergeOutcome =
  | {
      kind: 'merged';
      sha: string | null;
      message: string;
      pullRequest: QaPromotionMergePullRequestRef;
    }
  | { kind: 'already_in_main'; message: string }
  | {
      kind: 'failed';
      message: string;
      pullRequest: QaPromotionMergePullRequestRef | null;
    };

const ALREADY_IN_MAIN_MESSAGE = 'main already contains this commit';

/** The pull request we resolved to merge -- either found already open, or just created. */
interface ResolvedPullRequest {
  number: number;
  url: string;
  headSha: string;
}

type PullRequestResolution =
  | { kind: 'ok'; pr: ResolvedPullRequest }
  | { kind: 'refused'; message: string };

const NOTIFICATION_BODY_TRUNCATE_LENGTH = 300;
const UNFILED_REASON =
  'This repository is not filed under a Project; QA requirements belong to Projects';

/**
 * "Merge to main": the promotion gate (GET) and the merge action (POST) for
 * carrying a QA-approved uat commit to main.
 *
 * The gate is per PROJECT (docs/design/project-requirements.md, section 3): a
 * repository may merge only when the latest signed-off Project run is
 * Approved and still current for EVERY repository of its Project. A repository
 * filed under no Project is blocked (QA_PROJECT_REQUIRED on merge): it has no
 * requirements and no run.
 *
 * Reuses ProjectWorkspaceService.mergePullRequest's behaviour (return GitHub's
 * refusal text as merged:false; the write itself uses the GitHub App
 * installation token after every ALPHACI gate, the user's OAuth token only as
 * the fallback)
 * without depending on that service directly -- ProjectWorkspaceService
 * lives in a sibling application/workspace/ area with no shared module
 * boundary to this slice, and the flow here also needs the gate recheck and
 * PR discovery/creation woven in, which that service does not do.
 */
@Injectable()
export class QaPromotionService {
  constructor(
    private readonly access: QaAccessService,
    private readonly projectContext: QaProjectContextService,
    private readonly requirements: QaRequirementsRepository,
    private readonly heads: QaUatHeadsService,
    private readonly iterations: ProjectIterationsService,
    private readonly delivery: QaProjectDeliveryService,
    @Inject(GITHUB_PROJECT_PORT)
    private readonly githubService: GithubProjectPort,
    // Explicit token: a type alias erases to `Object` in design:paramtypes,
    // so without @Inject(ConcreteClass) Nest resolves no provider and
    // @Optional() silently injects undefined -- see
    // tests/architecture/http-boot.spec.ts.
    @Optional()
    @Inject(AuditEventPublisher)
    private readonly auditEventsService?: AuditEventPublisher,
    @Optional()
    @Inject(NotificationEventPublisher)
    private readonly notificationEventsService?: NotificationEventPublisher,
  ) {}

  async getStatus(
    projectId: string,
    actor: QaRunActorContext,
  ): Promise<QaPromotionStatus> {
    const project = await this.requireVisibleProject(projectId, actor.userId);
    const [{ status }, role] = await Promise.all([
      this.computeStatus(project, actor),
      this.access.findAppRole(actor.userId),
    ]);
    return { ...status, canMerge: canMergeQaPromotion(role) };
  }

  async merge(
    projectId: string,
    actor: QaRunActorContext,
  ): Promise<QaPromotionMergeResult> {
    const project = await this.requireVisibleProject(projectId, actor.userId);

    const role = await this.access.findAppRole(actor.userId);
    if (!canMergeQaPromotion(role)) {
      throw new ForbiddenException(
        'Only a lead or admin may merge uat to main.',
      );
    }

    // Recomputed here, never trusted from a prior GET: the frontend cannot
    // be relied on to have called GET moments before, and even if it did,
    // uat may have moved since.
    const { status, context } = await this.computeStatus(project, actor);
    if (status.scope === 'unfiled' || !context) {
      throw qaProjectRequired();
    }
    // A delivered Iteration is closed: the code is already on main.
    if (context.evaluation.iteration.status === 'delivered') {
      throw iterationDelivered(context.evaluation.iteration.number);
    }
    if (!status.eligible) {
      throw new ConflictException({
        code: 'QA_PROMOTION_BLOCKED',
        message: 'QA promotion is not eligible yet.',
        reasons: status.reasons,
      });
    }
    // Guaranteed non-null: eligible only becomes true when every head, this
    // repository's included, was read.
    const headSha = status.headSha as string;

    // Every gate above has passed. The GitHub writes below (promotion PR,
    // merge) go out as the ALPHACI GitHub App: the org default permission is
    // read, so a lead's own OAuth token cannot merge. The person's token is
    // only the fallback; the audit event keeps naming them via actorUserId.
    const credential = await this.heads.resolveWriteCredential(
      project.repo_full_name,
      actor.userId,
      actor.oauthToken,
    );
    if (!credential) {
      throw new ConflictException({
        code: 'GITHUB_REAUTH',
        message: 'Sign in to GitHub again, then retry.',
      });
    }

    const outcome = await this.mergeRepository({
      project,
      actor,
      credential,
      headSha,
      pullRequest: status.pullRequest,
      evaluation: context.evaluation,
    });
    if (outcome.kind === 'failed') {
      return {
        merged: false,
        sha: null,
        message: outcome.message,
        pullRequest: outcome.pullRequest
          ? { number: outcome.pullRequest.number, url: outcome.pullRequest.url }
          : null,
      };
    }

    // Merged, or main already held the head: either way this repository is
    // delivered. Record it and see whether that completes the Iteration.
    await this.settleSingle(project, actor, context, headSha, outcome);

    if (outcome.kind === 'already_in_main') {
      return {
        merged: false,
        sha: null,
        message: outcome.message,
        pullRequest: null,
        how: 'already_in_main',
      };
    }
    return {
      merged: true,
      how: 'merged',
      sha: outcome.sha,
      message: outcome.message,
      pullRequest: {
        number: outcome.pullRequest.number,
        url: outcome.pullRequest.url,
      },
    };
  }

  /**
   * POST /delivery-projects/:id/promotion/merge-all: carry every covered
   * repository's uat head to main, in a stable order, and keep going after a
   * failure so one bad repository does not hide the others. Each repository is
   * recorded as it lands, so a retry merges only what remains. The Iteration
   * becomes Delivered when the last one is in.
   */
  async mergeAll(
    deliveryProjectId: string,
    actor: QaRunActorContext,
  ): Promise<QaPromotionMergeAllResult> {
    const folder = await this.projectContext.requireProject(
      deliveryProjectId,
      actor.userId,
    );
    const role = await this.access.findAppRole(actor.userId);
    if (!canMergeQaPromotion(role)) {
      throw new ForbiddenException(
        'Only a lead or admin may merge uat to main.',
      );
    }

    const evaluation = await this.delivery.evaluateGate(
      deliveryProjectId,
      folder.repositories,
      actor,
    );
    if (evaluation.iteration.status === 'delivered') {
      throw iterationDelivered(evaluation.iteration.number);
    }
    if (folder.repositories.length === 0) {
      throw projectHasNoRepositories();
    }
    if (!evaluation.gate.eligible || !evaluation.latest) {
      throw new ConflictException({
        code: 'QA_PROMOTION_BLOCKED',
        message: 'QA promotion is not eligible yet.',
        reasons: evaluation.gate.reasons,
      });
    }

    const runId = evaluation.latest.run.id;
    let iteration = evaluation.iteration;
    const results: QaPromotionMergeAllRepositoryResult[] = [];

    for (const repository of evaluation.covered) {
      const stored = deliveryEntryFor(
        this.iterations.toDeliveredRepositories(iteration),
        repository,
        'active',
      );
      if (stored) {
        results.push({
          projectId: repository.projectId,
          repoFullName: repository.repoFullName,
          merged: false,
          how: stored.how,
          message: 'Already delivered earlier.',
        });
        continue;
      }

      const outcome = await this.mergeCoveredRepository(
        repository,
        actor,
        evaluation,
      );
      if (outcome.kind === 'failed') {
        results.push({
          projectId: repository.projectId,
          repoFullName: repository.repoFullName,
          merged: false,
          how: null,
          message: outcome.message,
        });
        continue;
      }
      results.push({
        projectId: repository.projectId,
        repoFullName: repository.repoFullName,
        merged: outcome.kind === 'merged',
        how: outcome.kind,
        message: outcome.kind === 'merged' ? null : outcome.message,
      });
      const settled = await this.delivery.settle({
        project: folder,
        iteration,
        runId,
        covered: evaluation.covered,
        actor,
        entry: this.deliveredEntry(
          repository.projectId,
          repository.repoFullName,
          repository.headSha,
          outcome,
        ),
        probeOthers: false,
      });
      iteration = settled.iteration;
    }

    // Self-heal: everything may already be recorded (a crash after the last
    // record, before the transition). Idempotent when already delivered.
    if (iteration.status === 'active') {
      iteration = (
        await this.delivery.settle({
          project: folder,
          iteration,
          runId,
          covered: evaluation.covered,
          actor,
          entry: null,
          probeOthers: false,
        })
      ).iteration;
    }

    return {
      repositories: results,
      delivered: iteration.status === 'delivered',
      iteration: this.iterations.toIteration(iteration),
    };
  }

  // ---------------------------------------------------------------------
  // Status assembly (shared by GET and POST's server-side recheck)
  // ---------------------------------------------------------------------

  private async computeStatus(
    project: ProvisionedProjectRow,
    actor: QaRunActorContext,
  ): Promise<{ status: QaPromotionStatusCore; context: StatusContext | null }> {
    const self: QaProjectRepository = {
      projectId: project.id,
      name: project.service_name || project.repo_full_name,
      repoFullName: project.repo_full_name,
    };
    const folder = await this.projectContext.findProjectOfRepository(
      project.id,
    );
    const pullRequest = await this.findPromotionPullRequest(self, actor);

    if (!folder) {
      const reading = await this.heads.readHead(self, actor);
      const headSha = reading.kind === 'ok' ? reading.sha : null;
      return {
        context: null,
        status: {
          qaBranch: QA_BRANCH,
          targetBranch: QA_PROMOTION_TARGET_BRANCH,
          headSha,
          scope: 'unfiled',
          deliveryProject: null,
          run: null,
          repositories: [
            {
              projectId: self.projectId,
              repoFullName: self.repoFullName,
              runSha: null,
              currentSha: headSha,
              moved: false,
            },
          ],
          requirementsChanged: false,
          checklists: [],
          eligible: false,
          reasons: [UNFILED_REASON],
          pullRequest,
          repositoryDelivered: false,
          iterationDelivered: false,
          iteration: null,
          reasonCodes: [],
        },
      };
    }

    // Every repository of the Project, this one included even if its
    // hierarchy row is somehow missing from the folder listing.
    const repositories = folder.repositories.some(
      (repository) => repository.projectId === self.projectId,
    )
      ? folder.repositories
      : [self, ...folder.repositories];
    const scopedFolder: QaProjectContext = { ...folder, repositories };

    // The gate looks at the Project's current Iteration only: its requirements
    // and its latest signed-off run.
    const evaluation = await this.delivery.evaluateGate(
      folder.deliveryProjectId,
      repositories,
      actor,
    );
    const { iteration, gate, latest } = evaluation;

    const requirementsChanged = latest
      ? await this.requirements.requirementsChangedSince(
          iteration.id,
          latest.signoff.signed_at,
        )
      : false;
    const own = gate.repositories.find(
      (repository) => repository.projectId === self.projectId,
    );

    const delivered = iteration.status === 'delivered';
    const stored = deliveryEntryFor(
      this.iterations.toDeliveredRepositories(iteration),
      { projectId: self.projectId, headSha: own?.runSha ?? null },
      iteration.status,
    );

    return {
      context: { folder: scopedFolder, evaluation },
      status: {
        qaBranch: QA_BRANCH,
        targetBranch: QA_PROMOTION_TARGET_BRANCH,
        headSha: own?.currentSha ?? null,
        scope: 'project',
        deliveryProject: { id: folder.deliveryProjectId, name: folder.name },
        run: gate.run,
        repositories: gate.repositories,
        requirementsChanged,
        checklists: this.toChecklists(evaluation),
        // A delivered Iteration is closed whatever the gate would say.
        eligible: gate.eligible && !delivered,
        reasons: delivered
          ? [
              `Iteration ${String(iteration.number)} was delivered. Start the next iteration to merge again.`,
              ...gate.reasons,
            ]
          : gate.reasons,
        pullRequest,
        repositoryDelivered: stored !== null,
        iterationDelivered: delivered,
        iteration: {
          id: iteration.id,
          number: iteration.number,
          status: iteration.status,
          deliveredAt: iteration.delivered_at
            ? new Date(iteration.delivered_at).toISOString()
            : null,
        },
        reasonCodes: delivered ? ['ITERATION_DELIVERED'] : [],
      },
    };
  }

  /**
   * Deprecated: one entry per requirement, each carrying the Project-level
   * result, for the frontend that predates Project requirements.
   */
  private toChecklists(
    evaluation: ProjectGateEvaluation,
  ): QaPromotionChecklist[] {
    const { gate } = evaluation;
    return evaluation.requirements.map((row) => ({
      id: row.id,
      name: row.name,
      runId: gate.run?.id ?? null,
      verdict: gate.run?.verdict ?? null,
      runStatus: gate.run ? 'signed_off' : null,
      approvedForHead: gate.eligible,
    }));
  }

  private async findPromotionPullRequest(
    repository: QaProjectRepository,
    actor: QaRunActorContext,
  ): Promise<QaPromotionPullRequestRef | null> {
    const token = await this.heads.resolveReadToken(
      repository.repoFullName,
      actor.userId,
      actor.oauthToken,
    );
    if (!token) {
      return null;
    }
    const summary = await this.githubService.findOpenPullRequest(
      token,
      repository.repoFullName,
      QA_BRANCH,
      QA_PROMOTION_TARGET_BRANCH,
    );
    if (!summary) {
      return null;
    }

    const detail = await this.githubService.getPullRequest(
      token,
      repository.repoFullName,
      summary.number,
    );
    // Extreme race: the PR was closed/merged between the two reads above.
    // Reported as "no PR" rather than thrown -- the next GET will see
    // whatever is true by then.
    if (!detail) {
      return null;
    }

    return {
      number: summary.number,
      url: summary.htmlUrl,
      headSha: detail.headSha,
    };
  }

  // ---------------------------------------------------------------------
  // Write path (POST .../merge and merge-all)
  // ---------------------------------------------------------------------

  /** One repository of merge-all: its own credential, its own PR, its own failure. */
  private async mergeCoveredRepository(
    repository: { projectId: string; repoFullName: string; headSha: string },
    actor: QaRunActorContext,
    evaluation: ProjectGateEvaluation,
  ): Promise<RepositoryMergeOutcome> {
    try {
      const project = await this.access.findVisibleProject(
        repository.projectId,
        actor.userId,
      );
      if (!project) {
        return {
          kind: 'failed',
          message: `${repository.repoFullName} is not available to you.`,
          pullRequest: null,
        };
      }
      const credential = await this.heads.resolveWriteCredential(
        project.repo_full_name,
        actor.userId,
        actor.oauthToken,
      );
      if (!credential) {
        return {
          kind: 'failed',
          message: 'Sign in to GitHub again, then retry.',
          pullRequest: null,
        };
      }
      const pullRequest = await this.findPromotionPullRequest(
        {
          projectId: project.id,
          name: project.service_name || project.repo_full_name,
          repoFullName: project.repo_full_name,
        },
        actor,
      );
      return await this.mergeRepository({
        project,
        actor,
        credential,
        headSha: repository.headSha,
        pullRequest,
        evaluation,
      });
    } catch (error) {
      // One repository failing (uat moved, GitHub down) must not stop the rest.
      const message =
        error instanceof ConflictException
          ? this.conflictMessage(error)
          : `Could not merge ${repository.repoFullName}: ${(error as Error).message}`;
      return { kind: 'failed', message, pullRequest: null };
    }
  }

  private conflictMessage(error: ConflictException): string {
    const body = error.getResponse();
    return typeof body === 'object' &&
      'message' in body &&
      typeof body.message === 'string'
      ? body.message
      : error.message;
  }

  /**
   * Carries `headSha` (the uat head the run approved) to main for ONE
   * repository: nothing to do when main already holds it, otherwise the
   * promotion PR (found or opened) is merged at exactly that sha.
   */
  private async mergeRepository(input: {
    project: ProvisionedProjectRow;
    actor: QaRunActorContext;
    credential: QaWriteCredential;
    headSha: string;
    pullRequest: QaPromotionPullRequestRef | null;
    evaluation: ProjectGateEvaluation;
  }): Promise<RepositoryMergeOutcome> {
    const { project, actor, credential, headSha, evaluation } = input;

    // GitHub refuses to open a promotion PR when there is nothing to merge, so
    // ask first: "main already has it" is a fact to record, never an error.
    if (
      await this.delivery.mainContainsHead(
        credential.token,
        project.repo_full_name,
        headSha,
      )
    ) {
      return { kind: 'already_in_main', message: ALREADY_IN_MAIN_MESSAGE };
    }

    const resolution = input.pullRequest
      ? ({ kind: 'ok', pr: input.pullRequest } as const)
      : await this.createPromotionPullRequest(
          project,
          credential.token,
          headSha,
          evaluation,
        );

    if (resolution.kind === 'refused') {
      return {
        kind: 'failed',
        message: resolution.message,
        pullRequest: null,
      };
    }

    const pr = resolution.pr;
    if (pr.headSha !== headSha) {
      throw new ConflictException({
        code: 'QA_UAT_MOVED',
        message: `uat moved since this was checked (now ${pr.headSha.slice(0, 7)}, was ${headSha.slice(0, 7)}); recheck and try again.`,
      });
    }

    const result = await this.githubService.mergePullRequest(
      credential.token,
      project.repo_full_name,
      pr.number,
      { method: 'merge', sha: headSha },
    );
    const pullRequestRef = { number: pr.number, url: pr.url };

    if (!result.merged) {
      return {
        kind: 'failed',
        message: result.message,
        pullRequest: pullRequestRef,
      };
    }

    await this.recordMergeAudit(
      project,
      actor,
      pr,
      headSha,
      result.sha,
      evaluation,
      credential.via,
    );
    await this.notifyLeadsExcludingActor(project, actor, pr, headSha);

    return {
      kind: 'merged',
      sha: result.sha,
      message: result.message,
      pullRequest: pullRequestRef,
    };
  }

  /** The delivery_json entry for a repository that just reached main. */
  private deliveredEntry(
    projectId: string,
    repoFullName: string,
    uatHeadSha: string,
    outcome: Exclude<RepositoryMergeOutcome, { kind: 'failed' }>,
  ): DeliveredRepository {
    return {
      projectId,
      repoFullName,
      uatHeadSha,
      mergeSha: outcome.kind === 'merged' ? outcome.sha : null,
      prNumber: outcome.kind === 'merged' ? outcome.pullRequest.number : null,
      how: outcome.kind,
      at: new Date().toISOString(),
    };
  }

  /**
   * After a single-repository merge: record it, look at the other covered
   * repositories (main may already hold their heads) and deliver the Iteration
   * when every one is in.
   */
  private async settleSingle(
    project: ProvisionedProjectRow,
    actor: QaRunActorContext,
    context: StatusContext,
    headSha: string,
    outcome: Exclude<RepositoryMergeOutcome, { kind: 'failed' }>,
  ): Promise<void> {
    const run = context.evaluation.latest?.run;
    if (!run) {
      return;
    }
    await this.delivery.settle({
      project: context.folder,
      iteration: context.evaluation.iteration,
      runId: run.id,
      covered: context.evaluation.covered,
      actor,
      entry: this.deliveredEntry(
        project.id,
        project.repo_full_name,
        headSha,
        outcome,
      ),
      probeOthers: true,
    });
  }

  private async createPromotionPullRequest(
    project: ProvisionedProjectRow,
    oauthToken: string,
    headSha: string,
    evaluation: ProjectGateEvaluation,
  ): Promise<PullRequestResolution> {
    const { gate } = evaluation;
    const body = buildQaPromotionPullRequestBody(
      this.toChecklists(evaluation),
      headSha,
      gate.run
        ? {
            runId: gate.run.id,
            repositories: gate.repositories.map((repository) => ({
              repoFullName: repository.repoFullName,
              runSha: repository.runSha,
            })),
          }
        : undefined,
    );

    const created = await this.githubService.openPullRequest(
      oauthToken,
      project.repo_full_name,
      {
        title: 'Promote uat to main',
        head: QA_BRANCH,
        base: QA_PROMOTION_TARGET_BRANCH,
        body,
      },
    );
    if (!created.created) {
      return { kind: 'refused', message: created.message };
    }

    const detail = await this.githubService.getPullRequest(
      oauthToken,
      project.repo_full_name,
      created.pullRequest.number,
    );
    if (!detail) {
      return {
        kind: 'refused',
        message:
          'The promotion pull request could not be read back after it was created.',
      };
    }

    return {
      kind: 'ok',
      pr: {
        number: created.pullRequest.number,
        url: created.pullRequest.htmlUrl,
        headSha: detail.headSha,
      },
    };
  }

  private async recordMergeAudit(
    project: ProvisionedProjectRow,
    actor: QaRunActorContext,
    pr: ResolvedPullRequest,
    headSha: string,
    mergeSha: string | null,
    evaluation: ProjectGateEvaluation,
    via: QaWriteVia,
  ): Promise<void> {
    await this.auditEventsService?.recordProjectEvent({
      workspaceId: project.workspace_id ?? null,
      projectId: project.id,
      actorUserId: actor.userId,
      eventCode: QA_PROMOTION_MERGED_EVENT,
      message: `uat (${headSha.slice(0, 7)}) merged to main via pull request #${String(pr.number)}`,
      metadata: {
        pullRequestNumber: pr.number,
        pullRequestUrl: pr.url,
        headSha,
        mergeSha,
        via,
        deliveryProjectId: evaluation.iteration.delivery_project_id,
        runId: evaluation.gate.run?.id ?? null,
      },
    });
  }

  private async notifyLeadsExcludingActor(
    project: ProvisionedProjectRow,
    actor: QaRunActorContext,
    pr: ResolvedPullRequest,
    headSha: string,
  ): Promise<void> {
    const notifications = this.notificationEventsService;
    if (!notifications || !project.workspace_id) {
      return;
    }
    const leadIds = await this.access.listWorkspaceLeadIds(
      project.workspace_id,
    );
    const recipients = new Set(leadIds.filter((id) => id !== actor.userId));
    if (recipients.size === 0) {
      return;
    }

    const body = this.truncate(
      `Pull request #${String(pr.number)} merged uat (${headSha.slice(0, 7)}) into main.`,
      NOTIFICATION_BODY_TRUNCATE_LENGTH,
    );
    await Promise.all(
      [...recipients].map((userId) =>
        notifications.record({
          userId,
          projectId: project.id,
          eventCode: QA_PROMOTION_MERGED_EVENT,
          title: 'QA-approved uat merged to main',
          body,
        }),
      ),
    );
  }

  private truncate(value: string, max: number): string {
    return value.length > max ? `${value.slice(0, max)}…` : value;
  }

  // ---------------------------------------------------------------------
  // Access
  // ---------------------------------------------------------------------

  private async requireVisibleProject(
    projectId: string,
    userId: string,
  ): Promise<ProvisionedProjectRow> {
    const project = await this.access.findVisibleProject(projectId, userId);
    if (!project) {
      throw new NotFoundException('Project not found');
    }
    return project;
  }
}

export type { QaHeadStatus };
