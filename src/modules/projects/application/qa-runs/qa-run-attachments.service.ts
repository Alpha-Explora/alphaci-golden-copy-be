import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';

import { QA_BRANCH } from '#kernel/config/pipeline-branches';
import { AuditEventPublisher } from '#kernel/events/platform-event-publisher.js';
import type { PlatformAppRole } from '#kernel/ports/platform-admin.port';
import {
  QA_ATTACHMENT_MAX_BYTES,
  QA_ATTACHMENT_MAX_DIMENSION,
  inspectQaAttachmentImage,
  type QaAttachmentImageInfo,
} from '../../domain/qa-attachment-image.rules';
import { acceptsFixProof } from '../../domain/qa-fix-proof.rules';
import {
  canAddEvidence,
  canAddFixProof,
  canRemoveAnyAttachment,
} from '../../domain/qa-run-access.rules';
import {
  QaAttachmentItemGoneError,
  QaAttachmentLimitReachedError,
  QaFixProofNotRequestedError,
  QaRunAttachmentsRepository,
  type QaRunItemAttachmentRow,
} from '../../infrastructure/qa-run-attachments.repository';
import { QaProjectRunsRepository } from '../../infrastructure/qa-project-runs.repository';
import {
  QaRunNotOpenError,
  QaRunsRepository,
  type QaProjectRunRow,
} from '../../infrastructure/qa-runs.repository';
import { QaAccessService } from '../qa-checklists/qa-access.service';
import {
  QaProjectContextService,
  type QaProjectContext,
} from '../qa-checklists/qa-project-context.service';
import {
  qaAttachmentForbidden,
  qaAttachmentLimit,
  qaFixProofNotRequested,
  qaAttachmentTooLarge,
  qaAttachmentType,
  qaAttachmentsUnavailable,
  qaRunSignedOff,
} from '../qa-checklists/qa-errors';
import {
  QA_ATTACHMENT_STORAGE,
  QA_ATTACHMENT_URL_TTL_SECONDS,
  QaAttachmentStorageError,
  type QaAttachmentStoragePort,
} from './qa-attachment-storage.port';
import {
  QA_ATTACHMENT_MAX_PER_ITEM,
  type QaAttachmentUploadFields,
  type UploadedQaAttachmentFile,
} from './qa-attachments.fields';
import type {
  QaAttachment,
  QaAttachmentList,
  QaRunActorContext,
  QaRunItemAttachmentRef,
} from './qa-runs.contracts';

const QA_ATTACHMENT_EVENTS = {
  added: 'qa.item.attachment_added',
  removed: 'qa.item.attachment_removed',
} as const;

/**
 * Screenshots attached to a Project run item: human `evidence` (A1) and a
 * developer's `fix_proof` (A2).
 *
 * Rules (QA_ATTACHMENTS_PLAN.md section 4): anyone who can see the run can see
 * its attachments; qa|lead|admin add evidence; member|lead|admin add proof of a
 * fix, but only while the item is returned to the developer or awaiting
 * re-test; the uploader or a lead/admin deletes a human attachment; a
 * signed-off run accepts neither (writes take the run row FOR SHARE in the
 * repository, so they serialize against sign-off). Each item holds at most
 * QA_ATTACHMENT_MAX_PER_ITEM of each kind.
 * The bytes are inspected here, never trusted: format and size come from the
 * file's own header.
 */
@Injectable()
export class QaRunAttachmentsService {
  private readonly logger = new Logger(QaRunAttachmentsService.name);

  constructor(
    private readonly runs: QaRunsRepository,
    private readonly projectRuns: QaProjectRunsRepository,
    private readonly attachments: QaRunAttachmentsRepository,
    @Inject(QA_ATTACHMENT_STORAGE)
    private readonly storage: QaAttachmentStoragePort,
    private readonly access: QaAccessService,
    private readonly projectContext: QaProjectContextService,
    // Explicit token: the sink alias is a type alias, which TypeScript emits as
    // `Object`, so @Optional() alone would silently inject undefined.
    @Optional()
    @Inject(AuditEventPublisher)
    private readonly auditEventsService?: Pick<
      AuditEventPublisher,
      'recordProjectEvent'
    >,
  ) {}

