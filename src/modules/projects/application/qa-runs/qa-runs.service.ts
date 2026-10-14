import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { QA_BRANCH } from '#kernel/config/pipeline-branches';
import type { DeploymentProjectReference } from '#kernel/ports/deployment-runtime.port';
import { canRequestRetest } from '../../domain/qa-run-access.rules';
import { QaProjectRunsRepository } from '../../infrastructure/qa-project-runs.repository';
import { QaRequirementsRepository } from '../../infrastructure/qa-requirements.repository';
import {
  QaRunsRepository,
  type QaRunItemRow,
  type QaRunSignoffRow,
  type QaVerificationRunRow,
} from '../../infrastructure/qa-runs.repository';
import type { ProvisionedProjectRow } from '../../infrastructure/projects.repository';
import { ProjectIterationsService } from '../qa-checklists/project-iterations.service';
import { QaAccessService } from '../qa-checklists/qa-access.service';
import { QaProjectContextService } from '../qa-checklists/qa-project-context.service';
import { qaRunLegacyReadonly } from '../qa-checklists/qa-errors';
import { QaRequirementsService } from '../qa-checklists/qa-requirements.service';
import { QaAutomationService } from './qa-automation.service';
import { matchAutomatedResult } from './qa-automation-matching';
import { QaCommitResolutionService } from './qa-commit-resolution.service';
import { QaProjectRunsService } from './qa-project-runs.service';
import { computeSummary, toRunItem, toSignoff } from './qa-run.mappers';
import {
  QA_RUNS_LIST_DEFAULT_LIMIT,
  QA_RUNS_LIST_MAX_LIMIT,
  type ProjectQaRun,
  type QaMyItems,
  type QaMyItemsFeedItem,
  type QaReturnedItem,
  type QaRun,
  type QaRunActorContext,
  type QaRunAutomation,
  type QaRunItem,
  type QaRunItemPrevious,
  type QaRunListItem,
  type QaRunPermissions,
} from './qa-runs.contracts';
import type { RequestRetestDto } from './dto/request-retest.dto';

export type { QaRunActorContext };

/**
 * Fields modeled as `T | undefined` (not `field?: T`): the controller always
 * passes all three keys positionally from raw, possibly-absent query params
 * — see the same note on UpdateQaRunItemPatch in qa-runs.repository.ts for
 * why that matters under this repo's `exactOptionalPropertyTypes: true`.
 */
export interface ListQaRunsFilter {
  branch: string | undefined;
  checklistId: string | undefined;
  limit: number | undefined;
}

export interface QaCurrentRunResult {
  commitSha: string | null;
  commitSource: 'deployment' | 'branch_head' | null;
  run: QaRun | null;
}

/** Repository-scope runs can no longer change: every control is off. */
const READ_ONLY_PERMISSIONS: QaRunPermissions = {
  canUpdateItems: false,
  canReturnToDev: false,
  canRequestRetest: false,
  canSignOff: false,
  canReopen: false,
};

/**
 * Repository-scope QA runs, now READ-ONLY HISTORY (docs/design/
 * project-requirements.md, section 4.3). QA verifies once per Project; the
 * Project run lives in QaProjectRunsService. This service keeps the reads the
 * deployed frontend still calls (list, current, get, report) so history stays
 * visible, refuses every write with 409 QA_RUN_LEGACY_READONLY, and derives the
 * two deprecated per-repository feeds from the repository's Project.
 *
 * Deprecated: remove with the routes, once the frontend ships on the Project
 * routes.
 */
@Injectable()
export class QaRunsService {
  constructor(
    private readonly repository: QaRunsRepository,
    private readonly access: QaAccessService,
    private readonly commitResolution: QaCommitResolutionService,
    private readonly automation: QaAutomationService,
    private readonly projectContext: QaProjectContextService,
    private readonly projectRunsService: QaProjectRunsService,
    private readonly projectRunsRepository: QaProjectRunsRepository,
    private readonly requirementsRepository: QaRequirementsRepository,
    private readonly requirementsService: QaRequirementsService,
    private readonly iterations: ProjectIterationsService,
  ) {}

