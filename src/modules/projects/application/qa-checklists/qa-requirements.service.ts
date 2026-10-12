import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';

import {
  AuditEventPublisher,
  NotificationEventPublisher,
} from '#kernel/events/platform-event-publisher.js';
import {
  AUDIT_LATEST_EVENT_QUERY_PORT,
  type AuditLatestEventQueryPort,
  type ProjectEventSince,
} from '#kernel/ports/audit.port';
import type { DeliveryProjectDataCleanupPort } from '#kernel/ports/delivery-project-data-cleanup.port';
import type { DeliveryProjectOverviewFacts } from '#kernel/ports/delivery-project-overview.port';
import type { PlatformAppRole } from '#kernel/ports/platform-admin.port';
import { canSetProgress } from '../../domain/qa-run-access.rules';
import {
  QA_UNIQUE_VIOLATION,
  QaChecklistBatchInsertError,
  QaChecklistsRepository,
  type QaChecklistItemRow,
  type QaChecklistRow,
} from '../../infrastructure/qa-checklists.repository';
import {
  QaProjectRunsRepository,
  tallyVerificationByRequirement,
  type QaProjectRunHeadline,
} from '../../infrastructure/qa-project-runs.repository';
import { QaRequirementsRepository } from '../../infrastructure/qa-requirements.repository';
import { QaRunsRepository } from '../../infrastructure/qa-runs.repository';
import { QA_PROMOTION_MERGED_EVENT } from '../qa-runs/qa-promotion.contracts';
import type { QaVerificationStatusCounts } from '../qa-runs/qa-runs.contracts';
import { QaAccessService } from './qa-access.service';
import { QaProjectContextService } from './qa-project-context.service';
import { buildProjectOverview, promotionSince } from './qa-overview.assembly';
import type { CreateRequirementDto } from './dto/create-requirement.dto';
import type { CreateRequirementsBatchDto } from './dto/create-requirements-batch.dto';
import type { ReorderRequirementItemsDto } from './dto/reorder-requirement-items.dto';
import type { RequirementItemDto } from './dto/requirement-item.dto';
import type { SetProgressDto } from './dto/set-progress.dto';
import type { UpdateRequirementDto } from './dto/update-requirement.dto';
import type { UpdateRequirementItemDto } from './dto/update-requirement-item.dto';
import {
  progressForbidden,
  requirementBatchDuplicateName,
  requirementBatchInvalid,
  requirementArchived,
  requirementItemStale,
  requirementKindInvalid,
  requirementManageForbidden,
  requirementNameTaken,
  requirementOrderMismatch,
  requirementStale,
} from './qa-errors';
import {
  QA_REQUIREMENT_BATCH_MAX,
  QA_REQUIREMENT_KINDS,
  QA_REQUIREMENT_MAX_ITEMS,
  type QaProgress,
  type QaProgressCounts,
  type QaRequirementKind,
  type Requirement,
  type RequirementItem,
  type RequirementListResult,
  type RequirementProgressResult,
  type RequirementSummary,
  type RequirementsOverview,
} from './qa-requirements.contracts';

type AuditEventSink = Pick<AuditEventPublisher, 'recordProjectEvent'>;
type NotificationEventSink = Pick<NotificationEventPublisher, 'record'>;

const REQUIREMENT_EVENTS = {
  created: 'qa.requirement.created',
  updated: 'qa.requirement.updated',
  archived: 'qa.requirement.archived',
  progressChanged: 'qa.requirement.progress_changed',
} as const;

const READY_FOR_QA_EVENT = 'qa.item.retest_requested';
const NOTE_TRUNCATE_LENGTH = 300;

export interface RequirementActorContext {
  userId: string;
  userLogin: string;
}

/**
 * Project requirements: what a Product owner defines and a Developer reports
 * Progress against (docs/design/project-requirements.md, sections 2.2, 2.3,
 * 2.6). A requirement is a `projects.qa_checklists` row owned by a Project;
 * its items are edited by id and never deleted-and-reinserted, so Progress
 * survives every edit.
 *
 * Authorization is the same two layers as the legacy checklists: visibility is
 * "active member of the Project's group" (a non-member gets 404, never a 403
 * that confirms the Project exists), then the allow-list rules in
 * qa-run-access.rules.ts.
 */
@Injectable()
export class QaRequirementsService implements DeliveryProjectDataCleanupPort {
  private readonly logger = new Logger(QaRequirementsService.name);

