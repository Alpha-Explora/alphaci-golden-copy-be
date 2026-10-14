import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';

import { QA_BRANCH } from '#kernel/config/pipeline-branches';
import {
  AuditEventPublisher,
  NotificationEventPublisher,
} from '#kernel/events/platform-event-publisher.js';
import type { PlatformAppRole } from '#kernel/ports/platform-admin.port';
import { acceptsFixProof } from '../../domain/qa-fix-proof.rules';
import { bucketMyQaItem } from '../../domain/qa-my-items.rules';
import {
  canCreateRun,
  canAddEvidence,
  canAddFixProof,
  canDispatchAutomation,
  canReopenRun,
  canSetReturnedToDev,
  canSetVerification,
  canSignOff,
} from '../../domain/qa-run-access.rules';
import {
  QaChecklistsRepository,
  type QaChecklistItemRow,
  type QaChecklistRow,
} from '../../infrastructure/qa-checklists.repository';
import { QaProjectRunsRepository } from '../../infrastructure/qa-project-runs.repository';
import { QaRequirementsRepository } from '../../infrastructure/qa-requirements.repository';
import {
  QaProgressNotDoneError,
  QaRunItemsChangedError,
  QaRunNotOpenError,
  QaRunsRepository,
  type QaProjectRunRow,
  type QaRunItemRow,
  type QaRunRepositoryRow,
  type QaRunSignoffRow,
} from '../../infrastructure/qa-runs.repository';
import { QaAccessService } from '../qa-checklists/qa-access.service';
import {
  QaProjectContextService,
  type QaProjectContext,
  type QaProjectRepository,
} from '../qa-checklists/qa-project-context.service';
import {
  qaNoRepositories,
  qaNoRequirements,
  qaProgressNotDone,
  qaUatBranchMissing,
  qaUatHeadUnreadable,
  verificationForbidden,
  verificationStatusInvalid,
} from '../qa-checklists/qa-errors';
import { QaRequirementsService } from '../qa-checklists/qa-requirements.service';
import type { QaProgress } from '../qa-checklists/qa-requirements.contracts';
import { QaAutomationService } from './qa-automation.service';
import { QA_ATTACHMENT_MAX_PER_ITEM } from './qa-attachments.fields';
import { QaRunAttachmentsService } from './qa-run-attachments.service';
import { matchAutomatedResult } from './qa-automation-matching';
import {
  buildQaProjectReport,
  type QaProjectReport,
} from './qa-project-report';
import { toSignoffHistoryEntry } from './qa-report.mapper';
import { computeSummary, toRunItem, toSignoff } from './qa-run.mappers';
import {
  QA_PROJECT_RUN_BRANCH,
  QA_RUNS_LIST_DEFAULT_LIMIT,
  QA_RUNS_LIST_MAX_LIMIT,
  type ProjectMyQaItems,
  type ProjectQaCurrentRun,
  type ProjectQaRun,
  type ProjectQaRunItem,
  type ProjectQaRunListItem,
  type QaAutomatedResult,
  type QaHeadStatus,
  type QaMyItemsFeedItem,
  type QaProjectRunsPage,
  type QaRunActorContext,
  type QaRunAutomation,
  type QaRunItemAttachmentRef,
  type QaRunItemPrevious,
} from './qa-runs.contracts';
import {
  QaUatHeadsService,
  fingerprintHeads,
  type QaUatHeadReading,
} from './qa-uat-heads.service';
import type { PatchQaRunItemDto } from './dto/patch-qa-run-item.dto';
import type { SignoffQaRunDto } from './dto/signoff-qa-run.dto';

type AuditEventSink = Pick<AuditEventPublisher, 'recordProjectEvent'>;
type NotificationEventSink = Pick<NotificationEventPublisher, 'record'>;

const QA_RUN_EVENTS = {
  created: 'qa.run.created',
  signedOff: 'qa.run.signed_off',
  reopened: 'qa.run.reopened',
  itemStatusChanged: 'qa.item.status_changed',
} as const;

const NOTIFICATION_BODY_TRUNCATE_LENGTH = 300;
const SIGNOFF_SUMMARY_TRUNCATE_LENGTH = 300;
/** A run view re-reads the repository heads on every item write; reuse a recent reading. */
const DISPLAY_HEAD_MAX_AGE_MS = 15_000;

/**
 * Everything assembleRun needs about the run it is rendering. `readings` is
 * the repositories' uat heads right now; null renders the run without a live
 * comparison (every currentSha null, nothing moved).
 */
