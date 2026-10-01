import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';

import { QA_BRANCH } from '#kernel/config/pipeline-branches';
import { AuditEventPublisher } from '#kernel/events/platform-event-publisher.js';
import {
  GITHUB_PROJECT_PORT,
  type GithubProjectPort,
} from '#kernel/ports/github.port';
import { canDispatchAutomation } from '../../domain/qa-run-access.rules';
import { QaProjectRunsRepository } from '../../infrastructure/qa-project-runs.repository';
import type { QaRunRepositoryRow } from '../../infrastructure/qa-runs.repository';
import { QaAccessService } from '../qa-checklists/qa-access.service';
import { QaProjectContextService } from '../qa-checklists/qa-project-context.service';
import type { DispatchProjectRunDto } from './dto/dispatch-project-run.dto';
import type { QaRunActorContext } from './qa-runs.contracts';
import { resolveVerifyWorkflowFile } from './resolve-verify-workflow-file';

export interface QaAutomationDispatchResult {
  projectId: string;
  repoFullName: string;
  workflowFile: string;
  ref: string;
  headSha: string;
  /** False when the FE should warn that results will attach to a newer commit than the run captured. */
  targetsRunCommit: boolean;
}

export interface QaAutomationDispatchFailure {
  projectId: string;
  repoFullName: string;
  code: 'GITHUB_REAUTH' | 'VERIFY_WORKFLOW_MISSING' | 'DISPATCH_REFUSED';
  message: string;
}

export interface QaProjectDispatchResult {
  dispatched: QaAutomationDispatchResult[];
  /** Repositories the dispatch did not reach; empty when every one did. */
  failed: QaAutomationDispatchFailure[];
}

/**
 * "Run Playwright": re-dispatches the generated verify workflow of a Project
 * QA run's repositories, attributed to the signed-in user's own GitHub token -
 * see github.service.ts's dispatchWorkflow, the first caller of GitHub's
 * workflow_dispatch endpoint in this codebase.
 *
 * By default it dispatches in EVERY repository the run covers (a Project run
 * spans several); `projectId` narrows it to one. A repository that cannot be
 * dispatched is reported in `failed` rather than failing the others; only
 * when NOTHING could be dispatched does it answer with the first failure's
 * product-facing error.
 *
 * A separate service from QaProjectRunsService (not a method on it) because
 * its error shapes are entirely different - GitHub write refusals mapped to
 * product-facing codes - and it needs no automation *read* (that's
 * QaAutomationService, used by assembleRun instead).
 */
@Injectable()
export class QaAutomationDispatchService {
  constructor(
    private readonly access: QaAccessService,
    private readonly projectContext: QaProjectContextService,
    private readonly projectRuns: QaProjectRunsRepository,
    @Inject(GITHUB_PROJECT_PORT)
    private readonly githubService: GithubProjectPort,
    @Optional()
    @Inject(AuditEventPublisher)
    private readonly auditEventsService?: AuditEventPublisher,
  ) {}