  constructor(
    private readonly checklists: QaChecklistsRepository,
    private readonly requirements: QaRequirementsRepository,
    private readonly projectRuns: QaProjectRunsRepository,
    private readonly runs: QaRunsRepository,
    private readonly access: QaAccessService,
    private readonly projectContext: QaProjectContextService,
    // Required, not @Optional(): the overview reads promotion merges through
    // it, and a silently-undefined collaborator would only fail on that call.
    @Inject(AUDIT_LATEST_EVENT_QUERY_PORT)
    private readonly auditQuery: AuditLatestEventQueryPort,
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

  /**
   * DeliveryProjectDataCleanupPort: called by the Project delete flow after
   * its repositories are gone. No authorization here: the caller has already
   * authorized the delete. Unassigned legacy checklists are never touched.
   */
  async purgeDeliveryProject(
    deliveryProjectId: string,
  ): Promise<{ removed: number }> {
    return {
      removed: await this.checklists.deleteByDeliveryProject(deliveryProjectId),
    };
  }

  // ---------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------

  async listForProject(
    deliveryProjectId: string,
    userId: string,
    options: { kind: string | undefined; includeArchived: boolean },
  ): Promise<RequirementListResult> {
    const project = await this.projectContext.requireProject(
      deliveryProjectId,
      userId,
    );
    const kind =
      options.kind === undefined || options.kind === ''
        ? undefined
        : this.parseKind(options.kind);

    const [role, rows] = await Promise.all([
      this.access.findAppRole(userId),
      this.checklists.listByDeliveryProject(deliveryProjectId, {
        ...(kind ? { kind } : {}),
        includeArchived: options.includeArchived,
      }),
    ]);
    const requirements = await this.assembleMany(rows, role);
    return {
      deliveryProject: {
        id: project.deliveryProjectId,
        name: project.name,
        groupId: project.groupId,
      },
      requirements,
      permissions: {
        canManage: await this.access.canManage(userId),
        canSetProgress: canSetProgress(role),
      },
    };
  }

  async getById(id: string, userId: string): Promise<Requirement> {
    const row = await this.requireRequirement(id, userId);
    const role = await this.access.findAppRole(userId);
    return this.assembleOne(row, role);
  }

  /**
   * Team-level, read-only: every Project of the team with its requirements'
   * progress and verification, plus what the Home dashboard summarizes per
   * Project (newest run, counts, promotion, the caller's membership).
   *
   * The number of database round trips does not depend on how many Projects
   * the team has: every per-Project read is one batched query over all the
   * team's Project ids. Three sequential stages, each a parallel batch:
   *   1. Projects, requirements, the caller's manage right;
   *   2. requirement items, newest runs + sign-offs, members + repositories;
   *   3. run items of those runs, promotion merges (audit).
   *
   * `counts.readyForQa` applies the My QA items rule (bucketMyQaItem) to the
   * Project's NEWEST run. GET .../qa/my-items instead picks its run from the
   * live uat heads (the run for the current heads, else the newest OPEN run),
   * which would cost a GitHub read per repository per Project here. The two
   * agree when there is no run, when the newest run is open, and when the
   * heads have not moved since the newest signed-off run. They differ only
   * when the newest run is signed off AND a uat head has moved since: my-items
   * then has no run and lists every done item as ready, while this counts only
   * the done items the signed-off run has not already decided.
   */
  async overview(
    workspaceId: string,
    userId: string,
    includeArchived: boolean,
  ): Promise<RequirementsOverview> {
    if (!(await this.access.canAccessWorkspace(userId, workspaceId))) {
      throw new NotFoundException('Workspace not found');
    }
    const [projects, rows, canManage] = await Promise.all([
      this.projectContext.listGroupProjects(workspaceId),
      this.requirements.listByWorkspace(workspaceId, includeArchived),
      this.access.canManage(userId),
    ]);
    const projectIds = projects.map((project) => project.id);

    const [itemsByRequirement, latestRuns, facts] = await Promise.all([
      this.checklists.listItemsByChecklistIds(rows.map((row) => row.id)),
      this.projectRuns.findLatestRunHeadlines(projectIds),
      this.projectContext.listOverviewFacts(projectIds, userId),
    ]);
    const [itemFactsByRun, mergedAtByRepository] = await Promise.all([
      this.projectRuns.listItemFactsByRunIds(
        [...latestRuns.values()].map((run) => run.runId),
      ),
      this.findPromotionMerges(latestRuns, facts),
    ]);

    const summarize = (
      row: QaChecklistRow,
      verification: QaVerificationStatusCounts | null,
      latestRunStatus: 'open' | 'signed_off' | null,
    ): RequirementSummary => {
      const items = itemsByRequirement.get(row.id) ?? [];
      return {
        id: row.id,
        kind: row.kind,
        name: row.name,
        itemCount: items.length,
        progressCounts: this.countProgress(items),
        verification,
        latestRunStatus,
        archivedAt: row.archived_at,
      };
    };

    const groups = projects.map((project) => {
      const run = latestRuns.get(project.id);
      const runItems = run ? (itemFactsByRun.get(run.runId) ?? []) : [];
      const verification = run
        ? tallyVerificationByRequirement(runItems)
        : null;
      const projectRows = rows.filter(
        (row) => row.delivery_project_id === project.id,
      );
      return {
        deliveryProject: { id: project.id, name: project.name },
        requirements: projectRows.map((row) =>
          summarize(
            row,
            run ? (verification?.get(row.id) ?? zeroCounts()) : null,
            run ? run.status : null,
          ),
        ),
        ...buildProjectOverview({
          run,
          runItems,
          // The My QA items feed lists active requirements only, even when
          // the overview was asked to include archived ones.
          items: projectRows
            .filter((row) => row.archived_at === null)
            .flatMap((row) => itemsByRequirement.get(row.id) ?? []),
          facts: facts.get(project.id),
          mergedAtByRepository,
        }),
      };
    });

    return {
      groups,
      unassigned: rows
        .filter((row) => row.delivery_project_id === null)
        .map((row) => summarize(row, null, null)),
      permissions: { canManage },
    };
  }

  /**
   * Newest `qa.promotion.merged` time per repository project id, for the
   * repositories of every Project whose newest run is signed off (one audit
   * query for all of them). Null when the merges cannot be known - audit
   * recording is off, or the read failed - so the overview says nothing about
   * promotion instead of a misleading "0 merged".
   */
  private async findPromotionMerges(
    latestRuns: ReadonlyMap<string, QaProjectRunHeadline>,
    facts: ReadonlyMap<string, DeliveryProjectOverviewFacts>,
  ): Promise<Map<string, string> | null> {
    const lookups: ProjectEventSince[] = [];
    for (const [projectId, run] of latestRuns) {
      if (run.status !== 'signed_off') {
        continue;
      }
      const since = promotionSince(run);
      for (const repository of facts.get(projectId)?.repositories ?? []) {
        lookups.push({ projectId: repository.projectId, since });
      }
    }
    if (lookups.length === 0) {
      return new Map();
    }
    try {
      return await this.auditQuery.findLatestProjectEventTimes(
        QA_PROMOTION_MERGED_EVENT,
        lookups,
      );
    } catch (error) {
      this.logger.warn(
        `Could not read promotion merges for the overview: ${String(error)}`,
      );
      return null;
    }
  }

  // ---------------------------------------------------------------------
  // Requirement writes (lead | admin)
  // ---------------------------------------------------------------------

  async create(
    deliveryProjectId: string,
    userId: string,
    dto: CreateRequirementDto,
  ): Promise<Requirement> {
    const project = await this.projectContext.requireProject(
      deliveryProjectId,
      userId,
    );
    await this.assertManage(userId);

    const kind = this.parseKind(dto.kind);
    const name = this.requireNonBlank(dto.name, 'name');
    const items = dto.items ?? [];
    this.assertItemCount(items.length);

    const scope = { deliveryProjectId, kind };
    if (
      await this.checklists.hasActiveNameConflict(
        project.groupId,
        name,
        undefined,
        scope,
      )
    ) {
      throw requirementNameTaken(name);
    }

    try {
      const { checklist, items: itemRows } =
        await this.checklists.createWithItems({
          workspaceId: project.groupId,
          name,
          description: dto.description ?? null,
          createdBy: userId,
          kind,
          deliveryProjectId,
          items: items.map((item) => ({
            title: this.requireNonBlank(item.title, 'title'),
            acceptanceCriteria: item.acceptanceCriteria ?? null,
            targetPersona: 'all' as const,
            verificationType: item.verificationType ?? 'manual',
            testIdentifier: item.testIdentifier ?? null,
          })),
        });
      await this.recordEvent(REQUIREMENT_EVENTS.created, checklist, userId, {
        name,
        kind,
        itemCount: itemRows.length,
      });
      const role = await this.access.findAppRole(userId);
      return this.toRequirement(checklist, itemRows, role);
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        throw requirementNameTaken(name);
      }
      throw error;
    }
  }