  // ---------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------

  async listForItem(
    deliveryProjectId: string,
    actor: QaRunActorContext,
    runId: string,
    itemId: string,
  ): Promise<QaAttachmentList> {
    const { run, role } = await this.readContext(
      deliveryProjectId,
      actor,
      runId,
    );
    await this.requireItem(run.id, itemId);
    const rows = await this.attachments.listByItem(run.id, itemId);
    return { items: await this.render(rows, actor, role, run) };
  }

  async listForRun(
    deliveryProjectId: string,
    actor: QaRunActorContext,
    runId: string,
  ): Promise<QaAttachmentList> {
    const { run, role } = await this.readContext(
      deliveryProjectId,
      actor,
      runId,
    );
    const rows = await this.attachments.listByRun(run.id);
    return { items: await this.render(rows, actor, role, run) };
  }

  /** False when screenshot storage is not configured: the UI hides its attach controls. */
  isEnabled(): boolean {
    return this.storage.isConfigured();
  }

  /** run item id -> number of attachments (all kinds), for the run payload. */
  countsByItem(runId: string): Promise<Map<string, number>> {
    return this.attachments.countsByItem(runId);
  }

  /** run item id -> number of `fix_proof` attachments, for the run payload. */
  fixProofCountsByItem(runId: string): Promise<Map<string, number>> {
    return this.attachments.fixProofCountsByItem(runId);
  }

  /** The ids and captions the QA report carries (no URLs), grouped by run item. */
  async referencesForRun(
    runId: string,
  ): Promise<Map<string, QaRunItemAttachmentRef[]>> {
    const rows = await this.attachments.listByRun(runId);
    const byItem = new Map<string, QaRunItemAttachmentRef[]>();
    // Oldest first inside the report: it reads in the order they were taken.
    for (const row of [...rows].reverse()) {
      const refs = byItem.get(row.run_item_id) ?? [];
      refs.push({
        id: row.id,
        caption: row.caption,
        kind: row.kind,
        contentType: row.content_type,
      });
      byItem.set(row.run_item_id, refs);
    }
    return byItem;
  }

  // ---------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------

  async add(
    deliveryProjectId: string,
    actor: QaRunActorContext,
    runId: string,
    itemId: string,
    file: UploadedQaAttachmentFile | undefined,
    fields: QaAttachmentUploadFields,
  ): Promise<QaAttachment> {
    const { project, run, role } = await this.readContext(
      deliveryProjectId,
      actor,
      runId,
    );
    const item = await this.requireItem(run.id, itemId);

    this.requireMayAdd(role, fields.kind);
    this.requireRunOpen(run);
    if (fields.kind === 'fix_proof' && !acceptsFixProof(item)) {
      throw qaFixProofNotRequested();
    }
    this.requireConfigured();
    const image = this.inspect(file);
    const bytes = (file as UploadedQaAttachmentFile).buffer;

    // Cheap early answer before spending an upload; the insert re-checks the
    // limit under the item lock, which is the authoritative one.
    const existing = await this.attachments.listByItem(run.id, item.id);
    const ofKind = existing.filter((row) => row.kind === fields.kind).length;
    if (ofKind >= QA_ATTACHMENT_MAX_PER_ITEM) {
      throw qaAttachmentLimit(QA_ATTACHMENT_MAX_PER_ITEM);
    }

    const id = randomUUID();
    const storagePath = `${run.id}/${item.id}/${id}.${image.extension}`;
    await this.upload(storagePath, bytes, image.contentType);

    let row: QaRunItemAttachmentRow;
    try {
      row = await this.attachments.insert({
        id,
        runId: run.id,
        runItemId: item.id,
        kind: fields.kind,
        storagePath,
        contentType: image.contentType,
        byteSize: bytes.length,
        width: image.width,
        height: image.height,
        caption: fields.caption,
        source: fields.source,
        createdBy: actor.userId,
        createdByLogin: actor.userLogin,
        maxPerKind: QA_ATTACHMENT_MAX_PER_ITEM,
      });
    } catch (error) {
      // No orphans: the row was not written, so the object must not stay.
      await this.removeObject(storagePath);
      throw this.mapWriteError(error);
    }

    await this.recordAudit(QA_ATTACHMENT_EVENTS.added, project, actor, run, {
      itemId: item.id,
      attachmentId: row.id,
      kind: row.kind,
      uploadedBy: actor.userLogin,
    });

    const [attachment] = await this.render([row], actor, role, run);
    if (!attachment) {
      // The object was just written; failing to sign it is a storage fault.
      throw qaAttachmentsUnavailable();
    }
    return attachment;
  }