  async dispatch(
    deliveryProjectId: string,
    actor: QaRunActorContext,
    runId: string,
    dto: DispatchProjectRunDto,
  ): Promise<QaProjectDispatchResult> {
    const project = await this.projectContext.requireProject(
      deliveryProjectId,
      actor.userId,
    );
    const run = await this.projectRuns.findProjectRun(deliveryProjectId, runId);
    if (!run) {
      throw new NotFoundException('QA run not found');
    }

    const role = await this.access.findAppRole(actor.userId);
    if (!canDispatchAutomation(role)) {
      throw new ForbiddenException(
        'Only QA, a lead, or an admin may run Playwright for this run.',
      );
    }

    if (run.status === 'signed_off') {
      throw new ConflictException(
        'This run is signed off. Reopen it to make changes.',
      );
    }

    if (!actor.oauthToken) {
      throw new ConflictException({
        code: 'GITHUB_REAUTH',
        message: 'Sign in to GitHub again, then retry.',
      });
    }

    const coverage =
      (await this.projectRuns.listCoverageByRunIds([run.id])).get(run.id) ?? [];
    const targets = dto.projectId
      ? coverage.filter((row) => row.project_id === dto.projectId)
      : coverage;
    if (targets.length === 0) {
      throw new NotFoundException(
        dto.projectId
          ? 'That repository is not part of this run.'
          : 'This run covers no repository.',
      );
    }

    const dispatched: QaAutomationDispatchResult[] = [];
    const failed: QaAutomationDispatchFailure[] = [];
    for (const target of targets) {
      const outcome = await this.dispatchOne(target, actor);
      if ('code' in outcome) {
        failed.push(outcome);
      } else {
        dispatched.push(outcome);
      }
    }

    if (dispatched.length === 0) {
      const first = failed[0];
      if (first?.code === 'GITHUB_REAUTH') {
        throw new ConflictException({
          code: first.code,
          message: first.message,
          failed,
        });
      }
      if (first?.code === 'VERIFY_WORKFLOW_MISSING') {
        throw new ConflictException({
          code: first.code,
          message: first.message,
          failed,
        });
      }
      throw new ForbiddenException(first?.message ?? 'Dispatch was refused.');
    }

    await this.auditEventsService?.recordProjectEvent({
      workspaceId: project.groupId,
      projectId: await this.projectContext.anchorProjectId(project),
      actorUserId: actor.userId,
      eventCode: 'qa.automation.dispatched',
      message: `Playwright dispatched for ${QA_BRANCH} (run ${runId})`,
      metadata: {
        runId,
        deliveryProjectId,
        branch: QA_BRANCH,
        dispatched: dispatched.map((entry) => ({
          repoFullName: entry.repoFullName,
          workflowFile: entry.workflowFile,
          targetsRunCommit: entry.targetsRunCommit,
        })),
        failed: failed.map((entry) => entry.repoFullName),
      },
    });

    return { dispatched, failed };
  }

  private async dispatchOne(
    target: QaRunRepositoryRow,
    actor: QaRunActorContext,
  ): Promise<QaAutomationDispatchResult | QaAutomationDispatchFailure> {
    const token = actor.oauthToken as string;
    const base = {
      projectId: target.project_id,
      repoFullName: target.repo_full_name,
    };

    const repository = await this.access.findVisibleProject(
      target.project_id,
      actor.userId,
    );
    if (!repository) {
      return {
        ...base,
        code: 'DISPATCH_REFUSED',
        message: 'This repository is no longer available to you.',
      };
    }

    const workflowFile = resolveVerifyWorkflowFile(repository.workflow_path);
    const ref = QA_BRANCH;

    try {
      // Read with the same user token the dispatch itself uses below - a
      // token too stale to read branches is too stale to dispatch, so either
      // call surfaces the same GITHUB_REAUTH outcome.
      const branches = await this.githubService.listBranches(
        token,
        target.repo_full_name,
      );
      const head = branches.find((candidate) => candidate.name === ref);
      const headSha = head?.commitSha ?? target.head_sha;

      const result = await this.githubService.dispatchWorkflow(
        token,
        target.repo_full_name,
        workflowFile,
        ref,
      );
      if (!result.dispatched) {
        if (result.reason === 'unauthorized') {
          return {
            ...base,
            code: 'GITHUB_REAUTH',
            message:
              'GitHub no longer accepts your sign-in. Sign in again, then retry.',
          };
        }
        if (result.reason === 'not_found') {
          return {
            ...base,
            code: 'VERIFY_WORKFLOW_MISSING',
            message: "This repository's pipeline has no verify workflow yet.",
          };
        }
        return { ...base, code: 'DISPATCH_REFUSED', message: result.message };
      }

      return {
        ...base,
        workflowFile,
        ref,
        headSha,
        targetsRunCommit: headSha === target.head_sha,
      };
    } catch (error) {
      return {
        ...base,
        code: 'DISPATCH_REFUSED',
        message: (error as Error).message,
      };
    }
  }
}