  /**
   * Creates 1..QA_REQUIREMENT_BATCH_MAX requirements of one kind, all or
   * nothing in one transaction. Same permission, visibility and per-field
   * rules as `create`; every failure names the offending entry by its 0-based
   * `index` where one applies. Audit once per created requirement.
   */
  async createBatch(
    deliveryProjectId: string,
    userId: string,
    dto: CreateRequirementsBatchDto,
  ): Promise<{ requirements: Requirement[] }> {
    const project = await this.projectContext.requireProject(
      deliveryProjectId,
      userId,
    );
    await this.assertManage(userId);

    const kind = this.parseKind(dto.kind);
    const drafts = dto.requirements;
    if (drafts.length < 1 || drafts.length > QA_REQUIREMENT_BATCH_MAX) {
      throw requirementBatchInvalid(QA_REQUIREMENT_BATCH_MAX);
    }

    const prepared = drafts.map((draft) => {
      const items = draft.items ?? [];
      this.assertItemCount(items.length);
      return {
        name: this.requireNonBlank(draft.name, 'name'),
        description: draft.description ?? null,
        items: items.map((item) => ({
          title: this.requireNonBlank(item.title, 'title'),
          acceptanceCriteria: item.acceptanceCriteria ?? null,
          targetPersona: 'all' as const,
          verificationType: item.verificationType ?? 'manual',
          testIdentifier: item.testIdentifier ?? null,
        })),
      };
    });

    // The partial unique index is case-insensitive over active names, so the
    // in-batch check is too. Reports the SECOND occurrence.
    const seen = new Set<string>();
    for (const [index, entry] of prepared.entries()) {
      const key = entry.name.toLowerCase();
      if (seen.has(key)) {
        throw requirementBatchDuplicateName(entry.name, index);
      }
      seen.add(key);
    }

    // Up-front check against existing active requirements, so the common
    // collision answers without opening the write transaction.
    const scope = { deliveryProjectId, kind };
    for (const [index, entry] of prepared.entries()) {
      if (
        await this.checklists.hasActiveNameConflict(
          project.groupId,
          entry.name,
          undefined,
          scope,
        )
      ) {
        throw requirementNameTaken(entry.name, index);
      }
    }

    let created: Awaited<
      ReturnType<QaChecklistsRepository['createManyWithItems']>
    >;
    try {
      created = await this.checklists.createManyWithItems(
        prepared.map((entry) => ({
          workspaceId: project.groupId,
          name: entry.name,
          description: entry.description,
          createdBy: userId,
          kind,
          deliveryProjectId,
          items: entry.items,
        })),
      );
    } catch (error) {
      // A concurrent create won the name between the check and the insert.
      if (error instanceof QaChecklistBatchInsertError) {
        throw requirementNameTaken(
          prepared[error.index]?.name ?? '',
          error.index,
        );
      }
      throw error;
    }

    for (const { checklist, items } of created) {
      await this.recordEvent(REQUIREMENT_EVENTS.created, checklist, userId, {
        name: checklist.name,
        kind,
        itemCount: items.length,
        batch: true,
      });
    }
    const role = await this.access.findAppRole(userId);
    return {
      requirements: created.map(({ checklist, items }) =>
        this.toRequirement(checklist, items, role),
      ),
    };
  }

