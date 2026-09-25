import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';

import { HOSTED_BRANCHES } from '#kernel/config/pipeline-branches';
import {
  AuditEventPublisher,
  NotificationEventPublisher,
} from '#kernel/events/platform-event-publisher.js';
import type { DeploymentProjectReference } from '#kernel/ports/deployment-runtime.port';
import type { PlatformAppRole } from '#kernel/ports/platform-admin.port';
import {
  canCreateRun,
  canReopenRun,
  canRequestRetest as roleCanRequestRetest,
  canSetReturnedToDev,
  canSignOff as roleCanSignOff,
  personaAllowsRole,
} from '../../domain/qa-run-access.rules';
import {
  QaChecklistsRepository,
  type QaChecklistItemRow,
} from '../../infrastructure/qa-checklists.repository';
import {
  QaRunItemsChangedError,
  QaRunNotOpenError,
  QaRunsRepository,
  type QaRunItemRow,
  type QaRunSignoffRow,
  type QaVerificationRunRow,
} from '../../infrastructure/qa-runs.repository';
import type { ProvisionedProjectRow } from '../../infrastructure/projects.repository';
import { QaAccessService } from '../qa-checklists/qa-access.service';
import { QaCommitResolutionService } from './qa-commit-resolution.service';
import {
  QA_OPEN_DEFECT_STATUSES,
  QA_RUNS_LIST_DEFAULT_LIMIT,
  QA_RUNS_LIST_MAX_LIMIT,
  type QaActor,
  type QaRun,
  type QaRunItem,
  type QaRunItemPrevious,
  type QaRunItemStatus,
  type QaRunListItem,
  type QaRunPermissions,
  type QaRunSummaryCounts,
  type QaReturnedItem,
  type QaSignoff,
} from './qa-runs.contracts';
import type { CreateQaRunDto } from './dto/create-qa-run.dto';
import type { PatchQaRunItemDto } from './dto/patch-qa-run-item.dto';
import type { RequestRetestDto } from './dto/request-retest.dto';
import type { SignoffQaRunDto } from './dto/signoff-qa-run.dto';

type AuditEventSink = Pick<AuditEventPublisher, 'recordProjectEvent'>;
type NotificationEventSink = Pick<NotificationEventPublisher, 'record'>;

export interface QaRunActorContext {
  userId: string;
  userLogin: string;
  /** The session's GitHub OAuth token, for commit resolution's token fallback chain. */
  oauthToken: string | null;
}

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

const QA_RUN_EVENTS = {
  created: 'qa.run.created',
  signedOff: 'qa.run.signed_off',
  reopened: 'qa.run.reopened',
  itemStatusChanged: 'qa.item.status_changed',
} as const;

const NOTIFICATION_BODY_TRUNCATE_LENGTH = 300;
const RETEST_NOTIFICATION_TRUNCATE_LENGTH = 300;
const SIGNOFF_SUMMARY_TRUNCATE_LENGTH = 300;

@Injectable()
export class QaRunsService {
  constructor(
    private readonly repository: QaRunsRepository,
    private readonly qaChecklistsRepository: QaChecklistsRepository,
    private readonly access: QaAccessService,
    private readonly commitResolution: QaCommitResolutionService,
    @Optional()
    private readonly auditEventsService?: AuditEventSink,
    @Optional()
    private readonly notificationEventsService?: NotificationEventSink,
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
    const normalizedBranch = this.normalizeBranch(branch);
    this.requireHostedBranch(normalizedBranch);

    const resolved = await this.commitResolution.resolve(
      this.toProjectReference(project, actor.userId),
      normalizedBranch,
      actor.oauthToken,
    );
    if (!resolved) {
      return { commitSha: null, commitSource: null, run: null };
    }

    const trimmedChecklistId = checklistId?.trim();
    if (!trimmedChecklistId) {
      return {
        commitSha: resolved.commitSha,
        commitSource: resolved.commitSource,
        run: null,
      };
    }

    const runRow = await this.repository.findRunByKey(
      projectId,
      trimmedChecklistId,
      normalizedBranch,
      resolved.commitSha,
    );
    if (!runRow) {
      return {
        commitSha: resolved.commitSha,
        commitSource: resolved.commitSource,
        run: null,
      };
    }

    const role = await this.access.findAppRole(actor.userId);
    const [items, signoff] = await Promise.all([
      this.repository.listItemsByRunId(runRow.id),
      this.repository.findActiveSignoff(runRow.id),
    ]);
    return {
      commitSha: resolved.commitSha,
      commitSource: resolved.commitSource,
      run: await this.assembleRun(runRow, items, signoff, role),
    };
  }

