import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';

import { AuditEventPublisher } from '#kernel/events/platform-event-publisher.js';
import {
  VISUAL_REGRESSION_PORT,
  type VisualImageKind,
  type VisualInheritedFrom,
  type VisualRegressionPort,
  type VisualSnapshotStatus,
} from '#kernel/ports/visual-regression.port';
import { canApproveVisualBaseline } from '../../domain/visual-access.rules';
import { ProjectsRepository } from '../../infrastructure/projects.repository';

/** The branches the Visual tab shows. Baselines exist per branch; main inherits uat's. */
export type VisualBranch = 'uat' | 'main';

export interface ProjectVisualSnapshot {
  name: string;
  status: VisualSnapshotStatus;
  /** API paths under this controller (no /api/v1 prefix); null when there is nothing to show. */
  baselineUrl: string | null;
  actualUrl: string | null;
  diffUrl: string | null;
  baselineApprovedBy: string | null;
  baselineApprovedAt: string | null;
  inheritedFrom: VisualInheritedFrom | null;
  /** True when the branch baseline already equals this run's actual image. */
  approved: boolean;
}

export type ProjectVisualResponse =
  | {
      branch: VisualBranch;
      runId: number;
      commitSha: string;
      reportedAt: string;
      browser: string;
      canApprove: boolean;
      snapshots: ProjectVisualSnapshot[];
    }
  | {
      branch: VisualBranch;
      runId: null;
      canApprove: boolean;
      snapshots: [];
    };

export interface ProjectVisualImageQuery {
  kind: VisualImageKind;
  branch: VisualBranch;
  name: string;
  runId?: number;
}

/**
 * The Visual tab: what the latest Playwright run saw against the approved
 * baselines, and approving a changed screenshot as the new baseline.
 *
 * This service owns WHO may do what (project visibility, then the approver
 * allow-list) and the URLs, which carry a project id; the data belongs to
 * Pipelines and is reached through VISUAL_REGRESSION_PORT, keyed by the
 * project's repository. A project the caller cannot see is a 404, never a 403,
 * like every other project route.
 */
@Injectable()
export class ProjectVisualService {
  constructor(
    private readonly projectsRepository: ProjectsRepository,
    @Inject(VISUAL_REGRESSION_PORT)
    private readonly visual: VisualRegressionPort,
    @Optional()
    private readonly auditEventPublisher?: AuditEventPublisher,
  ) {}

  async getLatest(
    projectId: string,
    userId: string,
    branch: VisualBranch,
    runId?: number,
  ): Promise<ProjectVisualResponse> {
    const repoFullName = await this.repoFor(projectId, userId);
    const role = await this.projectsRepository.findAppRole(userId);
    const roleMayApprove = canApproveVisualBaseline(role);

    const run = await this.visual.getRun(repoFullName, branch, runId);
    // Only the latest run can be approved, so a viewed older run is read-only.
    let isLatest = true;
    if (run && runId !== undefined) {
      const latest = await this.visual.getRun(repoFullName, branch);
      isLatest = latest?.runId === run.runId;
    }
    const canApprove = roleMayApprove && isLatest;
    if (!run) {
      return { branch, runId: null, canApprove, snapshots: [] };
    }

    const imageUrl = (
      kind: VisualImageKind,
      name: string,
      version?: string,
    ): string =>
      `/projects/${projectId}/workspace/visual/image?kind=${kind}` +
      `&branch=${branch}&runId=${String(run.runId)}` +
      `&name=${encodeURIComponent(name)}` +
      (version ? `&v=${encodeURIComponent(version)}` : '');

    return {
      branch,
      runId: run.runId,
      commitSha: run.commitSha,
      reportedAt: run.reportedAt,
      browser: run.browser,
      canApprove,
      snapshots: run.snapshots.map((snapshot) => ({
        name: snapshot.name,
        status: snapshot.status,
        // The `v` hash changes when a baseline is re-approved, so the 5-minute
        // private cache on the image route cannot show the previous baseline
        // right after someone approves.
        baselineUrl: snapshot.baseline
          ? imageUrl(
              'baseline',
              snapshot.name,
              snapshot.baseline.sha256.slice(0, 12),
            )
          : null,
        actualUrl: snapshot.hasActual
          ? imageUrl('actual', snapshot.name)
          : null,
        diffUrl: snapshot.hasDiff ? imageUrl('diff', snapshot.name) : null,
        baselineApprovedBy: snapshot.baseline?.approvedByLogin ?? null,
        baselineApprovedAt: snapshot.baseline?.approvedAt ?? null,
        inheritedFrom: snapshot.baseline?.inheritedFrom ?? null,
        approved: snapshot.approved,
      })),
    };
  }

  /** PNG bytes, or a 404 (also for a project the caller cannot see). */
  async getImage(
    projectId: string,
    userId: string,
    query: ProjectVisualImageQuery,
  ): Promise<Buffer> {
    const repoFullName = await this.repoFor(projectId, userId);
    const png = await this.visual.readImage({
      repoFullName,
      branch: query.branch,
      kind: query.kind,
      name: query.name,
      ...(query.runId !== undefined && { runId: query.runId }),
    });
    if (!png) {
      throw new NotFoundException('No such image.');
    }
    return png;
  }

  async approve(
    projectId: string,
    userId: string,
    userLogin: string | null,
    input: { branch: VisualBranch; runId: number; names: string[] },
  ): Promise<{ approved: string[] }> {
    const repoFullName = await this.repoFor(projectId, userId);

    const role = await this.projectsRepository.findAppRole(userId);
    if (!canApproveVisualBaseline(role)) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        code: 'VISUAL_APPROVE_ROLE_FORBIDDEN',
        message: 'Your role cannot approve visual baselines in this project.',
      });
    }

    const approved = await this.visual.approve({
      repoFullName,
      branch: input.branch,
      runId: input.runId,
      names: input.names,
      approvedByUserId: userId,
      approvedByLogin: userLogin,
    });

    await this.auditEventPublisher?.recordProjectEvent({
      actorUserId: userId,
      projectId,
      eventCode: 'visual_baselines_approved',
      message: `Approved ${String(approved.length)} visual baseline${approved.length === 1 ? '' : 's'} on ${input.branch}`,
      metadata: {
        branch: input.branch,
        runId: input.runId,
        names: approved,
      },
    });

    return { approved };
  }

  private async repoFor(projectId: string, userId: string): Promise<string> {
    const row = await this.projectsRepository.findByIdAndUser(
      projectId,
      userId,
    );
    if (!row) {
      throw new NotFoundException('Project not found');
    }
    return row.repo_full_name;
  }
}