  async update(
    id: string,
    userId: string,
    dto: UpdateRequirementDto,
  ): Promise<Requirement> {
    const row = await this.requireRequirement(id, userId);
    await this.assertManage(userId);
    this.assertNotArchived(row);
    if (row.version !== dto.expectedVersion) {
      throw requirementStale(dto.expectedVersion, row.version);
    }

    const name =
      dto.name === undefined
        ? undefined
        : this.requireNonBlank(dto.name, 'name');
    if (
      name !== undefined &&
      (await this.checklists.hasActiveNameConflict(
        row.workspace_id,
        name,
        row.id,
        { deliveryProjectId: row.delivery_project_id, kind: row.kind },
      ))
    ) {
      throw requirementNameTaken(name);
    }

    let updated: QaChecklistRow | null;
    try {
      updated = await this.checklists.updateMeta(
        id,
        dto.expectedVersion,
        {
          // exactOptionalPropertyTypes: omit the key rather than set undefined.
          ...(name !== undefined ? { name } : {}),
          ...(dto.description !== undefined
            ? { description: dto.description }
            : {}),
        },
        userId,
      );
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        throw requirementNameTaken(name ?? row.name);
      }
      throw error;
    }
    if (!updated) {
      const current = await this.checklists.findById(id);
      if (current?.archived_at) {
        throw requirementArchived();
      }
      throw requirementStale(dto.expectedVersion, current?.version ?? 0);
    }