  async create(
    projectId: string,
    actor: QaRunActorContext,
    dto: CreateQaRunDto,
  ): Promise<{ created: boolean; run: QaRun }> {
    const project = await this.requireVisibleProject(projectId, actor.userId);

    const role = await this.access.findAppRole(actor.userId);
    if (!canCreateRun(role)) {
      throw new ForbiddenException(
        'Only QA, a lead, or an admin may start a verification run.',
      );
    }

    const branch = this.normalizeBranch(dto.branch);
    this.requireHostedBranch(branch);

    const checklist = await this.requireChecklistSharedToProject(
      projectId,
      dto.checklistId,
    );

    const resolved = await this.commitResolution.resolve(
      this.toProjectReference(project, actor.userId),
      branch,
      actor.oauthToken,
    );
    if (!resolved) {
      throw new ConflictException(
        `No deployed or pushed commit was found for ${branch}.`,
      );
    }

    const checklistItems = await this.checklistItemsFor(checklist.id);

    const result = await this.repository.createRun({
      projectId,
      checklistId: checklist.id,
      checklistVersion: checklist.version,
      checklistName: checklist.name,
      branch,
      commitSha: resolved.commitSha,
      commitSource: resolved.commitSource,
      createdBy: actor.userId,
      createdByLogin: actor.userLogin,
      checklistItems,
    });

    if (result.created) {
      await this.recordAudit(
        QA_RUN_EVENTS.created,
        project,
        actor.userId,
        result.run,
        { branch, commitSha: resolved.commitSha },
      );
    }

    const signoff = result.created
      ? null
      : await this.repository.findActiveSignoff(result.run.id);
    const run = await this.assembleRun(result.run, result.items, signoff, role);
    return { created: result.created, run };
  }

  async getById(
    projectId: string,
    userId: string,
    runId: string,
  ): Promise<QaRun> {
    await this.requireVisibleProject(projectId, userId);
    const run = await this.requireRun(projectId, runId);

    const [items, signoff, role] = await Promise.all([
      this.repository.listItemsByRunId(run.id),
      this.repository.findActiveSignoff(run.id),
      this.access.findAppRole(userId),
    ]);
    return this.assembleRun(run, items, signoff, role);
  }

