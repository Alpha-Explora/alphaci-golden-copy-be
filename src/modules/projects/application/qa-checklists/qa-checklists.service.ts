import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import type { WorkspaceDataCleanupPort } from '#kernel/ports/workspace-data-cleanup.port';

import { AuditEventPublisher } from '#kernel/events/platform-event-publisher.js';
import {
  QA_UNIQUE_VIOLATION,
  QaChecklistsRepository,
  type QaChecklistItemRow,
  type QaChecklistRow,
} from '../../infrastructure/qa-checklists.repository';
import { QaAccessService } from './qa-access.service';
import {
  QA_CHECKLIST_MAX_ITEMS,
  type QaChecklist,
} from './qa-checklists.contracts';
import type { CreateQaChecklistDto } from './dto/create-qa-checklist.dto';
import type { UpdateQaChecklistDto } from './dto/update-qa-checklist.dto';
import type { ReplaceQaChecklistItemsDto } from './dto/replace-qa-checklist-items.dto';
import type { ShareQaChecklistProjectsDto } from './dto/share-qa-checklist-projects.dto';
import type { UpdateQaChecklistProjectsDto } from './dto/update-qa-checklist-projects.dto';

type AuditEventSink = Pick<AuditEventPublisher, 'recordProjectEvent'>;

const QA_CHECKLIST_EVENTS = {
  created: 'qa.checklist.created',
  updated: 'qa.checklist.updated',
  shared: 'qa.checklist.shared',
  archived: 'qa.checklist.archived',
} as const;

export interface QaChecklistListResult {
  items: QaChecklist[];
  canManage: boolean;
}

@Injectable()
export class QaChecklistsService implements WorkspaceDataCleanupPort {
  constructor(
    private readonly repository: QaChecklistsRepository,
    private readonly access: QaAccessService,
    // Explicit token: AuditEventSink is a type alias, which TypeScript emits
    // as `Object` in design:paramtypes, so without @Inject Nest finds no
    // provider and @Optional() silently injects undefined.
    @Optional()
    @Inject(AuditEventPublisher)
    private readonly auditEventsService?: AuditEventSink,
  ) {}

  /**
   * WorkspaceDataCleanupPort: called by the workspace deletion flow. No
   * authorization here: the caller has already authorized and performed the
   * workspace delete, and this only removes data that is now unreachable.
   */
  async purgeWorkspace(workspaceId: string): Promise<{ removed: number }> {
    return { removed: await this.repository.deleteByWorkspace(workspaceId) };
  }

  async listForWorkspace(
    workspaceId: string,
    userId: string,
    includeArchived: boolean,
  ): Promise<QaChecklistListResult> {
    await this.assertWorkspaceAccess(userId, workspaceId);
    const canManage = await this.access.canManage(userId);
    const rows = await this.repository.listByWorkspace(
      workspaceId,
      includeArchived,
    );
    return { items: await this.assembleMany(rows), canManage };
  }