    await this.recordEvent(REQUIREMENT_EVENTS.updated, updated, userId, {
      fields: [
        ...(name !== undefined ? ['name'] : []),
        ...(dto.description !== undefined ? ['description'] : []),
      ],
    });
    return this.assembleOne(updated, await this.access.findAppRole(userId));
  }

  async archive(id: string, userId: string): Promise<Requirement> {
    const row = await this.requireRequirement(id, userId);
    await this.assertManage(userId);

    const wasArchived = row.archived_at !== null;
    const archived = await this.checklists.archive(id, userId);
    if (!archived) {
      throw new NotFoundException('Requirement not found');
    }
    if (!wasArchived) {
      await this.recordEvent(REQUIREMENT_EVENTS.archived, archived, userId, {});
    }
    return this.assembleOne(archived, await this.access.findAppRole(userId));
  }

  // ---------------------------------------------------------------------
  // Item writes (lead | admin). Edits are by item id; Progress survives.
  // ---------------------------------------------------------------------

  async addItem(
    id: string,
    userId: string,
    dto: RequirementItemDto,
  ): Promise<RequirementItem> {
    const row = await this.requireRequirement(id, userId);
    await this.assertManage(userId);
    this.assertNotArchived(row);

    const existing = await this.checklists.listItemsByChecklistIds([id]);
    this.assertItemCount((existing.get(id)?.length ?? 0) + 1);

    const item = await this.requirements.appendItem(id, {
      title: this.requireNonBlank(dto.title, 'title'),
      acceptanceCriteria: dto.acceptanceCriteria ?? null,
      verificationType: dto.verificationType ?? 'manual',
      testIdentifier: dto.testIdentifier ?? null,
    });
    await this.recordEvent(REQUIREMENT_EVENTS.updated, row, userId, {
      fields: ['items'],
      itemId: item.id,
      change: 'added',
    });
    return this.toItem(item, await this.access.findAppRole(userId), row);
  }

  async updateItem(
    id: string,
    itemId: string,
    userId: string,
    dto: UpdateRequirementItemDto,
  ): Promise<RequirementItem> {
    const row = await this.requireRequirement(id, userId);
    await this.assertManage(userId);
    this.assertNotArchived(row);
    await this.requireItem(id, itemId);

    const updated = await this.requirements.updateItemDefinition(
      id,
      itemId,
      dto.expectedRowVersion,
      {
        // exactOptionalPropertyTypes: omit absent keys.
        ...(dto.title !== undefined
          ? { title: this.requireNonBlank(dto.title, 'title') }
          : {}),
        ...(dto.acceptanceCriteria !== undefined
          ? { acceptanceCriteria: dto.acceptanceCriteria }
          : {}),
        ...(dto.verificationType !== undefined
          ? { verificationType: dto.verificationType }
          : {}),
        ...(dto.testIdentifier !== undefined
          ? { testIdentifier: dto.testIdentifier }
          : {}),
      },
    );
    if (!updated) {
      throw requirementItemStale(dto.expectedRowVersion);
    }
    await this.recordEvent(REQUIREMENT_EVENTS.updated, row, userId, {
      fields: ['items'],
      itemId,
      change: 'edited',
    });
    return this.toItem(updated, await this.access.findAppRole(userId), row);
  }

  async deleteItem(id: string, itemId: string, userId: string): Promise<void> {
    const row = await this.requireRequirement(id, userId);
    await this.assertManage(userId);
    this.assertNotArchived(row);

    if (!(await this.requirements.deleteItem(id, itemId))) {
      throw new NotFoundException('Requirement item not found');
    }
    await this.recordEvent(REQUIREMENT_EVENTS.updated, row, userId, {
      fields: ['items'],
      itemId,
      change: 'deleted',
    });
  }

  async reorderItems(
    id: string,
    userId: string,
    dto: ReorderRequirementItemsDto,
  ): Promise<Requirement> {
    const row = await this.requireRequirement(id, userId);
    await this.assertManage(userId);
    this.assertNotArchived(row);

    if (!(await this.requirements.reorderItems(id, dto.itemIds))) {
      throw requirementOrderMismatch();
    }
    await this.recordEvent(REQUIREMENT_EVENTS.updated, row, userId, {
      fields: ['order'],
    });
    const refreshed = (await this.checklists.findById(id)) ?? row;
    return this.assembleOne(refreshed, await this.access.findAppRole(userId));
  }

  // ---------------------------------------------------------------------
  // Progress (member | lead | admin)
  // ---------------------------------------------------------------------

  /**
   * Sets one item's Progress. Any transition among todo / in_progress / done
   * is allowed (a developer can reopen their own mistake). Moving to `done`:
   *   - flips the item's run item back to `pending` in every OPEN Project run
   *     where QA had returned it (the old request-retest, now implicit); and
   *   - tells QA it is ready, even when no run item was returned.
   */
  async setProgress(
    id: string,
    itemId: string,
    actor: RequirementActorContext,
    dto: SetProgressDto,
  ): Promise<RequirementProgressResult> {
    const row = await this.requireRequirement(id, actor.userId);
    const role = await this.access.findAppRole(actor.userId);
    if (!canSetProgress(role)) {
      throw progressForbidden();
    }
    this.assertNotArchived(row);
    const before = await this.requireItem(id, itemId);

    const updated = await this.requirements.setProgress(
      id,
      itemId,
      dto.expectedRowVersion,
      dto.progress,
      { id: actor.userId, login: actor.userLogin },
    );
    if (!updated) {
      throw requirementItemStale(dto.expectedRowVersion);
    }

    let readyForQaNotified = false;
    if (before.progress !== updated.progress) {
      await this.recordEvent(
        REQUIREMENT_EVENTS.progressChanged,
        row,
        actor.userId,
        { itemId, from: before.progress, to: updated.progress },
      );
    }
    if (dto.progress === 'done') {
      readyForQaNotified = await this.onMarkedDone(row, updated, actor, dto);
    }

    return { item: this.toItem(updated, role, row), readyForQaNotified };
  }

  /** The done path: reset returned run items, then notify QA. Returns whether anyone was notified. */
  private async onMarkedDone(
    row: QaChecklistRow,
    item: QaChecklistItemRow,
    actor: RequirementActorContext,
    dto: SetProgressDto,
  ): Promise<boolean> {
    if (!row.delivery_project_id) {
      return false;
    }
    const note = dto.note ?? null;
    const returned = await this.projectRuns.findReturnedOpenRunItems(
      row.delivery_project_id,
      item.id,
    );
    const previousVerifiers: Array<string | null> = [];
    for (const runItem of returned) {
      const reset = await this.runs.requestRetest(
        runItem.run_id,
        runItem.id,
        { id: actor.userId, login: actor.userLogin },
        note,
      );
      if (reset) {
        previousVerifiers.push(runItem.verified_by);
      }
    }

    const notifications = this.notificationEventsService;
    if (!notifications) {
      return false;
    }
    const project = await this.projectContext.findProject(
      row.delivery_project_id,
    );
    const anchor = project
      ? await this.projectContext.anchorProjectId(project)
      : null;
    if (!project || !anchor) {
      return false;
    }
    const qaIds = await this.access.listWorkspaceQaIds(project.groupId);
    const recipients = this.dedupeExcludingActor(
      [...previousVerifiers, ...qaIds],
      actor.userId,
    );
    if (recipients.length === 0) {
      return false;
    }
    const body = [
      `${row.name} in ${project.name}.`,
      note ? this.truncate(note, NOTE_TRUNCATE_LENGTH) : null,
    ]
      .filter((part): part is string => Boolean(part))
      .join(' ');
    await Promise.all(
      recipients.map((userId) =>
        notifications.record({
          userId,
          projectId: anchor,
          eventCode: READY_FOR_QA_EVENT,
          title: `Ready for QA: "${item.title}"`,
          body,
        }),
      ),
    );
    return true;
  }

  // ---------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------

  private async requireRequirement(
    id: string,
    userId: string,
  ): Promise<QaChecklistRow> {
    const row = await this.checklists.findById(id);
    if (
      !row ||
      !(await this.access.canAccessWorkspace(userId, row.workspace_id))
    ) {
      throw new NotFoundException('Requirement not found');
    }
    return row;
  }

  private async requireItem(
    checklistId: string,
    itemId: string,
  ): Promise<QaChecklistItemRow> {
    const item = await this.requirements.findItem(checklistId, itemId);
    if (!item) {
      throw new NotFoundException('Requirement item not found');
    }
    return item;
  }

  private async assertManage(userId: string): Promise<void> {
    if (!(await this.access.canManage(userId))) {
      throw requirementManageForbidden();
    }
  }

  private assertNotArchived(row: QaChecklistRow): void {
    if (row.archived_at) {
      throw requirementArchived();
    }
  }

  private assertItemCount(count: number): void {
    if (count > QA_REQUIREMENT_MAX_ITEMS) {
      throw new BadRequestException(
        `A requirement may have at most ${QA_REQUIREMENT_MAX_ITEMS} items.`,
      );
    }
  }

  private parseKind(raw: string): QaRequirementKind {
    if (!(QA_REQUIREMENT_KINDS as readonly string[]).includes(raw)) {
      throw requirementKindInvalid();
    }
    return raw as QaRequirementKind;
  }

  private requireNonBlank(value: string, field: string): string {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      throw new BadRequestException(`${field} must not be blank`);
    }
    return trimmed;
  }

  private isUniqueViolation(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === QA_UNIQUE_VIOLATION
    );
  }

  private countProgress(items: QaChecklistItemRow[]): QaProgressCounts {
    const counts: QaProgressCounts = { todo: 0, in_progress: 0, done: 0 };
    for (const item of items) {
      counts[item.progress] += 1;
    }
    return counts;
  }

  private async assembleOne(
    row: QaChecklistRow,
    role: PlatformAppRole,
  ): Promise<Requirement> {
    const items = await this.checklists.listItemsByChecklistIds([row.id]);
    return this.toRequirement(row, items.get(row.id) ?? [], role);
  }

  private async assembleMany(
    rows: QaChecklistRow[],
    role: PlatformAppRole,
  ): Promise<Requirement[]> {
    if (rows.length === 0) {
      return [];
    }
    const items = await this.checklists.listItemsByChecklistIds(
      rows.map((row) => row.id),
    );
    return rows.map((row) =>
      this.toRequirement(row, items.get(row.id) ?? [], role),
    );
  }

  toRequirement(
    row: QaChecklistRow,
    items: QaChecklistItemRow[],
    role: PlatformAppRole,
  ): Requirement {
    return {
      id: row.id,
      kind: row.kind,
      deliveryProjectId: row.delivery_project_id,
      workspaceId: row.workspace_id,
      name: row.name,
      description: row.description,
      version: row.version,
      archivedAt: row.archived_at,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      legacyChecklistId: row.legacy_checklist_id,
      items: items.map((item) => this.toItem(item, role, row)),
      progressCounts: this.countProgress(items),
    };
  }

  toItem(
    item: QaChecklistItemRow,
    role: PlatformAppRole,
    requirement: Pick<QaChecklistRow, 'archived_at'>,
  ): RequirementItem {
    return {
      id: item.id,
      position: item.position,
      title: item.title,
      acceptanceCriteria: item.acceptance_criteria,
      verificationType: item.verification_type,
      testIdentifier: item.test_identifier,
      progress: item.progress,
      progressBy: item.progress_by
        ? { id: item.progress_by, login: item.progress_by_login ?? '' }
        : null,
      progressAt: item.progress_at,
      rowVersion: item.row_version,
      canSetProgress: canSetProgress(role) && !requirement.archived_at,
    };
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

  private async recordEvent(
    eventCode: string,
    row: QaChecklistRow,
    actorUserId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.auditEventsService?.recordProjectEvent({
      workspaceId: row.workspace_id,
      actorUserId,
      eventCode,
      message: `QA requirement "${row.name}" ${eventCode.split('.').pop()}`,
      metadata: {
        requirementId: row.id,
        deliveryProjectId: row.delivery_project_id,
        ...metadata,
      },
    });
  }
}

function zeroCounts(): QaVerificationStatusCounts {
  return {
    pending: 0,
    passed: 0,
    failed: 0,
    blocked: 0,
    returned_to_dev: 0,
  };
}

export type { QaProgress };