  async updateItem(
    projectId: string,
    actor: QaRunActorContext,
    runId: string,
    itemId: string,
    dto: PatchQaRunItemDto,
  ): Promise<QaRun> {
    const project = await this.requireVisibleProject(projectId, actor.userId);
    const run = await this.requireRun(projectId, runId);
    const item = await this.requireItem(run.id, itemId);
    this.requireRunOpen(run);

    const role = await this.access.findAppRole(actor.userId);
    if (!personaAllowsRole(item.target_persona, role)) {
      throw new ForbiddenException('You are not allowed to update this item.');
    }
    if (dto.status === 'returned_to_dev' && !canSetReturnedToDev(role)) {
      throw new ForbiddenException(
        'Only QA, a lead, or an admin may return an item to development.',
      );
    }

    const effectiveSeverity =
      dto.defectSeverity !== undefined
        ? dto.defectSeverity
        : item.defect_severity;
    if (
      dto.status !== undefined &&
      (dto.status === 'failed' || dto.status === 'returned_to_dev') &&
      !effectiveSeverity
    ) {
      throw new BadRequestException(
        'A defect severity is required to mark this item failed or returned to dev.',
      );
    }

    const runActor = { id: actor.userId, login: actor.userLogin };
    const updated = await this.withOpenRun(() =>
      this.repository.updateItem(
        run.id,
        itemId,
        dto.expectedRowVersion,
        {
          status: dto.status,
          notes: dto.notes,
          defectSeverity: dto.defectSeverity,
          reproductionSteps: dto.reproductionSteps,
        },
        runActor,
        item.status,
      ),
    );
    if (!updated) {
      // `code` is the machine-readable signal the frontend keys its
      // "Reload run" action on; the sentence is for people.
      throw new ConflictException({
        code: 'QA_ITEM_STALE',
        message: `This item has changed (expected row version ${dto.expectedRowVersion}); reload and try again.`,
      });
    }

    if (dto.status !== undefined) {
      await this.recordAudit(
        QA_RUN_EVENTS.itemStatusChanged,
        project,
        actor.userId,
        run,
        { itemId, fromStatus: item.status, toStatus: updated.status },
      );
      await this.notifyOnStatusChange(project, run, updated, runActor);
    }

    const [items, signoff] = await Promise.all([
      this.repository.listItemsByRunId(run.id),
      this.repository.findActiveSignoff(run.id),
    ]);
    return this.assembleRun(run, items, signoff, role);
  }

  async requestRetest(
    projectId: string,
    actor: QaRunActorContext,
    runId: string,
    itemId: string,
    dto: RequestRetestDto,
  ): Promise<QaRun> {
    const project = await this.requireVisibleProject(projectId, actor.userId);
    const run = await this.requireRun(projectId, runId);
    const item = await this.requireItem(run.id, itemId);
    this.requireRunOpen(run);

    const role = await this.access.findAppRole(actor.userId);
    if (!roleCanRequestRetest(role)) {
      throw new ForbiddenException(
        'Only a developer, lead, or admin may request a retest.',
      );
    }
    if (item.status !== 'returned_to_dev') {
      throw new ConflictException(
        'This item is not currently returned to dev.',
      );
    }

    const previousVerifierId = item.verified_by;
    const runActor = { id: actor.userId, login: actor.userLogin };
    const note = dto.note ?? null;
    const updated = await this.withOpenRun(() =>
      this.repository.requestRetest(run.id, itemId, runActor, note),
    );
    if (!updated) {
      throw new ConflictException(
        'This item is not currently returned to dev.',
      );
    }

    if (previousVerifierId && previousVerifierId !== actor.userId) {
      await this.notifyMany(
        [previousVerifierId],
        project.id,
        'qa.item.retest_requested',
        `A retest was requested for "${updated.title}" on ${run.branch}`,
        note
          ? this.truncate(note, RETEST_NOTIFICATION_TRUNCATE_LENGTH)
          : 'No additional notes.',
      );
    }

    const [items, signoff] = await Promise.all([
      this.repository.listItemsByRunId(run.id),
      this.repository.findActiveSignoff(run.id),
    ]);
    return this.assembleRun(run, items, signoff, role);
  }