interface RunView {
  project: QaProjectContext;
  run: QaProjectRunRow;
  items: QaRunItemRow[];
  signoff: QaRunSignoffRow | null;
  coverage: QaRunRepositoryRow[];
  role: PlatformAppRole;
  readings: QaUatHeadReading[] | null;
}

/**
 * Pairs the Project's repositories as they are now with the heads a run
 * captured. `coverage` null means no run is being compared (nothing moved).
 * A repository the run does not cover counts as moved: it joined the Project
 * after the run, which makes the run stale for every repository.
 */
export function buildHeadStatuses(
  repositories: readonly QaProjectRepository[],
  readings: readonly QaUatHeadReading[] | null,
  coverage: readonly QaRunRepositoryRow[] | null,
): QaHeadStatus[] {
  const captured = new Map(
    (coverage ?? []).map((row) => [row.project_id, row.head_sha]),
  );
  const current = new Map(
    (readings ?? []).map((reading) => [
      reading.repository.projectId,
      reading.kind === 'ok' ? reading.sha : null,
    ]),
  );
  return repositories.map((repository) => {
    const runSha = coverage
      ? (captured.get(repository.projectId) ?? null)
      : null;
    const currentSha = current.get(repository.projectId) ?? null;
    return {
      projectId: repository.projectId,
      repoFullName: repository.repoFullName,
      runSha,
      currentSha,
      moved: coverage !== null && currentSha !== null && runSha !== currentSha,
    };
  });
}

/**
 * Project-scope QA runs: QA verifies once per Project, against the uat head of
 * every repository captured when the run starts. Reuses the run machinery in
 * QaRunsRepository (item writes under the run lock, sign-off, reopen) - it
 * works on run_id and does not care how many repositories a run covers.
 *
 * Two tracks meet here: Progress (developers, on the requirement item) and
 * Verification (QA, on the run item). `passed` needs the source item's
 * Progress to be `done`; `returned_to_dev` puts it back to `in_progress`; and
 * a developer marking it `done` again re-queues it for QA (see
 * QaRequirementsService.setProgress).
 */
@Injectable()
export class QaProjectRunsService {
  constructor(
    private readonly runs: QaRunsRepository,
    private readonly projectRuns: QaProjectRunsRepository,
    private readonly checklists: QaChecklistsRepository,
    private readonly requirements: QaRequirementsRepository,
    private readonly requirementsService: QaRequirementsService,
    private readonly access: QaAccessService,
    private readonly projectContext: QaProjectContextService,
    private readonly heads: QaUatHeadsService,
    private readonly automation: QaAutomationService,
    private readonly attachments: QaRunAttachmentsService,
    // Explicit tokens: the sink aliases are type aliases, which TypeScript
    // emits as `Object` in design:paramtypes, so without @Inject Nest finds no
    // provider and @Optional() silently injects undefined.
    @Optional()
    @Inject(AuditEventPublisher)
    private readonly auditEventsService?: AuditEventSink,
    @Optional()
    @Inject(NotificationEventPublisher)
    private readonly notificationEventsService?: NotificationEventSink,
  ) {}

  // ---------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------

  async list(
    deliveryProjectId: string,
    userId: string,
    options: { limit: number | undefined; cursor: string | undefined },
  ): Promise<QaProjectRunsPage> {
    const project = await this.projectContext.requireProject(
      deliveryProjectId,
      userId,
    );
    const limit = this.clampLimit(options.limit);
    const rows = await this.projectRuns.listProjectRuns(deliveryProjectId, {
      limit: limit + 1,
      cursor: this.decodeCursor(options.cursor),
    });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const next = rows.length > limit && last ? this.encodeCursor(last) : null;
    if (page.length === 0) {
      return { runs: [], next: null };
    }

    const runIds = page.map((run) => run.id);
    const [itemsByRun, signoffsByRun] = await Promise.all([
      this.runs.listItemsByRunIds(runIds),
      this.runs.findActiveSignoffsByRunIds(runIds),
    ]);
    return {
      runs: page.map((run) =>
        this.toListItem(
          run,
          project.name,
          itemsByRun.get(run.id) ?? [],
          signoffsByRun.get(run.id) ?? null,
        ),
      ),
      next,
    };
  }

