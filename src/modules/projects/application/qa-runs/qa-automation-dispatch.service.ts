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
import { ProjectIterationsService } from '../qa-checklists/project-iterations.service';
import { QaAccessService } from '../qa-checklists/qa-access.service';
import { QaProjectContextService } from '../qa-checklists/qa-project-context.service';
import { QaUatHeadsService, type QaWriteVia } from './qa-uat-heads.service';
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
 * QA run's repositories, performed by the ALPHACI GitHub App after ALPHACI's own role, visibility
 * and sign-off checks (the signed-in user's token is only the fallback), and
 * the audit event names the person plus `via`.
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
    // Concrete class token: a missing provider fails boot, and
    // tests/architecture/http-boot.spec.ts reads it back to prove it resolved.
    private readonly heads: QaUatHeadsService,
    private readonly iterations: ProjectIterationsService,
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

    await this.iterations.assertRowWritable(run);
    if (run.status === 'signed_off') {
      throw new ConflictException(
        'This run is signed off. Reopen it to make changes.',
      );
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
    const viaByRepo = new Map<string, QaWriteVia>();
    for (const target of targets) {
      const outcome = await this.dispatchOne(target, actor);
      if ('code' in outcome.result) {
        failed.push(outcome.result);
      } else {
        dispatched.push(outcome.result);
        if (outcome.via) {
          viaByRepo.set(target.repo_full_name, outcome.via);
        }
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
        // The person is actorUserId; `via` is the credential GitHub saw.
        via: dispatched.every(
          (entry) => viaByRepo.get(entry.repoFullName) === 'github_app',
        )
          ? 'github_app'
          : 'user_token',
        dispatched: dispatched.map((entry) => ({
          repoFullName: entry.repoFullName,
          workflowFile: entry.workflowFile,
          targetsRunCommit: entry.targetsRunCommit,
          via: viaByRepo.get(entry.repoFullName),
        })),
        failed: failed.map((entry) => entry.repoFullName),
      },
    });

    return { dispatched, failed };
  }

  private async dispatchOne(
    target: QaRunRepositoryRow,
    actor: QaRunActorContext,
  ): Promise<{
    result: QaAutomationDispatchResult | QaAutomationDispatchFailure;
    via?: QaWriteVia;
  }> {
    const base = {
      projectId: target.project_id,
      repoFullName: target.repo_full_name,
    };
    const refused = (message: string) => ({
      result: {
        ...base,
        code: 'DISPATCH_REFUSED' as const,
        message: `GitHub refused to start the verify workflow in ${target.repo_full_name}: ${message}`,
      },
    });

    const repository = await this.access.findVisibleProject(
      target.project_id,
      actor.userId,
    );
    if (!repository) {
      return {
        result: {
          ...base,
          code: 'DISPATCH_REFUSED',
          message: 'This repository is no longer available to you.',
        },
      };
    }

    const workflowFile = resolveVerifyWorkflowFile(repository.workflow_path);
    const ref = QA_BRANCH;

    try {
      // ALPHACI has already checked the role, visibility and sign-off rules;
      // the write itself goes out as the GitHub App (the org's default
      // repository permission is read, so the person's own token cannot
      // dispatch). The person's token is only the fallback.
      const credential = await this.heads.resolveWriteCredential(
        target.repo_full_name,
        actor.userId,
        actor.oauthToken,
      );
      if (!credential) {
        return {
          result: {
            ...base,
            code: 'GITHUB_REAUTH',
            message: 'Sign in to GitHub again, then retry.',
          },
        };
      }

      // Read with the token the dispatch itself uses below.
      const branches = await this.githubService.listBranches(
        credential.token,
        target.repo_full_name,
      );
      const head = branches.find((candidate) => candidate.name === ref);
      const headSha = head?.commitSha ?? target.head_sha;

      const result = await this.githubService.dispatchWorkflow(
        credential.token,
        target.repo_full_name,
        workflowFile,
        ref,
      );
      if (!result.dispatched) {
        if (result.reason === 'unauthorized') {
          return {
            result: {
              ...base,
              code: 'GITHUB_REAUTH',
              message:
                'GitHub no longer accepts your sign-in. Sign in again, then retry.',
            },
          };
        }
        if (result.reason === 'not_found') {
          return {
            result: {
              ...base,
              code: 'VERIFY_WORKFLOW_MISSING',
              message: `${target.repo_full_name} has no verify workflow yet.`,
            },
          };
        }
        return refused(result.message);
      }

      return {
        via: credential.via,
        result: {
          ...base,
          workflowFile,
          ref,
          headSha,
          targetsRunCommit: headSha === target.head_sha,
        },
      };
    } catch (error) {
      return refused((error as Error).message);
    }
  }
}