  async listForProject(
    projectId: string,
    userId: string,
    filter: ListQaRunsFilter,
  ): Promise<{ items: QaRunListItem[] }> {
    await this.requireVisibleProject(projectId, userId);

    const runs = await this.repository.listRunsForProject(projectId, {
      branch: this.normalizeOptionalBranch(filter.branch),
      checklistId: filter.checklistId?.trim() || null,
      limit: this.clampLimit(filter.limit),
    });
    if (runs.length === 0) {
      return { items: [] };
    }

    const runIds = runs.map((run) => run.id);
    const [itemsByRun, signoffsByRun] = await Promise.all([
      this.repository.listItemsByRunIds(runIds),
      this.repository.findActiveSignoffsByRunIds(runIds),
    ]);

    return {
      items: runs.map((run) =>
        this.toListItem(
          run,
          itemsByRun.get(run.id) ?? [],
          signoffsByRun.get(run.id) ?? null,
        ),
      ),
    };
  }

  async current(
    projectId: string,
    actor: QaRunActorContext,
    branch: string,
    checklistId: string | undefined,
  ): Promise<QaCurrentRunResult> {
    const project = await this.requireVisibleProject(projectId, actor.userId);
    const normalizedBranch = branch.trim();
    if (normalizedBranch !== QA_BRANCH) {
      throw new BadRequestException(
        `QA verification runs are only supported on the ${QA_BRANCH} branch.`,
      );
    }

    const resolved = await this.commitResolution.resolve(
      this.toProjectReference(project, actor.userId),
      normalizedBranch,
      actor.oauthToken,
    );
    if (!resolved) {
      return { commitSha: null, commitSource: null, run: null };
    }

    const trimmedChecklistId = checklistId?.trim();
    const runRow = trimmedChecklistId
      ? await this.repository.findRunByKey(
          projectId,
          trimmedChecklistId,
          normalizedBranch,
          resolved.commitSha,
        )
      : null;
    if (!runRow) {
      return {
        commitSha: resolved.commitSha,
        commitSource: resolved.commitSource,
        run: null,
      };
    }

    const [items, signoff] = await Promise.all([
      this.repository.listItemsByRunId(runRow.id),
      this.repository.findActiveSignoff(runRow.id),
    ]);
    return {
      commitSha: resolved.commitSha,
      commitSource: resolved.commitSource,
      run: await this.assembleRun(project, runRow, items, signoff),
    };
  }

  async getById(
    projectId: string,
    userId: string,
    runId: string,
  ): Promise<QaRun> {
    const project = await this.requireVisibleProject(projectId, userId);
    const run = await this.requireRun(projectId, runId);
    const [items, signoff] = await Promise.all([
      this.repository.listItemsByRunId(run.id),
      this.repository.findActiveSignoff(run.id),
    ]);
    return this.assembleRun(project, run, items, signoff);
  }

  // ---------------------------------------------------------------------
  // Writes: refused. Repository-scope runs are history.
  // ---------------------------------------------------------------------

  /** Creating a repository-scope run is refused with a pointer to the Project's runs. */
  async create(projectId: string, actor: QaRunActorContext): Promise<never> {
    await this.requireVisibleProject(projectId, actor.userId);
    throw await this.readonlyError(projectId);
  }

  /** PATCH item, sign-off, reopen and dispatch on a repository-scope run. */
  async refuseWrite(
    projectId: string,
    actor: QaRunActorContext,
    runId: string,
  ): Promise<never> {
    await this.requireVisibleProject(projectId, actor.userId);
    await this.requireRun(projectId, runId);
    throw await this.readonlyError(projectId);
  }