  /**
   * The run for the CURRENT set of heads, if one exists. When none does, the
   * heads are compared with the newest run's so the caller can say which
   * repository moved and offer a new run.
   */
  async current(
    deliveryProjectId: string,
    actor: QaRunActorContext,
  ): Promise<ProjectQaCurrentRun> {
    const project = await this.projectContext.requireProject(
      deliveryProjectId,
      actor.userId,
    );
    const role = await this.access.findAppRole(actor.userId);
    const readings = await this.heads.readHeads(project.repositories, actor);

    if (this.allReadable(readings)) {
      const run = await this.projectRuns.findRunByFingerprint(
        deliveryProjectId,
        this.fingerprintOf(readings),
      );
      if (run) {
        const assembled = await this.assembleStored(
          project,
          run,
          role,
          readings,
        );
        return { run: assembled, heads: assembled.repositories, stale: false };
      }
    }

    const latest = await this.projectRuns.findNewestProjectRun(
      deliveryProjectId,
      { openOnly: false },
    );
    const coverage = latest
      ? ((await this.projectRuns.listCoverageByRunIds([latest.id])).get(
          latest.id,
        ) ?? [])
      : null;
    const headStatuses = buildHeadStatuses(
      project.repositories,
      readings,
      coverage,
    );
    return {
      run: null,
      heads: headStatuses,
      stale: headStatuses.some((head) => head.moved),
    };
  }

  async getById(
    deliveryProjectId: string,
    actor: QaRunActorContext,
    runId: string,
  ): Promise<ProjectQaRun> {
    const project = await this.projectContext.requireProject(
      deliveryProjectId,
      actor.userId,
    );
    const run = await this.requireRun(deliveryProjectId, runId);
    const role = await this.access.findAppRole(actor.userId);
    return this.assembleStored(
      project,
      run,
      role,
      await this.heads.readHeads(project.repositories, actor, {
        maxAgeMs: DISPLAY_HEAD_MAX_AGE_MS,
      }),
    );
  }

  /**
   * qa-report/v2. A signed-off run is EXACTLY the report frozen into its
   * active sign-off; an open run is the live assembly, the same one GET
   * returns.
   */
  async buildReport(
    deliveryProjectId: string,
    actor: QaRunActorContext,
    runId: string,
  ): Promise<QaProjectReport> {
    const project = await this.projectContext.requireProject(
      deliveryProjectId,
      actor.userId,
    );
    const runRow = await this.requireRun(deliveryProjectId, runId);
    const activeSignoff =
      runRow.status === 'signed_off'
        ? await this.runs.findActiveSignoff(runRow.id)
        : null;
    const frozen = activeSignoff !== null;
    const run = frozen
      ? (activeSignoff.report_json as unknown as ProjectQaRun)
      : this.withAttachmentRefs(
          await this.getById(project.deliveryProjectId, actor, runId),
          await this.attachments.referencesForRun(runRow.id),
        );
    const history = await this.runs.listSupersededSignoffs(runRow.id);
    return buildQaProjectReport({
      generatedAt: new Date().toISOString(),
      frozen,
      run,
      signoffHistory: history.map(toSignoffHistoryEntry),
    });
  }

  /**
   * Project-wide My QA items. Every developer's items, not filtered by user:
   * the UI shows it to developers and QA. Run items come from the run for the
   * current heads, or the newest open Project run when the heads moved.
   */
  async myItems(
    deliveryProjectId: string,
    actor: QaRunActorContext,
  ): Promise<ProjectMyQaItems> {
    const project = await this.projectContext.requireProject(
      deliveryProjectId,
      actor.userId,
    );
    const role = await this.access.findAppRole(actor.userId);

    const [rows, readings] = await Promise.all([
      this.requirements.listActiveByDeliveryProject(deliveryProjectId),
      this.heads.readHeads(project.repositories, actor, {
        maxAgeMs: DISPLAY_HEAD_MAX_AGE_MS,
      }),
    ]);
    const itemsByRequirement = await this.checklists.listItemsByChecklistIds(
      rows.map((row) => row.id),
    );

    const run = await this.pickRunForFeed(deliveryProjectId, readings);
    const assembled = run
      ? await this.assembleStored(project, run, role, readings)
      : null;
    const runItemBySource = new Map<string, ProjectQaRunItem>();
    for (const item of assembled?.items ?? []) {
      if (item.sourceItemId) {
        runItemBySource.set(item.sourceItemId, item);
      }
    }

    const feed: ProjectMyQaItems = {
      returned: [],
      inProgress: [],
      todo: [],
      readyForQa: [],
    };
    for (const row of rows) {
      for (const item of itemsByRequirement.get(row.id) ?? []) {
        const runItem = runItemBySource.get(item.id) ?? null;
        const entry: QaMyItemsFeedItem = {
          requirement: { id: row.id, name: row.name, kind: row.kind },
          item: this.requirementsService.toItem(item, role, row),
          runId: runItem ? (run?.id ?? null) : null,
          runItem,
        };
        // Same rule the team overview counts `readyForQa` with.
        const bucket = bucketMyQaItem(item.progress, runItem?.status ?? null);
        if (bucket) {
          feed[bucket].push(entry);
        }
      }
    }
    return feed;
  }