  async signoff(
    projectId: string,
    actor: QaRunActorContext,
    runId: string,
    dto: SignoffQaRunDto,
  ): Promise<QaRun> {
    const project = await this.requireVisibleProject(projectId, actor.userId);
    const run = await this.requireRun(projectId, runId);
    this.requireRunOpen(run);

    const role = await this.access.findAppRole(actor.userId);
    if (!roleCanSignOff(role)) {
      throw new ForbiddenException(
        'Only QA, a lead, or an admin may sign off a run.',
      );
    }

    const items = await this.repository.listItemsByRunId(run.id);
    this.validateVerdict(dto, items);

    const now = new Date().toISOString();
    const signoffId = randomUUID();
    const summary = dto.summary ?? null;
    const conditions = dto.conditions ?? null;
    const signedBy: QaActor = { id: actor.userId, login: actor.userLogin };

    const signedOffRun: QaVerificationRunRow = {
      ...run,
      status: 'signed_off',
      updated_at: now,
    };
    const signoffForReport: QaSignoff = {
      id: signoffId,
      verdict: dto.verdict,
      summary,
      conditions,
      signedBy,
      signedAt: now,
    };
    const reportBase = await this.assembleRun(signedOffRun, items, null, role);
    const report: QaRun = { ...reportBase, signoff: signoffForReport };

    const result = await this.repository
      .createSignoff({
        id: signoffId,
        runId: run.id,
        verdict: dto.verdict,
        summary,
        conditions,
        signedBy: actor.userId,
        signedByLogin: actor.userLogin,
        signedAt: now,
        reportJson: report as unknown as Record<string, unknown>,
        expectedItems: {
          count: items.length,
          rowVersionSum: items.reduce((sum, item) => sum + item.row_version, 0),
        },
      })
      .catch((error: unknown) => {
        if (error instanceof QaRunItemsChangedError) {
          throw new ConflictException({
            code: 'QA_RUN_CHANGED',
            message:
              'This run changed while you were signing off. Review the latest results and sign off again.',
          });
        }
        throw error;
      });
    if (!result) {
      throw new ConflictException(
        'This run is signed off. Reopen it to make changes.',
      );
    }

    await this.recordAudit(
      QA_RUN_EVENTS.signedOff,
      project,
      actor.userId,
      result.run,
      { verdict: dto.verdict },
    );
    await this.notifySignoff(project, result.run, result.signoff, actor.userId);

    return this.assembleRun(result.run, items, result.signoff, role);
  }

  async reopen(
    projectId: string,
    actor: QaRunActorContext,
    runId: string,
  ): Promise<QaRun> {
    const project = await this.requireVisibleProject(projectId, actor.userId);
    const run = await this.requireRun(projectId, runId);

    const role = await this.access.findAppRole(actor.userId);
    if (!canReopenRun(role)) {
      throw new ForbiddenException(
        'Only a lead or admin may reopen a signed-off run.',
      );
    }
    if (run.status !== 'signed_off') {
      throw new ConflictException('This run is not signed off.');
    }

    const reopened = await this.repository.reopenRun(run.id, {
      id: actor.userId,
      login: actor.userLogin,
    });
    if (!reopened) {
      throw new ConflictException('This run is not signed off.');
    }

    await this.recordAudit(
      QA_RUN_EVENTS.reopened,
      project,
      actor.userId,
      reopened,
      {},
    );

    const [items, signoff] = await Promise.all([
      this.repository.listItemsByRunId(reopened.id),
      this.repository.findActiveSignoff(reopened.id),
    ]);
    return this.assembleRun(reopened, items, signoff, role);
  }

  async listReturnedItems(
    projectId: string,
    userId: string,
  ): Promise<{ items: QaReturnedItem[] }> {
    await this.requireVisibleProject(projectId, userId);
    const role = await this.access.findAppRole(userId);
    const rows = await this.repository.listReturnedItemsForProject(projectId);
    if (rows.length === 0) {
      return { items: [] };
    }

    const priorIds = rows
      .map((row) => row.item.prior_run_item_id)
      .filter((id): id is string => id !== null);
    const priorSummaries =
      await this.repository.findPriorItemSummaries(priorIds);

    return {
      items: rows.map((row) => ({
        runId: row.item.run_id,
        branch: row.runBranch,
        commitSha: row.runCommitSha,
        checklistName: row.runChecklistName,
        item: this.toRunItem(
          row.item,
          this.priorFor(row.item, priorSummaries),
          'open',
          role,
        ),
      })),
    };
  }