  /**
   * POST .../items/:itemId/request-retest. On a repository-scope run:
   * QA_RUN_LEGACY_READONLY. On a Project run (addressed through any of the
   * Project's repositories) it is an alias that sets the item's Progress to
   * `done`, with the same effects and notification, and answers with the
   * Project run.
   */
  async requestRetest(
    projectId: string,
    actor: QaRunActorContext,
    runId: string,
    itemId: string,
    dto: RequestRetestDto,
  ): Promise<ProjectQaRun> {
    await this.requireVisibleProject(projectId, actor.userId);

    const legacyRun = await this.repository.findRunForProject(projectId, runId);
    if (legacyRun) {
      throw await this.readonlyError(projectId);
    }

    const project =
      await this.projectContext.findProjectOfRepository(projectId);
    const found = project
      ? await this.projectRunsRepository.findRunItemWithProjectRun(itemId)
      : null;
    if (
      !project ||
      !found ||
      found.run.id !== runId ||
      found.run.delivery_project_id !== project.deliveryProjectId
    ) {
      throw new NotFoundException('QA run not found');
    }
    await this.iterations.assertRowWritable(found.run);

    const role = await this.access.findAppRole(actor.userId);
    if (!canRequestRetest(role)) {
      throw new ForbiddenException(
        'Only a developer, lead, or admin may request a retest.',
      );
    }

    const { requirement_id: requirementId, source_item_id: sourceItemId } =
      found.item;
    const source =
      requirementId && sourceItemId
        ? await this.requirementsRepository.findItem(
            requirementId,
            sourceItemId,
          )
        : null;
    if (!requirementId || !sourceItemId || !source) {
      throw new NotFoundException(
        'The requirement behind this item was removed.',
      );
    }

    await this.requirementsService.setProgress(
      requirementId,
      sourceItemId,
      actor,
      {
        progress: 'done',
        expectedRowVersion: source.row_version,
        note: dto.note ?? null,
      },
    );
    return this.projectRunsService.getById(
      project.deliveryProjectId,
      actor,
      runId,
    );
  }

  // ---------------------------------------------------------------------
  // Deprecated per-repository feeds, derived from the repository's Project
  // ---------------------------------------------------------------------

  async listReturnedItems(
    projectId: string,
    actor: QaRunActorContext,
  ): Promise<{ items: QaReturnedItem[] }> {
    const feed = await this.projectFeed(projectId, actor);
    return { items: await this.toLegacyItems(projectId, feed.returned) };
  }

  /**
   * `returned` = the Project's returned items; `developerItems` = its
   * in-progress and to-do items that have a run item. An item with no run item
   * yet cannot be expressed in the old shape (it has no run), so it only shows
   * on the Project-wide feed.
   */
  async listMyItems(
    projectId: string,
    actor: QaRunActorContext,
  ): Promise<QaMyItems> {
    const feed = await this.projectFeed(projectId, actor);
    const [returned, developerItems] = await Promise.all([
      this.toLegacyItems(projectId, feed.returned),
      this.toLegacyItems(projectId, [...feed.inProgress, ...feed.todo]),
    ]);
    return { returned, developerItems };
  }

  private async projectFeed(projectId: string, actor: QaRunActorContext) {
    await this.requireVisibleProject(projectId, actor.userId);
    const project =
      await this.projectContext.findProjectOfRepository(projectId);
    if (!project) {
      return { returned: [], inProgress: [], todo: [], readyForQa: [] };
    }
    return this.projectRunsService.myItems(project.deliveryProjectId, actor);
  }

  private async toLegacyItems(
    projectId: string,
    entries: QaMyItemsFeedItem[],
  ): Promise<QaReturnedItem[]> {
    const withRun = entries.filter(
      (
        entry,
      ): entry is QaMyItemsFeedItem & {
        runId: string;
        runItem: NonNullable<QaMyItemsFeedItem['runItem']>;
      } => entry.runId !== null && entry.runItem !== null,
    );
    const coverage = await this.projectRunsRepository.listCoverageByRunIds([
      ...new Set(withRun.map((entry) => entry.runId)),
    ]);
    return withRun.map((entry) => ({
      runId: entry.runId,
      branch: QA_BRANCH,
      commitSha:
        coverage.get(entry.runId)?.find((row) => row.project_id === projectId)
          ?.head_sha ?? '',
      checklistName: entry.requirement.name,
      item: entry.runItem,
    }));
  }