  async remove(
    deliveryProjectId: string,
    actor: QaRunActorContext,
    runId: string,
    attachmentId: string,
  ): Promise<void> {
    const { project, run, role } = await this.readContext(
      deliveryProjectId,
      actor,
      runId,
    );
    const row = await this.attachments.findForRun(run.id, attachmentId);
    if (!row) {
      throw new NotFoundException('Attachment not found');
    }
    if (row.kind === 'automated') {
      throw qaAttachmentForbidden(
        'Automated screenshots are replaced by the next run, not deleted by hand.',
      );
    }
    if (!this.mayRemove(row, actor, role)) {
      throw qaAttachmentForbidden(
        'Only the person who attached a screenshot, a lead, or an admin may delete it.',
      );
    }
    this.requireRunOpen(run);

    let deleted: QaRunItemAttachmentRow | null;
    try {
      deleted = await this.attachments.deleteById(run.id, row.id);
    } catch (error) {
      throw this.mapWriteError(error);
    }
    if (!deleted) {
      throw new NotFoundException('Attachment not found');
    }

    // Row first, object second: a failed removal leaves an unreferenced object
    // (harmless, logged), never a row pointing at nothing.
    await this.removeObject(deleted.storage_path);

    await this.recordAudit(QA_ATTACHMENT_EVENTS.removed, project, actor, run, {
      itemId: deleted.run_item_id,
      attachmentId: deleted.id,
      kind: deleted.kind,
      uploadedBy: deleted.created_by_login,
      removedBy: actor.userLogin,
    });
  }

  // ---------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------

  /** Project visibility (404 for a non-member), the run (404), and the caller's role. */
  private async readContext(
    deliveryProjectId: string,
    actor: QaRunActorContext,
    runId: string,
  ): Promise<{
    project: QaProjectContext;
    run: QaProjectRunRow;
    role: PlatformAppRole;
  }> {
    const project = await this.projectContext.requireProject(
      deliveryProjectId,
      actor.userId,
    );
    const run = await this.projectRuns.findProjectRun(deliveryProjectId, runId);
    if (!run) {
      throw new NotFoundException('QA run not found');
    }
    const role = await this.access.findAppRole(actor.userId);
    return { project, run, role };
  }

  private async requireItem(runId: string, itemId: string) {
    const item = await this.runs.findItemForRun(runId, itemId);
    if (!item) {
      throw new NotFoundException('QA run item not found');
    }
    return item;
  }

  /** The role allow-list of the kind being attached: QA's evidence or a developer's fix proof. */
  private requireMayAdd(
    role: PlatformAppRole,
    kind: QaAttachmentUploadFields['kind'],
  ): void {
    if (kind === 'fix_proof') {
      if (!canAddFixProof(role)) {
        throw qaAttachmentForbidden(
          'A developer, a lead, or an admin may attach proof of a fix.',
        );
      }
      return;
    }
    if (!canAddEvidence(role)) {
      throw qaAttachmentForbidden(
        'QA, a lead, or an admin may attach screenshots.',
      );
    }
  }

  private requireRunOpen(run: QaProjectRunRow): void {
    if (run.status === 'signed_off') {
      throw qaRunSignedOff();
    }
  }

  private requireConfigured(): void {
    if (!this.storage.isConfigured()) {
      throw qaAttachmentsUnavailable();
    }
  }