  async createForWorkspace(
    workspaceId: string,
    userId: string,
    dto: CreateQaChecklistDto,
  ): Promise<QaChecklist> {
    await this.assertWorkspaceAccess(userId, workspaceId);
    await this.assertManage(userId);

    const name = this.requireNonBlank(dto.name, 'name');
    const description = dto.description ?? null;
    const items = dto.items ?? [];
    this.assertItemCount(items.length);

    if (await this.repository.hasActiveNameConflict(workspaceId, name)) {
      throw this.nameConflict(name);
    }

    try {
      const { checklist, items: itemRows } =
        await this.repository.createWithItems({
          workspaceId,
          name,
          description,
          createdBy: userId,
          items,
        });
      await this.recordEvent(QA_CHECKLIST_EVENTS.created, checklist, userId, {
        name,
      });
      return this.toChecklist(checklist, itemRows, []);
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        throw this.nameConflict(name);
      }
      throw error;
    }
  }

  async getById(id: string, userId: string): Promise<QaChecklist> {
    const checklist = await this.requireChecklist(id);
    await this.assertWorkspaceAccess(userId, checklist.workspace_id);
    return this.assembleOne(checklist);
  }

  async updateMeta(
    id: string,
    userId: string,
    dto: UpdateQaChecklistDto,
  ): Promise<QaChecklist> {
    const checklist = await this.requireChecklist(id);
    await this.assertWorkspaceAccess(userId, checklist.workspace_id);
    await this.assertManage(userId);
    this.assertNotArchived(checklist);
    this.assertVersion(checklist, dto.expectedVersion);

    const name =
      dto.name === undefined
        ? undefined
        : this.requireNonBlank(dto.name, 'name');

    if (
      name !== undefined &&
      (await this.repository.hasActiveNameConflict(
        checklist.workspace_id,
        name,
        id,
      ))
    ) {
      throw this.nameConflict(name);
    }

    let updated: QaChecklistRow | null;
    try {
      updated = await this.repository.updateMeta(
        id,
        dto.expectedVersion,
        {
          // exactOptionalPropertyTypes: omit the key entirely rather than
          // set it to `undefined` — UpdateQaChecklistMetaPatch's `name?`
          // means "if present, a string", and `description` distinguishes
          // "not provided" (key absent) from "explicit null" (clear it).
          ...(name !== undefined ? { name } : {}),
          ...(dto.description !== undefined
            ? { description: dto.description }
            : {}),
        },
        userId,
      );
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        throw this.nameConflict(name ?? checklist.name);
      }
      throw error;
    }

    if (!updated) {
      throw new ConflictException(await this.conflictReasonFor(id));
    }

    await this.recordEvent(QA_CHECKLIST_EVENTS.updated, updated, userId, {
      fields: [
        ...(name !== undefined ? ['name'] : []),
        ...(dto.description !== undefined ? ['description'] : []),
      ],
    });
    return this.assembleOne(updated);
  }

  async replaceItems(
    id: string,
    userId: string,
    dto: ReplaceQaChecklistItemsDto,
  ): Promise<QaChecklist> {
    const checklist = await this.requireChecklist(id);
    await this.assertWorkspaceAccess(userId, checklist.workspace_id);
    await this.assertManage(userId);
    this.assertNotArchived(checklist);
    this.assertVersion(checklist, dto.expectedVersion);
    this.assertItemCount(dto.items.length);

    const result = await this.repository.replaceItems(
      id,
      dto.expectedVersion,
      dto.items,
      userId,
    );
    if (!result) {
      throw new ConflictException(await this.conflictReasonFor(id));
    }

    await this.recordEvent(
      QA_CHECKLIST_EVENTS.updated,
      result.checklist,
      userId,
      { fields: ['items'], itemCount: dto.items.length },
    );
    const sharedProjectIds = await this.sharedProjectIdsFor(id);
    return this.toChecklist(result.checklist, result.items, sharedProjectIds);
  }

  async archive(id: string, userId: string): Promise<QaChecklist> {
    const checklist = await this.requireChecklist(id);
    await this.assertWorkspaceAccess(userId, checklist.workspace_id);
    await this.assertManage(userId);

    const wasAlreadyArchived = checklist.archived_at !== null;
    const archived = await this.repository.archive(id, userId);
    if (!archived) {
      throw new NotFoundException('Checklist not found');
    }

    if (!wasAlreadyArchived) {
      await this.recordEvent(
        QA_CHECKLIST_EVENTS.archived,
        archived,
        userId,
        {},
      );
    }
    return this.assembleOne(archived);
  }

  async setSharedProjects(
    id: string,
    userId: string,
    dto: ShareQaChecklistProjectsDto,
  ): Promise<QaChecklist> {
    const checklist = await this.requireChecklist(id);
    await this.assertWorkspaceAccess(userId, checklist.workspace_id);
    await this.assertManage(userId);
    this.assertNotArchived(checklist);

    const requestedIds = [...new Set(dto.projectIds)];
    const validIds = await this.repository.validWorkspaceProjectIds(
      checklist.workspace_id,
      requestedIds,
    );
    if (validIds.length !== requestedIds.length) {
      const validSet = new Set(validIds);
      const rejected = requestedIds.filter((pid) => !validSet.has(pid));
      throw new BadRequestException(
        `These project ids are not in this checklist's workspace: ${rejected.join(', ')}`,
      );
    }

    const sharedProjectIds = await this.repository.replaceSharedProjects(
      id,
      requestedIds,
      userId,
    );
    await this.recordEvent(QA_CHECKLIST_EVENTS.shared, checklist, userId, {
      projectIds: sharedProjectIds,
    });

    const itemsByChecklist = await this.repository.listItemsByChecklistIds([
      id,
    ]);
    return this.toChecklist(
      checklist,
      itemsByChecklist.get(id) ?? [],
      sharedProjectIds,
    );
  }

  /**
   * Attaches and detaches projects without replacing the rest of the share
   * set. Added ids must belong to the checklist's workspace (400 otherwise);
   * removing a project that is not shared is a no-op.
   */
  async updateSharedProjects(
    id: string,
    userId: string,
    dto: UpdateQaChecklistProjectsDto,
  ): Promise<QaChecklist> {
    const checklist = await this.requireChecklist(id);
    await this.assertWorkspaceAccess(userId, checklist.workspace_id);
    await this.assertManage(userId);
    this.assertNotArchived(checklist);

    const add = [...new Set(dto.add ?? [])];
    const remove = [...new Set(dto.remove ?? [])];
    if (add.length === 0 && remove.length === 0) {
      throw new BadRequestException(
        'Nothing to change: pass project ids in add or remove.',
      );
    }
    const removeSet = new Set(remove);
    const both = add.filter((pid) => removeSet.has(pid));
    if (both.length > 0) {
      throw new BadRequestException(
        `These project ids are in both add and remove: ${both.join(', ')}`,
      );
    }

    if (add.length > 0) {
      const validIds = await this.repository.validWorkspaceProjectIds(
        checklist.workspace_id,
        add,
      );
      if (validIds.length !== add.length) {
        const validSet = new Set(validIds);
        const rejected = add.filter((pid) => !validSet.has(pid));
        throw new BadRequestException(
          `These project ids are not in this checklist's workspace: ${rejected.join(', ')}`,
        );
      }
    }

    const sharedProjectIds = await this.repository.updateSharedProjects(
      id,
      add,
      remove,
      userId,
    );
    await this.recordEvent(QA_CHECKLIST_EVENTS.shared, checklist, userId, {
      projectIds: sharedProjectIds,
      added: add,
      removed: remove,
    });

    const itemsByChecklist = await this.repository.listItemsByChecklistIds([
      id,
    ]);
    return this.toChecklist(
      checklist,
      itemsByChecklist.get(id) ?? [],
      sharedProjectIds,
    );
  }

  async listForProject(
    projectId: string,
    userId: string,
  ): Promise<QaChecklistListResult> {
    const project = await this.access.findVisibleProjectWorkspace(
      projectId,
      userId,
    );
    if (!project) {
      throw new NotFoundException('Project not found');
    }

    const canManage = project.workspaceId
      ? (await this.access.canAccessWorkspace(userId, project.workspaceId)) &&
        (await this.access.canManage(userId))
      : false;

    const rows = await this.repository.listByProject(projectId);
    return { items: await this.assembleMany(rows), canManage };
  }

  private async requireChecklist(id: string): Promise<QaChecklistRow> {
    const checklist = await this.repository.findById(id);
    if (!checklist) {
      throw new NotFoundException('Checklist not found');
    }
    return checklist;
  }

  /**
   * False means "not a member of this workspace" (or the workspace does not
   * exist) — reported as 404, never 403, so a non-member learns nothing about
   * whether the workspace or its checklists exist.
   */
  private async assertWorkspaceAccess(
    userId: string,
    workspaceId: string,
  ): Promise<void> {
    if (!(await this.access.canAccessWorkspace(userId, workspaceId))) {
      throw new NotFoundException('Checklist not found');
    }
  }

  private async assertManage(userId: string): Promise<void> {
    if (!(await this.access.canManage(userId))) {
      throw new ForbiddenException(
        'Only a workspace lead or admin can manage QA checklists',
      );
    }
  }

  private assertNotArchived(checklist: QaChecklistRow): void {
    if (checklist.archived_at) {
      throw new ConflictException('Checklist is archived');
    }
  }

  private assertVersion(
    checklist: QaChecklistRow,
    expectedVersion: number,
  ): void {
    if (checklist.version !== expectedVersion) {
      throw new ConflictException(
        `Checklist has changed (expected version ${expectedVersion}, current version ${checklist.version})`,
      );
    }
  }

  private assertItemCount(count: number): void {
    if (count > QA_CHECKLIST_MAX_ITEMS) {
      throw new BadRequestException(
        `A checklist may have at most ${QA_CHECKLIST_MAX_ITEMS} items.`,
      );
    }
  }

  private requireNonBlank(value: string, field: string): string {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      throw new BadRequestException(`${field} must not be blank`);
    }
    return trimmed;
  }

  private nameConflict(name: string): ConflictException {
    return new ConflictException(
      `A checklist named "${name}" already exists in this workspace.`,
    );
  }

  /** Re-reads the row to tell an already-archived race apart from a plain version race. */
  private async conflictReasonFor(id: string): Promise<string> {
    const current = await this.repository.findById(id);
    if (current?.archived_at) {
      return 'Checklist is archived';
    }
    return 'Checklist was modified by someone else; reload and try again';
  }

  private isUniqueViolation(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === QA_UNIQUE_VIOLATION
    );
  }

  private async sharedProjectIdsFor(checklistId: string): Promise<string[]> {
    const shares = await this.repository.listSharedProjectIdsByChecklistIds([
      checklistId,
    ]);
    return shares.get(checklistId) ?? [];
  }

  private async assembleOne(checklist: QaChecklistRow): Promise<QaChecklist> {
    const [itemsByChecklist, sharesByChecklist] = await Promise.all([
      this.repository.listItemsByChecklistIds([checklist.id]),
      this.repository.listSharedProjectIdsByChecklistIds([checklist.id]),
    ]);
    return this.toChecklist(
      checklist,
      itemsByChecklist.get(checklist.id) ?? [],
      sharesByChecklist.get(checklist.id) ?? [],
    );
  }

  private async assembleMany(rows: QaChecklistRow[]): Promise<QaChecklist[]> {
    if (rows.length === 0) {
      return [];
    }
    const ids = rows.map((row) => row.id);
    const [itemsByChecklist, sharesByChecklist] = await Promise.all([
      this.repository.listItemsByChecklistIds(ids),
      this.repository.listSharedProjectIdsByChecklistIds(ids),
    ]);
    return rows.map((row) =>
      this.toChecklist(
        row,
        itemsByChecklist.get(row.id) ?? [],
        sharesByChecklist.get(row.id) ?? [],
      ),
    );
  }

  private toChecklist(
    row: QaChecklistRow,
    items: QaChecklistItemRow[],
    sharedProjectIds: string[],
  ): QaChecklist {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      name: row.name,
      description: row.description,
      version: row.version,
      archivedAt: row.archived_at,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      items: items.map((item) => ({
        id: item.id,
        position: item.position,
        title: item.title,
        description: item.description,
        targetPersona: item.target_persona,
        verificationType: item.verification_type,
        testIdentifier: item.test_identifier,
      })),
      sharedProjectIds,
    };
  }

  private async recordEvent(
    eventCode: string,
    checklist: QaChecklistRow,
    actorUserId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.auditEventsService?.recordProjectEvent({
      workspaceId: checklist.workspace_id,
      actorUserId,
      eventCode,
      message: `QA checklist "${checklist.name}" ${eventCode.split('.').pop()}`,
      metadata: { checklistId: checklist.id, ...metadata },
    });
  }
}