  // ---------------------------------------------------------------------
  // Access / lookup helpers
  // ---------------------------------------------------------------------

  private async readonlyError(projectId: string) {
    const project =
      await this.projectContext.findProjectOfRepository(projectId);
    return qaRunLegacyReadonly(
      project
        ? `/delivery-projects/${project.deliveryProjectId}/qa-runs`
        : null,
    );
  }

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

  private async requireRun(
    projectId: string,
    runId: string,
  ): Promise<QaVerificationRunRow> {
    const run = await this.repository.findRunForProject(projectId, runId);
    if (!run) {
      throw new NotFoundException('QA run not found');
    }
    return run;
  }

  private normalizeOptionalBranch(branch: string | undefined): string | null {
    const trimmed = branch?.trim();
    return trimmed ? trimmed : null;
  }

  private clampLimit(raw: number | undefined): number {
    if (raw === undefined || !Number.isFinite(raw)) {
      return QA_RUNS_LIST_DEFAULT_LIMIT;
    }
    return Math.max(1, Math.min(QA_RUNS_LIST_MAX_LIMIT, Math.trunc(raw)));
  }

  private toProjectReference(
    project: ProvisionedProjectRow,
    userId: string,
  ): DeploymentProjectReference {
    return {
      projectId: project.id,
      userId,
      repoFullName: project.repo_full_name,
      repoUrl: project.repo_url,
      workflowPath: project.workflow_path,
      projectOptions: project.project_options,
    };
  }

  // ---------------------------------------------------------------------
  // Assembly (row -> API contract)
  // ---------------------------------------------------------------------

  private async assembleRun(
    project: ProvisionedProjectRow,
    run: QaVerificationRunRow,
    items: QaRunItemRow[],
    signoff: QaRunSignoffRow | null,
  ): Promise<QaRun> {
    const [priorSummaries, runAutomation] = await Promise.all([
      this.repository.findPriorItemSummaries(
        items
          .map((item) => item.prior_run_item_id)
          .filter((id): id is string => id !== null),
      ),
      this.automation.forRun(
        project.repo_full_name,
        run.branch,
        run.commit_sha,
      ),
    ]);

    return {
      ...this.toListItem(run, items, signoff),
      items: items.map((item) =>
        this.toLegacyRunItem(item, priorSummaries, runAutomation),
      ),
      permissions: READ_ONLY_PERMISSIONS,
      automation: runAutomation,
    };
  }

  private toLegacyRunItem(
    item: QaRunItemRow,
    priorSummaries: Map<string, QaRunItemPrevious>,
    runAutomation: QaRunAutomation,
  ): QaRunItem {
    return toRunItem(
      item,
      item.prior_run_item_id
        ? (priorSummaries.get(item.prior_run_item_id) ?? null)
        : null,
      false,
      matchAutomatedResult(
        {
          verificationType: item.verification_type,
          testIdentifier: item.test_identifier,
        },
        runAutomation,
      ),
    );
  }

  private toListItem(
    run: QaVerificationRunRow,
    items: QaRunItemRow[],
    signoff: QaRunSignoffRow | null,
  ): QaRunListItem {
    return {
      id: run.id,
      scope: 'repository',
      legacy: true,
      projectId: run.project_id,
      checklistId: run.checklist_id,
      checklistName: run.checklist_name,
      checklistVersion: run.checklist_version,
      branch: run.branch,
      commitSha: run.commit_sha,
      commitSource: run.commit_source,
      status: run.status,
      createdBy: { id: run.created_by, login: run.created_by_login },
      createdAt: run.created_at,
      updatedAt: run.updated_at,
      summary: computeSummary(items),
      signoff: signoff ? toSignoff(signoff) : null,
    };
  }
}