  // ---------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------

  async create(
    deliveryProjectId: string,
    actor: QaRunActorContext,
  ): Promise<{ created: boolean; run: ProjectQaRun }> {
    const project = await this.projectContext.requireProject(
      deliveryProjectId,
      actor.userId,
    );
    const role = await this.access.findAppRole(actor.userId);
    if (!canCreateRun(role)) {
      throw new ForbiddenException(
        'Only QA, a lead, or an admin may start a verification run.',
      );
    }
    if (project.repositories.length === 0) {
      throw qaNoRepositories();
    }

    const requirementRows =
      await this.requirements.listActiveByDeliveryProject(deliveryProjectId);
    const itemsByRequirement = await this.checklists.listItemsByChecklistIds(
      requirementRows.map((row) => row.id),
    );
    const snapshot = this.snapshotItems(requirementRows, itemsByRequirement);
    if (snapshot.length === 0) {
      throw qaNoRequirements();
    }

    // Always read fresh: the run records exactly these heads.
    const readings = await this.heads.readHeads(project.repositories, actor);
    const unreadable = readings.filter(
      (reading) => reading.kind === 'unreadable',
    );
    if (unreadable.length > 0) {
      throw qaUatHeadUnreadable(
        unreadable.map((reading) => reading.repository.repoFullName),
      );
    }
    const missing = readings.filter(
      (reading) => reading.kind === 'branch_missing',
    );
    if (missing.length > 0) {
      throw qaUatBranchMissing(
        missing.map((reading) => reading.repository.repoFullName),
      );
    }
    const captured = readings.flatMap((reading) =>
      reading.kind === 'ok'
        ? [
            {
              projectId: reading.repository.projectId,
              repoFullName: reading.repository.repoFullName,
              headSha: reading.sha,
            },
          ]
        : [],
    );

    const result = await this.projectRuns.createRun({
      deliveryProjectId,
      projectName: project.name,
      headsFingerprint: fingerprintHeads(captured),
      repositories: captured,
      createdBy: actor.userId,
      createdByLogin: actor.userLogin,
      items: snapshot,
    });

    if (result.created) {
      await this.recordAudit(
        QA_RUN_EVENTS.created,
        project,
        actor.userId,
        result.run,
        {
          repositories: captured.map((head) => ({
            repoFullName: head.repoFullName,
            headSha: head.headSha,
          })),
        },
      );
    }

    const signoff = result.created
      ? null
      : await this.runs.findActiveSignoff(result.run.id);
    const run = await this.assembleRun({
      project,
      run: result.run,
      items: result.items,
      signoff,
      coverage: result.repositories,
      role,
      readings,
    });
    return { created: result.created, run };
  }

  async updateItem(
    deliveryProjectId: string,
    actor: QaRunActorContext,
    runId: string,
    itemId: string,
    dto: PatchQaRunItemDto,
  ): Promise<ProjectQaRun> {
    const project = await this.projectContext.requireProject(
      deliveryProjectId,
      actor.userId,
    );
    const run = await this.requireRun(deliveryProjectId, runId);
    const item = await this.requireItem(run.id, itemId);
    this.requireRunOpen(run);

    const role = await this.access.findAppRole(actor.userId);
    if (!canSetVerification(role)) {
      throw verificationForbidden();
    }
    if (dto.status === 'in_progress') {
      throw verificationStatusInvalid(dto.status);
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
      (dto.status === 'failed' || dto.status === 'returned_to_dev') &&
      !effectiveSeverity
    ) {
      throw new BadRequestException(
        'A defect severity is required to mark this item failed or returned to dev.',
      );
    }

    const runActor = { id: actor.userId, login: actor.userLogin };
    let updated: QaRunItemRow | null;
    try {
      updated = await this.runs.updateItem(
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
        { requireProgressDoneForPass: true, resetProgressOnReturn: true },
      );
    } catch (error) {
      if (error instanceof QaProgressNotDoneError) {
        throw qaProgressNotDone();
      }
      if (error instanceof QaRunNotOpenError) {
        throw new ConflictException(
          'This run is signed off. Reopen it to make changes.',
        );
      }
      throw error;
    }
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
      await this.notifyOnStatusChange(project, updated, actor.userId);
    }