  /** The file's real format and size, from its bytes. Throws the coded 400/413/415. */
  private inspect(
    file: UploadedQaAttachmentFile | undefined,
  ): QaAttachmentImageInfo {
    if (!file?.buffer || file.buffer.length === 0) {
      throw new BadRequestException('file is required.');
    }
    if (file.buffer.length > QA_ATTACHMENT_MAX_BYTES) {
      throw qaAttachmentTooLarge('A screenshot may be at most 3 MB.');
    }
    const image = inspectQaAttachmentImage(file.buffer);
    if (!image) {
      throw qaAttachmentType();
    }
    if (
      image.width > QA_ATTACHMENT_MAX_DIMENSION ||
      image.height > QA_ATTACHMENT_MAX_DIMENSION
    ) {
      throw qaAttachmentTooLarge(
        `A screenshot may be at most ${QA_ATTACHMENT_MAX_DIMENSION}x${QA_ATTACHMENT_MAX_DIMENSION} pixels.`,
      );
    }
    return image;
  }

  private mayRemove(
    row: QaRunItemAttachmentRow,
    actor: QaRunActorContext,
    role: PlatformAppRole,
  ): boolean {
    return (
      (row.created_by !== null && row.created_by === actor.userId) ||
      canRemoveAnyAttachment(role)
    );
  }

  private async upload(
    path: string,
    bytes: Buffer,
    contentType: string,
  ): Promise<void> {
    try {
      await this.storage.upload(path, bytes, contentType);
    } catch (error) {
      this.logger.error(`Attachment upload failed: ${String(error)}`);
      throw qaAttachmentsUnavailable();
    }
  }

  /** Never throws: a failed removal must not mask the real outcome. */
  private async removeObject(path: string): Promise<void> {
    try {
      await this.storage.remove([path]);
    } catch (error) {
      this.logger.warn(
        `Could not remove ${path} from qa-attachments (left unreferenced): ${
          error instanceof QaAttachmentStorageError
            ? error.message
            : String(error)
        }`,
      );
    }
  }

  private mapWriteError(error: unknown): unknown {
    if (error instanceof QaRunNotOpenError) {
      return qaRunSignedOff();
    }
    if (error instanceof QaAttachmentLimitReachedError) {
      return qaAttachmentLimit(error.max);
    }
    if (error instanceof QaFixProofNotRequestedError) {
      return qaFixProofNotRequested();
    }
    if (error instanceof QaAttachmentItemGoneError) {
      return new NotFoundException('QA run item not found');
    }
    return error;
  }

  /** Rows -> API shape with signed URLs; a row whose object cannot be signed is left out. */
  private async render(
    rows: QaRunItemAttachmentRow[],
    actor: QaRunActorContext,
    role: PlatformAppRole,
    run: QaProjectRunRow,
  ): Promise<QaAttachment[]> {
    if (rows.length === 0) {
      return [];
    }
    this.requireConfigured();
    let urls: Map<string, string>;
    try {
      urls = await this.storage.signedUrls(rows.map((row) => row.storage_path));
    } catch (error) {
      this.logger.error(`Attachment signing failed: ${String(error)}`);
      throw qaAttachmentsUnavailable();
    }
    const expiresAt = new Date(
      Date.now() + QA_ATTACHMENT_URL_TTL_SECONDS * 1000,
    ).toISOString();
    const open = run.status === 'open';
    return rows.flatMap((row) => {
      const url = urls.get(row.storage_path);
      if (!url) {
        return [];
      }
      return [
        {
          id: row.id,
          runId: row.run_id,
          runItemId: row.run_item_id,
          kind: row.kind,
          contentType: row.content_type,
          byteSize: row.byte_size,
          width: row.width,
          height: row.height,
          caption: row.caption,
          source: row.source,
          testTitle: row.test_title,
          createdByLogin: row.created_by_login,
          createdAt: new Date(row.created_at).toISOString(),
          url,
          urlExpiresAt: expiresAt,
          canDelete:
            open &&
            row.kind !== 'automated' &&
            this.mayRemove(row, actor, role),
        },
      ];
    });
  }

  private async recordAudit(
    eventCode: string,
    project: QaProjectContext,
    actor: QaRunActorContext,
    run: QaProjectRunRow,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.auditEventsService?.recordProjectEvent({
      workspaceId: project.groupId,
      projectId: await this.projectContext.anchorProjectId(project),
      actorUserId: actor.userId,
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
}
