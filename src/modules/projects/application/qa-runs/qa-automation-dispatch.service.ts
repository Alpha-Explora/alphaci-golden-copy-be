import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';

import { AuditEventPublisher } from '#kernel/events/platform-event-publisher.js';
import {
  GITHUB_PROJECT_PORT,
  type GithubProjectPort,
} from '#kernel/ports/github.port';
import { canDispatchAutomation } from '../../domain/qa-run-access.rules';
import { QaRunsRepository } from '../../infrastructure/qa-runs.repository';
import { QaAccessService } from '../qa-checklists/qa-access.service';
import type { QaRunActorContext } from './qa-runs.service';
import { resolveVerifyWorkflowFile } from './resolve-verify-workflow-file';

export interface QaAutomationDispatchResult {
  workflowFile: string;
  ref: string;
  headSha: string;
  /** False when the FE should warn that results will attach to a newer commit than the run's own. */
  targetsRunCommit: boolean;
}

/**
 * "Run Playwright": re-dispatches the generated verify workflow for a QA
 * run's branch, attributed to the signed-in user's own GitHub token — see
 * github.service.ts's dispatchWorkflow, the first caller of GitHub's
 * workflow_dispatch endpoint in this codebase.
 *
 * A separate service from QaRunsService (not a method on it) because its
 * error shapes are entirely different — GitHub write refusals mapped to
 * product-facing codes — and it needs no automation *read* (that's
 * QaAutomationService, used by assembleRun instead).
 */
@Injectable()
export class QaAutomationDispatchService {
  constructor(
    private readonly access: QaAccessService,
    private readonly runsRepository: QaRunsRepository,
    @Inject(GITHUB_PROJECT_PORT)
    private readonly githubService: GithubProjectPort,
    @Optional()
    @Inject(AuditEventPublisher)
    private readonly auditEventsService?: AuditEventPublisher,
  ) {}

  async dispatch(
    projectId: string,
    actor: QaRunActorContext,
    runId: string,
  ): Promise<QaAutomationDispatchResult> {
    const project = await this.access.findVisibleProject(
      projectId,
      actor.userId,
    );
    if (!project) {
      throw new NotFoundException('Project not found');
    }

    const run = await this.runsRepository.findRunForProject(projectId, runId);
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

    const workflowFile = resolveVerifyWorkflowFile(project.workflow_path);
    const ref = run.branch;

    // Read with the same user token the dispatch itself uses below — a
    // token too stale to read branches is too stale to dispatch, so
    // either call surfaces the same GITHUB_REAUTH outcome.
    const branches = await this.githubService.listBranches(
      actor.oauthToken,
      project.repo_full_name,
    );
    const head = branches.find((candidate) => candidate.name === ref);
    const headSha = head?.commitSha ?? run.commit_sha;
    const targetsRunCommit = headSha === run.commit_sha;

    const result = await this.githubService.dispatchWorkflow(
      actor.oauthToken,
      project.repo_full_name,
      workflowFile,
      ref,
    );
    if (!result.dispatched) {
      if (result.reason === 'unauthorized') {
        throw new ConflictException({
          code: 'GITHUB_REAUTH',
          message:
            'GitHub no longer accepts your sign-in. Sign in again, then retry.',
        });
      }
      if (result.reason === 'not_found') {
        throw new ConflictException({
          code: 'VERIFY_WORKFLOW_MISSING',
          message: "This project's pipeline has no verify workflow yet.",
        });
      }
      throw new ForbiddenException(result.message);
    }

    await this.auditEventsService?.recordProjectEvent({
      workspaceId: project.workspace_id ?? null,
      projectId: project.id,
      actorUserId: actor.userId,
      eventCode: 'qa.automation.dispatched',
      message: `Playwright dispatched for ${ref} (run ${runId})`,
      metadata: { runId, branch: ref, workflowFile, targetsRunCommit },
    });

    return { workflowFile, ref, headSha, targetsRunCommit };
  }
}
