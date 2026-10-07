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
import { canMergeQaPromotion } from '../../domain/qa-run-access.rules';
import { evaluateProjectPromotionGate } from '../../domain/qa-promotion.rules';
import { QaProjectRunsRepository } from '../../infrastructure/qa-project-runs.repository';
import { QaRequirementsRepository } from '../../infrastructure/qa-requirements.repository';
import type { ProvisionedProjectRow } from '../../infrastructure/projects.repository';
import { QaAccessService } from '../qa-checklists/qa-access.service';
import {
  QaProjectContextService,
  type QaProjectRepository,
} from '../qa-checklists/qa-project-context.service';
import { qaProjectRequired } from '../qa-checklists/qa-errors';
import { buildQaPromotionPullRequestBody } from './qa-promotion.pr-body';
import type {
  QaPromotionChecklist,
  QaPromotionMergeResult,
  QaPromotionPullRequestRef,
  QaPromotionStatus,
} from './qa-promotion.contracts';
import type { QaHeadStatus, QaRunActorContext } from './qa-runs.contracts';
import { QaUatHeadsService, type QaWriteVia } from './qa-uat-heads.service';

export type { QaRunActorContext };

type QaPromotionStatusCore = Omit<QaPromotionStatus, 'canMerge'>;

/** The pull request we resolved to merge -- either found already open, or just created. */
interface ResolvedPullRequest {
  number: number;
  url: string;
  headSha: string;
}

type PullRequestResolution =
  | { kind: 'ok'; pr: ResolvedPullRequest }
  | { kind: 'refused'; message: string };

const PROMOTION_MERGED_EVENT = 'qa.promotion.merged';
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
    private readonly projectRuns: QaProjectRunsRepository,
    private readonly heads: QaUatHeadsService,
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
    const [status, role] = await Promise.all([
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
    const status = await this.computeStatus(project, actor);
    if (status.scope === 'unfiled') {
      throw qaProjectRequired();
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

    const resolution = status.pullRequest
      ? ({ kind: 'ok', pr: status.pullRequest } as const)
      : await this.createPromotionPullRequest(
          project,
          credential.token,
          status,
        );

    if (resolution.kind === 'refused') {
      return {
        merged: false,
        sha: null,
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
        merged: false,
        sha: null,
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
      status,
      credential.via,
    );
    await this.notifyLeadsExcludingActor(project, actor, pr, headSha);

    return {
      merged: true,
      sha: result.sha,
      message: result.message,
      pullRequest: pullRequestRef,
    };
  }

  // ---------------------------------------------------------------------
  // Status assembly (shared by GET and POST's server-side recheck)
  // ---------------------------------------------------------------------

  private async computeStatus(
    project: ProvisionedProjectRow,
    actor: QaRunActorContext,
  ): Promise<QaPromotionStatusCore> {
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
      };
    }

    // Every repository of the Project, this one included even if its
    // hierarchy row is somehow missing from the folder listing.
    const repositories = folder.repositories.some(
      (repository) => repository.projectId === self.projectId,
    )
      ? folder.repositories
      : [self, ...folder.repositories];

    const [readings, requirementRows, latest] = await Promise.all([
      this.heads.readHeads(repositories, actor),
      this.requirements.listActiveByDeliveryProject(folder.deliveryProjectId),
      this.projectRuns.findLatestSignedOff(folder.deliveryProjectId),
    ]);

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
    });

    const requirementsChanged = latest
      ? await this.requirements.requirementsChangedSince(
          folder.deliveryProjectId,
          latest.signoff.signed_at,
        )
      : false;
    const own = gate.repositories.find(
      (repository) => repository.projectId === self.projectId,
    );

    // Deprecated: one entry per requirement, each carrying the Project-level
    // result, for the frontend that predates Project requirements.
    const checklists: QaPromotionChecklist[] = requirementRows.map((row) => ({
      id: row.id,
      name: row.name,
      runId: gate.run?.id ?? null,
      verdict: gate.run?.verdict ?? null,
      runStatus: gate.run ? 'signed_off' : null,
      approvedForHead: gate.eligible,
    }));

    return {
      qaBranch: QA_BRANCH,
      targetBranch: QA_PROMOTION_TARGET_BRANCH,
      headSha: own?.currentSha ?? null,
      scope: 'project',
      deliveryProject: { id: folder.deliveryProjectId, name: folder.name },
      run: gate.run,
      repositories: gate.repositories,
      requirementsChanged,
      checklists,
      eligible: gate.eligible,
      reasons: gate.reasons,
      pullRequest,
    };
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
  // Write path (POST .../merge only)
  // ---------------------------------------------------------------------

  private async createPromotionPullRequest(
    project: ProvisionedProjectRow,
    oauthToken: string,
    status: QaPromotionStatusCore,
  ): Promise<PullRequestResolution> {
    const body = buildQaPromotionPullRequestBody(
      status.checklists,
      status.headSha as string,
      status.run
        ? {
            runId: status.run.id,
            repositories: status.repositories.map((repository) => ({
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
    status: QaPromotionStatusCore,
    via: QaWriteVia,
  ): Promise<void> {
    await this.auditEventsService?.recordProjectEvent({
      workspaceId: project.workspace_id ?? null,
      projectId: project.id,
      actorUserId: actor.userId,
      eventCode: PROMOTION_MERGED_EVENT,
      message: `uat (${headSha.slice(0, 7)}) merged to main via pull request #${String(pr.number)}`,
      metadata: {
        pullRequestNumber: pr.number,
        pullRequestUrl: pr.url,
        headSha,
        mergeSha,
        via,
        deliveryProjectId: status.deliveryProject?.id ?? null,
        runId: status.run?.id ?? null,
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
          eventCode: PROMOTION_MERGED_EVENT,
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
