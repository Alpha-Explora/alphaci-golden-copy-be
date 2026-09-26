import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
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
import {
  evaluateQaPromotionGate,
  type QaPromotionChecklistCandidate,
} from '../../domain/qa-promotion.rules';
import type { QaChecklistRow } from '../../infrastructure/qa-checklists.repository';
import { QaChecklistsRepository } from '../../infrastructure/qa-checklists.repository';
import {
  QaRunsRepository,
  type QaVerificationRunRow,
} from '../../infrastructure/qa-runs.repository';
import type { ProvisionedProjectRow } from '../../infrastructure/projects.repository';
import { QaAccessService } from '../qa-checklists/qa-access.service';
import { buildQaPromotionPullRequestBody } from './qa-promotion.pr-body';
import type {
  QaPromotionMergeResult,
  QaPromotionPullRequestRef,
  QaPromotionStatus,
} from './qa-promotion.contracts';
import type { QaRunActorContext } from './qa-runs.service';

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

/**
 * "Merge to main" (Slice 6): the promotion gate (GET) and the merge action
 * (POST) for carrying a QA-approved uat commit to main. Reuses
 * ProjectWorkspaceService.mergePullRequest's behaviour (merge with the
 * user's own OAuth token, return GitHub's refusal text as merged:false)
 * without depending on that service directly -- ProjectWorkspaceService
 * lives in a sibling application/workspace/ area with no shared module
 * boundary to this slice, and the flow here also needs the gate recheck and
 * PR discovery/creation woven in, which that service does not do.
 */
@Injectable()
export class QaPromotionService {
  private readonly logger = new Logger(QaPromotionService.name);

  constructor(
    private readonly access: QaAccessService,
    private readonly qaChecklistsRepository: QaChecklistsRepository,
    private readonly qaRunsRepository: QaRunsRepository,
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
    if (!status.eligible) {
      throw new ConflictException({
        code: 'QA_PROMOTION_BLOCKED',
        message: 'QA promotion is not eligible yet.',
        reasons: status.reasons,
      });
    }
    // Guaranteed non-null: eligible only becomes true when headSha is known.
    const headSha = status.headSha as string;

    if (!actor.oauthToken) {
      throw new ConflictException({
        code: 'GITHUB_REAUTH',
        message: 'Sign in to GitHub again, then retry.',
      });
    }

    const resolution = status.pullRequest
      ? ({ kind: 'ok', pr: status.pullRequest } as const)
      : await this.createPromotionPullRequest(
          project,
          actor.oauthToken,
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
      actor.oauthToken,
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

    await this.recordMergeAudit(project, actor, pr, headSha, result.sha);
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
    const readToken = await this.resolveReadToken(
      project.repo_full_name,
      actor.userId,
      actor.oauthToken,
    );

    const headSha = readToken
      ? await this.readBranchHeadSha(readToken, project.repo_full_name)
      : null;

    const checklistRows = await this.qaChecklistsRepository.listByProject(
      project.id,
    );
    const candidates = await this.buildChecklistCandidates(
      project.id,
      checklistRows,
      headSha,
    );
    const gate = evaluateQaPromotionGate({ headSha, checklists: candidates });

    const pullRequest = readToken
      ? await this.findPromotionPullRequest(readToken, project.repo_full_name)
      : null;

    return {
      qaBranch: QA_BRANCH,
      targetBranch: QA_PROMOTION_TARGET_BRANCH,
      headSha,
      checklists: gate.checklists,
      eligible: gate.eligible,
      reasons: gate.reasons,
      pullRequest,
    };
  }

  private async buildChecklistCandidates(
    projectId: string,
    checklists: QaChecklistRow[],
    headSha: string | null,
  ): Promise<QaPromotionChecklistCandidate[]> {
    if (headSha === null || checklists.length === 0) {
      return checklists.map((checklist) => ({
        id: checklist.id,
        name: checklist.name,
        run: null,
      }));
    }

    const runs = await Promise.all(
      checklists.map((checklist) =>
        this.qaRunsRepository.findRunByKey(
          projectId,
          checklist.id,
          QA_BRANCH,
          headSha,
        ),
      ),
    );
    const runIds = runs
      .filter((run): run is QaVerificationRunRow => run !== null)
      .map((run) => run.id);
    const signoffsByRunId =
      await this.qaRunsRepository.findActiveSignoffsByRunIds(runIds);

    return checklists.map((checklist, index) => {
      const run = runs[index];
      if (!run) {
        return { id: checklist.id, name: checklist.name, run: null };
      }
      const signoff = signoffsByRunId.get(run.id);
      return {
        id: checklist.id,
        name: checklist.name,
        run: {
          id: run.id,
          status: run.status,
          activeVerdict: signoff?.verdict ?? null,
        },
      };
    });
  }

  /**
   * Reads with the same 3-tier precedence as
   * QaCommitResolutionService.resolveReadToken (enforced-org installation
   * token, then the per-user-repo installation token, then the caller's own
   * OAuth token) -- reimplemented here rather than reused because that
   * method is private to a sibling service. This status is readable by
   * anyone who can see the project, so it deliberately does NOT require the
   * caller's own token the way the write path below does; a caller with no
   * personal GitHub sign-in still sees the gate through the installation
   * token.
   */
  private async resolveReadToken(
    repoFullName: string,
    userId: string,
    oauthToken: string | null,
  ): Promise<string | null> {
    const enforcedToken = await this.enforcedOrgToken(repoFullName);
    if (enforcedToken) {
      return enforcedToken;
    }

    const installationToken =
      await this.githubService.getInstallationAccessTokenForUserRepo(
        userId,
        repoFullName,
      );
    if (installationToken) {
      return installationToken;
    }

    return oauthToken;
  }

  private async enforcedOrgToken(repoFullName: string): Promise<string | null> {
    const enforcedOrg = this.githubService.getEnforcedOrg();
    if (!enforcedOrg) {
      return null;
    }

    const owner = repoFullName.split('/')[0];
    if (owner?.toLowerCase() !== enforcedOrg.toLowerCase()) {
      return null;
    }

    try {
      const context =
        await this.githubService.getOrganizationProvisioningContextByLogin(
          enforcedOrg,
        );
      return context.accessToken;
    } catch (error) {
      this.logger.warn(
        `Could not resolve the ${enforcedOrg} installation for ${repoFullName}: ${(error as Error).message}`,
      );
      return null;
    }
  }

  private async readBranchHeadSha(
    token: string,
    repoFullName: string,
  ): Promise<string | null> {
    const branches = await this.githubService.listBranches(token, repoFullName);
    const head = branches.find((candidate) => candidate.name === QA_BRANCH);
    return head?.commitSha ?? null;
  }

  private async findPromotionPullRequest(
    token: string,
    repoFullName: string,
  ): Promise<QaPromotionPullRequestRef | null> {
    const summary = await this.githubService.findOpenPullRequest(
      token,
      repoFullName,
      QA_BRANCH,
      QA_PROMOTION_TARGET_BRANCH,
    );
    if (!summary) {
      return null;
    }

    const detail = await this.githubService.getPullRequest(
      token,
      repoFullName,
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