  // ---------------------------------------------------------------------
  // Access / lookup helpers
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

  private async requireItem(
    runId: string,
    itemId: string,
  ): Promise<QaRunItemRow> {
    const item = await this.repository.findItemForRun(runId, itemId);
    if (!item) {
      throw new NotFoundException('QA run item not found');
    }
    return item;
  }

  /**
   * Runs an item write whose transaction re-checks, under a lock on the run
   * row, that the run is still open. requireRunOpen() answers the common case
   * early; this closes the window where a signoff commits in between.
   */
  private async withOpenRun<T>(write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } catch (error) {
      if (error instanceof QaRunNotOpenError) {
        throw new ConflictException(
          'This run is signed off. Reopen it to make changes.',
        );
      }
      throw error;
    }
  }

  private requireRunOpen(run: QaVerificationRunRow): void {
    if (run.status === 'signed_off') {
      throw new ConflictException(
        'This run is signed off. Reopen it to make changes.',
      );
    }
  }

  private async requireChecklistSharedToProject(
    projectId: string,
    checklistId: string,
  ) {
    const checklists =
      await this.qaChecklistsRepository.listByProject(projectId);
    const checklist = checklists.find((item) => item.id === checklistId);
    if (!checklist) {
      throw new ConflictException(
        'This checklist is not shared to this project, or is archived.',
      );
    }
    return checklist;
  }

  private async checklistItemsFor(
    checklistId: string,
  ): Promise<QaChecklistItemRow[]> {
    const map = await this.qaChecklistsRepository.listItemsByChecklistIds([
      checklistId,
    ]);
    return map.get(checklistId) ?? [];
  }

  private requireHostedBranch(branch: string): void {
    if (!(HOSTED_BRANCHES as readonly string[]).includes(branch)) {
      throw new BadRequestException(
        `QA verification runs are only supported on hosted branches (${HOSTED_BRANCHES.join(', ')}).`,
      );
    }
  }

  private normalizeBranch(branch: string): string {
    return branch.trim();
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

  private validateVerdict(dto: SignoffQaRunDto, items: QaRunItemRow[]): void {
    if (dto.verdict === 'APPROVED') {
      const notPassed = items.filter((item) => item.status !== 'passed').length;
      if (notPassed > 0) {
        throw new ConflictException(
          `${notPassed} item(s) are not yet passed; an APPROVED sign-off requires every item to be passed.`,
        );
      }
      return;
    }
    if (dto.verdict === 'CONDITIONAL') {
      const stillInProgress = items.some(
        (item) => item.status === 'pending' || item.status === 'in_progress',
      );
      if (stillInProgress) {
        throw new ConflictException(
          'A CONDITIONAL sign-off requires no item to remain pending or in progress.',
        );
      }
      if (!dto.conditions || dto.conditions.trim().length === 0) {
        throw new BadRequestException(
          'conditions is required for a CONDITIONAL verdict.',
        );
      }
    }
    // REJECTED: always allowed, no item-state requirement.
  }

  // ---------------------------------------------------------------------
  // Assembly (row -> API contract)
  // ---------------------------------------------------------------------

  private async assembleRun(
    run: QaVerificationRunRow,
    items: QaRunItemRow[],
    signoff: QaRunSignoffRow | null,
    role: PlatformAppRole,
  ): Promise<QaRun> {
    const priorIds = items
      .map((item) => item.prior_run_item_id)
      .filter((id): id is string => id !== null);
    const priorSummaries =
      await this.repository.findPriorItemSummaries(priorIds);

    const runItems = items.map((item) =>
      this.toRunItem(
        item,
        this.priorFor(item, priorSummaries),
        run.status,
        role,
      ),
    );

    return {
      ...this.toListItem(run, items, signoff),
      items: runItems,
      permissions: this.computePermissions(run, items, role),
    };
  }

  private priorFor(
    item: QaRunItemRow,
    priorSummaries: Map<
      string,
      { runId: string; commitSha: string; status: QaRunItemStatus }
    >,
  ): QaRunItemPrevious | null {
    if (!item.prior_run_item_id) {
      return null;
    }
    return priorSummaries.get(item.prior_run_item_id) ?? null;
  }

  private toListItem(
    run: QaVerificationRunRow,
    items: QaRunItemRow[],
    signoff: QaRunSignoffRow | null,
  ): QaRunListItem {
    return {
      id: run.id,
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
      summary: this.computeSummary(items),
      signoff: signoff ? this.toSignoff(signoff) : null,
    };
  }

  private computeSummary(items: QaRunItemRow[]): QaRunSummaryCounts {
    const byStatus: Record<QaRunItemStatus, number> = {
      pending: 0,
      in_progress: 0,
      passed: 0,
      failed: 0,
      blocked: 0,
      returned_to_dev: 0,
    };
    let blockers = 0;
    for (const item of items) {
      byStatus[item.status] += 1;
      if (
        QA_OPEN_DEFECT_STATUSES.includes(item.status) &&
        item.defect_severity === 'blocker'
      ) {
        blockers += 1;
      }
    }
    const openDefects = QA_OPEN_DEFECT_STATUSES.reduce(
      (sum, status) => sum + byStatus[status],
      0,
    );
    return { total: items.length, byStatus, openDefects, blockers };
  }

  private toSignoff(row: QaRunSignoffRow): QaSignoff {
    return {
      id: row.id,
      verdict: row.verdict,
      summary: row.summary,
      conditions: row.conditions,
      signedBy: { id: row.signed_by, login: row.signed_by_login },
      signedAt: row.signed_at,
    };
  }

  private toRunItem(
    row: QaRunItemRow,
    previous: QaRunItemPrevious | null,
    runStatus: QaVerificationRunRow['status'],
    role: PlatformAppRole,
  ): QaRunItem {
    return {
      id: row.id,
      runId: row.run_id,
      position: row.position,
      title: row.title,
      description: row.description,
      targetPersona: row.target_persona,
      verificationType: row.verification_type,
      testIdentifier: row.test_identifier,
      status: row.status,
      notes: row.notes,
      defectSeverity: row.defect_severity,
      reproductionSteps: row.reproduction_steps,
      fixRequest: row.fix_requested_at
        ? {
            requestedAt: row.fix_requested_at,
            requestedBy: {
              id: row.fix_requested_by as string,
              login: row.fix_requested_by_login as string,
            },
            note: row.fix_note,
          }
        : null,
      verifiedBy: row.verified_by
        ? { id: row.verified_by, login: row.verified_by_login as string }
        : null,
      verifiedAt: row.verified_at,
      rowVersion: row.row_version,
      canUpdate:
        runStatus === 'open' && personaAllowsRole(row.target_persona, role),
      previous,
    };
  }

  private computePermissions(
    run: QaVerificationRunRow,
    items: QaRunItemRow[],
    role: PlatformAppRole,
  ): QaRunPermissions {
    const open = run.status === 'open';
    return {
      canUpdateItems:
        open &&
        items.some((item) => personaAllowsRole(item.target_persona, role)),
      canReturnToDev: open && canSetReturnedToDev(role),
      canRequestRetest: open && roleCanRequestRetest(role),
      canSignOff: open && roleCanSignOff(role),
      canReopen: !open && canReopenRun(role),
    };
  }

  // ---------------------------------------------------------------------
  // Audit + notifications
  // ---------------------------------------------------------------------

  private async recordAudit(
    eventCode: string,
    project: ProvisionedProjectRow,
    actorUserId: string,
    run: QaVerificationRunRow,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.auditEventsService?.recordProjectEvent({
      workspaceId: project.workspace_id ?? null,
      projectId: project.id,
      actorUserId,
      eventCode,
      message: `QA run "${run.checklist_name}" on ${run.branch}: ${eventCode.split('.').pop()}`,
      metadata: {
        runId: run.id,
        checklistId: run.checklist_id,
        branch: run.branch,
        ...metadata,
      },
    });
  }

  private async notifyOnStatusChange(
    project: ProvisionedProjectRow,
    run: QaVerificationRunRow,
    updated: QaRunItemRow,
    actor: { id: string; login: string },
  ): Promise<void> {
    if (updated.status === 'returned_to_dev') {
      const recipients = await this.ownerAndLeadRecipients(project, actor.id);
      const parts = [
        updated.defect_severity
          ? `Severity: ${updated.defect_severity}.`
          : null,
        updated.notes
          ? this.truncate(updated.notes, NOTIFICATION_BODY_TRUNCATE_LENGTH)
          : null,
      ].filter((part): part is string => Boolean(part));
      await this.notifyMany(
        recipients,
        project.id,
        'qa.item.returned_to_dev',
        `QA returned "${updated.title}" on ${run.branch}`,
        parts.length > 0 ? parts.join(' ') : 'No additional notes.',
      );
    }

    if (updated.status === 'blocked' && updated.defect_severity === 'blocker') {
      const leadIds = project.workspace_id
        ? await this.access.listWorkspaceLeadIds(project.workspace_id)
        : [];
      const recipients = this.dedupeExcludingActor(leadIds, actor.id);
      await this.notifyMany(
        recipients,
        project.id,
        'qa.item.blocked',
        `QA marked "${updated.title}" a blocker on ${run.branch}`,
        updated.notes
          ? this.truncate(updated.notes, NOTIFICATION_BODY_TRUNCATE_LENGTH)
          : 'No additional notes.',
      );
    }
  }

  private async notifySignoff(
    project: ProvisionedProjectRow,
    run: QaVerificationRunRow,
    signoff: QaRunSignoffRow,
    actorId: string,
  ): Promise<void> {
    const leadIds = project.workspace_id
      ? await this.access.listWorkspaceLeadIds(project.workspace_id)
      : [];
    const recipients = this.dedupeExcludingActor(
      [run.created_by, project.user_id, ...leadIds],
      actorId,
    );
    await this.notifyMany(
      recipients,
      project.id,
      'qa.run.signed_off',
      `QA run signed off (${signoff.verdict}) on ${run.branch}`,
      signoff.summary
        ? this.truncate(signoff.summary, SIGNOFF_SUMMARY_TRUNCATE_LENGTH)
        : `Verdict: ${signoff.verdict}.`,
    );
  }

  private async ownerAndLeadRecipients(
    project: ProvisionedProjectRow,
    excludeUserId: string,
  ): Promise<string[]> {
    const leadIds = project.workspace_id
      ? await this.access.listWorkspaceLeadIds(project.workspace_id)
      : [];
    return this.dedupeExcludingActor(
      [project.user_id, ...leadIds],
      excludeUserId,
    );
  }

  private dedupeExcludingActor(
    ids: Array<string | null | undefined>,
    excludeUserId: string,
  ): string[] {
    const set = new Set<string>();
    for (const id of ids) {
      if (id && id !== excludeUserId) {
        set.add(id);
      }
    }
    return [...set];
  }

  private truncate(value: string, max: number): string {
    return value.length > max ? `${value.slice(0, max)}…` : value;
  }

  private async notifyMany(
    userIds: string[],
    projectId: string,
    eventCode: string,
    title: string,
    body: string,
  ): Promise<void> {
    const notifications = this.notificationEventsService;
    if (!notifications || userIds.length === 0) {
      return;
    }
    await Promise.all(
      userIds.map((userId) =>
        notifications.record({ userId, projectId, eventCode, title, body }),
      ),
    );
  }
}