    return this.reload(project, run, role, actor);
  }

  async signoff(
    deliveryProjectId: string,
    actor: QaRunActorContext,
    runId: string,
    dto: SignoffQaRunDto,
  ): Promise<ProjectQaRun> {
    const project = await this.projectContext.requireProject(
      deliveryProjectId,
      actor.userId,
    );
    const run = await this.requireRun(deliveryProjectId, runId);
    this.requireRunOpen(run);

    const role = await this.access.findAppRole(actor.userId);
    if (!canSignOff(role)) {
      throw new ForbiddenException(
        'Only QA, a lead, or an admin may sign off a run.',
      );
    }

    const items = await this.runs.listItemsByRunId(run.id);
    this.validateVerdict(dto, items);

    const now = new Date().toISOString();
    const signoffId = randomUUID();
    const summary = dto.summary ?? null;
    const conditions = dto.conditions ?? null;
    const coverage = await this.coverageOf(run.id);
    const readings = await this.heads.readHeads(project.repositories, actor);

    const attachmentRefs = await this.attachments.referencesForRun(run.id);
    const reportBase = await this.assembleRun({
      project,
      run: { ...run, status: 'signed_off', updated_at: now },
      items,
      signoff: null,
      coverage,
      role,
      readings,
    });
    const report: ProjectQaRun = {
      ...this.withAttachmentRefs(reportBase, attachmentRefs),
      signoff: {
        id: signoffId,
        verdict: dto.verdict,
        summary,
        conditions,
        signedBy: { id: actor.userId, login: actor.userLogin },
        signedAt: now,
      },
    };

    const result = await this.runs
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
        expectedAttachmentIds: [...attachmentRefs.values()].flatMap((refs) =>
          refs.map((ref) => ref.id),
        ),
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
      run,
      { verdict: dto.verdict },
    );
    await this.notifySignoff(project, run, result.signoff, actor.userId);

    return this.assembleRun({
      project,
      run: result.run as QaProjectRunRow,
      items,
      signoff: result.signoff,
      coverage,
      role,
      readings,
    });
  }

  async reopen(
    deliveryProjectId: string,
    actor: QaRunActorContext,
    runId: string,
  ): Promise<ProjectQaRun> {
    const project = await this.projectContext.requireProject(
      deliveryProjectId,
      actor.userId,
    );
    const run = await this.requireRun(deliveryProjectId, runId);

    const role = await this.access.findAppRole(actor.userId);
    if (!canReopenRun(role)) {
      throw new ForbiddenException(
        'Only a lead or admin may reopen a signed-off run.',
      );
    }
    if (run.status !== 'signed_off') {
      throw new ConflictException('This run is not signed off.');
    }

    const reopened = await this.runs.reopenRun(run.id, {
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
      run,
      {},
    );

    return this.reload(project, reopened as QaProjectRunRow, role, actor);
  }

  // ---------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------

  /** Requirements in order (functional first, then system), items by position, positions global. */
  private snapshotItems(
    requirementRows: QaChecklistRow[],
    itemsByRequirement: Map<string, QaChecklistItemRow[]>,
  ) {
    let position = 0;
    return requirementRows.flatMap((requirement) =>
      (itemsByRequirement.get(requirement.id) ?? []).map((item) => ({
        sourceItemId: item.id,
        requirementId: requirement.id,
        requirementName: requirement.name,
        requirementKind: requirement.kind,
        position: position++,
        title: item.title,
        description: item.description,
        verificationType: item.verification_type,
        testIdentifier: item.test_identifier,
        acceptanceCriteria: item.acceptance_criteria,
      })),
    );
  }

  private allReadable(
    readings: readonly QaUatHeadReading[],
  ): readings is Array<Extract<QaUatHeadReading, { kind: 'ok' }>> {
    return readings.length > 0 && readings.every((r) => r.kind === 'ok');
  }

  private fingerprintOf(readings: readonly QaUatHeadReading[]): string {
    return fingerprintHeads(
      readings.flatMap((reading) =>
        reading.kind === 'ok'
          ? [{ projectId: reading.repository.projectId, headSha: reading.sha }]
          : [],
      ),
    );
  }

  /** The run for the current heads, else the newest open Project run. */
  private async pickRunForFeed(
    deliveryProjectId: string,
    readings: readonly QaUatHeadReading[],
  ): Promise<QaProjectRunRow | null> {
    if (this.allReadable(readings)) {
      const run = await this.projectRuns.findRunByFingerprint(
        deliveryProjectId,
        this.fingerprintOf(readings),
      );
      if (run) {
        return run;
      }
    }
    return this.projectRuns.findNewestProjectRun(deliveryProjectId, {
      openOnly: true,
    });
  }

  private async coverageOf(runId: string): Promise<QaRunRepositoryRow[]> {
    return (
      (await this.projectRuns.listCoverageByRunIds([runId])).get(runId) ?? []
    );
  }

  private async assembleStored(
    project: QaProjectContext,
    run: QaProjectRunRow,
    role: PlatformAppRole,
    readings: QaUatHeadReading[] | null,
  ): Promise<ProjectQaRun> {
    const [items, signoff, coverage] = await Promise.all([
      this.runs.listItemsByRunId(run.id),
      this.runs.findActiveSignoff(run.id),
      this.coverageOf(run.id),
    ]);
    return this.assembleRun({
      project,
      run,
      items,
      signoff,
      coverage,
      role,
      readings,
    });
  }

  /** Re-reads the run's items after a write and renders it with a (briefly cached) head reading. */
  private async reload(
    project: QaProjectContext,
    run: QaProjectRunRow,
    role: PlatformAppRole,
    actor: QaRunActorContext,
  ): Promise<ProjectQaRun> {
    const readings = await this.heads.readHeads(project.repositories, actor, {
      maxAgeMs: DISPLAY_HEAD_MAX_AGE_MS,
    });
    return this.assembleStored(project, run, role, readings);
  }

  private async requireRun(
    deliveryProjectId: string,
    runId: string,
  ): Promise<QaProjectRunRow> {
    const run = await this.projectRuns.findProjectRun(deliveryProjectId, runId);
    if (!run) {
      throw new NotFoundException('QA run not found');
    }
    return run;
  }

  private async requireItem(
    runId: string,
    itemId: string,
  ): Promise<QaRunItemRow> {
    const item = await this.runs.findItemForRun(runId, itemId);
    if (!item) {
      throw new NotFoundException('QA run item not found');
    }
    return item;
  }

  private requireRunOpen(run: QaProjectRunRow): void {
    if (run.status === 'signed_off') {
      throw new ConflictException(
        'This run is signed off. Reopen it to make changes.',
      );
    }
  }

  private clampLimit(raw: number | undefined): number {
    if (raw === undefined || !Number.isFinite(raw)) {
      return QA_RUNS_LIST_DEFAULT_LIMIT;
    }
    return Math.max(1, Math.min(QA_RUNS_LIST_MAX_LIMIT, Math.trunc(raw)));
  }

  private encodeCursor(run: QaProjectRunRow): string {
    return Buffer.from(`${run.created_at}|${run.id}`, 'utf8').toString(
      'base64url',
    );
  }

  private decodeCursor(
    cursor: string | undefined,
  ): { createdAt: string; id: string } | null {
    if (!cursor) {
      return null;
    }
    const [createdAt, id] = Buffer.from(cursor, 'base64url')
      .toString('utf8')
      .split('|');
    if (
      !createdAt ||
      !id ||
      Number.isNaN(Date.parse(createdAt)) ||
      !/^[0-9a-f-]{36}$/i.test(id)
    ) {
      throw new BadRequestException('cursor is not valid');
    }
    return { createdAt, id };
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

  private async assembleRun(view: RunView): Promise<ProjectQaRun> {
    const { project, run, items, signoff, coverage, role, readings } = view;

    const sourceIds = items
      .map((item) => item.source_item_id)
      .filter((id): id is string => id !== null);
    const [
      priorSummaries,
      progressBySource,
      automationByRepository,
      changed,
      attachmentCounts,
      fixProofCounts,
    ] = await Promise.all([
      this.runs.findPriorItemSummaries(
        items
          .map((item) => item.prior_run_item_id)
          .filter((id): id is string => id !== null),
      ),
      this.requirements.listItemsByIds(sourceIds),
      this.automationFor(coverage),
      this.requirements.requirementsChangedSince(
        project.deliveryProjectId,
        signoff?.signed_at ?? run.created_at,
      ),
      this.attachments.countsByItem(run.id),
      this.attachments.fixProofCountsByItem(run.id),
    ]);

    const repositories = buildHeadStatuses(
      project.repositories,
      readings,
      coverage,
    );
    const open = run.status === 'open';
    const mayVerify = open && canSetVerification(role);
    const merged = this.mergeAutomation(automationByRepository);
    const attachmentsEnabled = this.attachments.isEnabled();
    const mayAttachFixProof =
      attachmentsEnabled && open && canAddFixProof(role);

    const runItems: ProjectQaRunItem[] = items.map((row) => {
      const previous: QaRunItemPrevious | null = row.prior_run_item_id
        ? (priorSummaries.get(row.prior_run_item_id) ?? null)
        : null;
      const progress: QaProgress | null = row.source_item_id
        ? (progressBySource.get(row.source_item_id)?.progress ?? null)
        : null;
      return {
        ...toRunItem(
          row,
          previous,
          mayVerify,
          this.automatedFor(row, automationByRepository),
        ),
        sourceItemId: row.source_item_id,
        requirementId: row.requirement_id,
        requirementName: row.requirement_name,
        requirementKind: row.requirement_kind,
        acceptanceCriteria: row.acceptance_criteria,
        progress,
        attachmentCount: attachmentCounts.get(row.id) ?? 0,
        fixProofCount: fixProofCounts.get(row.id) ?? 0,
        canAttachFixProof:
          mayAttachFixProof &&
          acceptsFixProof(row) &&
          (fixProofCounts.get(row.id) ?? 0) < QA_ATTACHMENT_MAX_PER_ITEM,
      };
    });

    return {
      ...this.toListItem(run, project.name, items, signoff),
      repositories,
      stale: repositories.some((repository) => repository.moved),
      requirementsChanged: changed,
      items: runItems,
      permissions: {
        canSetVerification: mayVerify,
        canSignOff: open && canSignOff(role),
        canReopen: !open && canReopenRun(role),
        canDispatch: open && canDispatchAutomation(role),
      },
      attachments: {
        enabled: attachmentsEnabled,
        canAdd: open && canAddEvidence(role),
        canAddFixProof: mayAttachFixProof,
      },
      automation: merged,
      automationByRepository,
    };
  }

  /** The report carries each item's attachment ids and captions (no URLs: signed URLs expire). */
  private withAttachmentRefs(
    run: ProjectQaRun,
    refs: ReadonlyMap<string, QaRunItemAttachmentRef[]>,
  ): ProjectQaRun {
    return {
      ...run,
      items: run.items.map((item) => ({
        ...item,
        attachments: refs.get(item.id) ?? [],
      })),
    };
  }

  private async automationFor(
    coverage: QaRunRepositoryRow[],
  ): Promise<ProjectQaRun['automationByRepository']> {
    return Promise.all(
      coverage.map(async (row) => ({
        projectId: row.project_id,
        repoFullName: row.repo_full_name,
        automation: await this.automation.forRun(
          row.repo_full_name,
          QA_PROJECT_RUN_BRANCH,
          row.head_sha,
        ),
      })),
    );
  }

  /** First report per stage across the covered repositories. */
  private mergeAutomation(
    byRepository: ProjectQaRun['automationByRepository'],
  ): QaRunAutomation {
    return {
      verify:
        byRepository.find((entry) => entry.automation.verify)?.automation
          .verify ?? null,
      quality:
        byRepository.find((entry) => entry.automation.quality)?.automation
          .quality ?? null,
    };
  }

  /**
   * An automated item is matched against each covered repository; the first
   * repository that actually ran something wins, else the first result.
   */
  private automatedFor(
    row: QaRunItemRow,
    byRepository: ProjectQaRun['automationByRepository'],
  ): QaAutomatedResult | null {
    const results = byRepository
      .map((entry) =>
        matchAutomatedResult(
          {
            verificationType: row.verification_type,
            testIdentifier: row.test_identifier,
          },
          entry.automation,
        ),
      )
      .filter((result): result is QaAutomatedResult => result !== null);
    return (
      results.find((result) => result.status !== 'not_run') ??
      results[0] ??
      null
    );
  }

  private toListItem(
    run: QaProjectRunRow,
    projectName: string,
    items: QaRunItemRow[],
    signoff: QaRunSignoffRow | null,
  ): ProjectQaRunListItem {
    return {
      id: run.id,
      scope: 'project',
      deliveryProjectId: run.delivery_project_id,
      // The Project's CURRENT name; the stored label is only the name at run start.
      deliveryProjectName: projectName || run.checklist_name,
      branch: run.branch,
      status: run.status,
      createdBy: { id: run.created_by, login: run.created_by_login },
      createdAt: run.created_at,
      updatedAt: run.updated_at,
      summary: computeSummary(items),
      signoff: signoff ? toSignoff(signoff) : null,
    };
  }

  // ---------------------------------------------------------------------
  // Audit + notifications
  // ---------------------------------------------------------------------

  private async recordAudit(
    eventCode: string,
    project: QaProjectContext,
    actorUserId: string,
    run: QaProjectRunRow,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.auditEventsService?.recordProjectEvent({
      workspaceId: project.groupId,
      projectId: await this.projectContext.anchorProjectId(project),
      actorUserId,
      eventCode,
      message: `QA run for Project "${project.name}": ${eventCode.split('.').pop()}`,
      metadata: {
        runId: run.id,
        deliveryProjectId: project.deliveryProjectId,
        branch: QA_BRANCH,
        ...metadata,
      },
    });
  }

  private async notifyOnStatusChange(
    project: QaProjectContext,
    updated: QaRunItemRow,
    actorId: string,
  ): Promise<void> {
    if (updated.status === 'returned_to_dev') {
      const [anchor, teamIds] = await Promise.all([
        this.projectContext.anchorProjectId(project),
        this.access.listWorkspaceLeadAndDeveloperIds(project.groupId),
      ]);
      const ownerId = anchor
        ? await this.access.findProjectOwnerId(anchor)
        : null;
      const parts = [
        updated.defect_severity
          ? `Severity: ${updated.defect_severity}.`
          : null,
        updated.notes
          ? this.truncate(updated.notes, NOTIFICATION_BODY_TRUNCATE_LENGTH)
          : null,
      ].filter((part): part is string => Boolean(part));
      await this.notifyMany(
        this.dedupeExcludingActor([ownerId, ...teamIds], actorId),
        anchor,
        'qa.item.returned_to_dev',
        `QA returned "${updated.title}" in ${project.name}`,
        parts.length > 0 ? parts.join(' ') : 'No additional notes.',
      );
    }

    if (updated.status === 'blocked' && updated.defect_severity === 'blocker') {
      const [anchor, leadIds] = await Promise.all([
        this.projectContext.anchorProjectId(project),
        this.access.listWorkspaceLeadIds(project.groupId),
      ]);
      await this.notifyMany(
        this.dedupeExcludingActor(leadIds, actorId),
        anchor,
        'qa.item.blocked',
        `QA marked "${updated.title}" a blocker in ${project.name}`,
        updated.notes
          ? this.truncate(updated.notes, NOTIFICATION_BODY_TRUNCATE_LENGTH)
          : 'No additional notes.',
      );
    }
  }

  private async notifySignoff(
    project: QaProjectContext,
    run: QaProjectRunRow,
    signoff: QaRunSignoffRow,
    actorId: string,
  ): Promise<void> {
    const [anchor, leadIds] = await Promise.all([
      this.projectContext.anchorProjectId(project),
      this.access.listWorkspaceLeadIds(project.groupId),
    ]);
    const ownerId = anchor
      ? await this.access.findProjectOwnerId(anchor)
      : null;
    await this.notifyMany(
      this.dedupeExcludingActor([run.created_by, ownerId, ...leadIds], actorId),
      anchor,
      'qa.run.signed_off',
      `QA run signed off (${signoff.verdict}) for ${project.name}`,
      signoff.summary
        ? this.truncate(signoff.summary, SIGNOFF_SUMMARY_TRUNCATE_LENGTH)
        : `Verdict: ${signoff.verdict}.`,
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
    projectId: string | null,
    eventCode: string,
    title: string,
    body: string,
  ): Promise<void> {
    const notifications = this.notificationEventsService;
    if (!notifications || !projectId || userIds.length === 0) {
      return;
    }
    await Promise.all(
      userIds.map((userId) =>
        notifications.record({ userId, projectId, eventCode, title, body }),
      ),
    );
  }
}
