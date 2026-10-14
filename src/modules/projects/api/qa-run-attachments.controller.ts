import {
  Body,
  CallHandler,
  Controller,
  Delete,
  ExecutionContext,
  Get,
  HttpCode,
  Injectable,
  NestInterceptor,
  Param,
  PayloadTooLargeException,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import type { Observable } from 'rxjs';

import {
  CapabilityGuard,
  RequiresCapability,
} from '#kernel/composition/index.js';
import { SessionAuthGuard } from '#kernel/auth/session-auth.guard';
import { QA_ATTACHMENT_MAX_BYTES } from '../domain/qa-attachment-image.rules';
import { qaAttachmentTooLarge } from '../application/qa-checklists/qa-errors';
import {
  parseQaAttachmentFields,
  type UploadedQaAttachmentFile,
} from '../application/qa-runs/qa-attachments.fields';
import { QaRunAttachmentsService } from '../application/qa-runs/qa-run-attachments.service';
import { actorContext } from './qa-runs.controller';

/**
 * Multer's own limits bound what a caller can make us buffer: one file, one
 * byte over the 3 MB cap (so the service can tell "exactly at the cap" from
 * "over" and answer with the coded error), and a handful of short text fields.
 */
const UploadInterceptor = FileInterceptor('file', {
  limits: {
    fileSize: QA_ATTACHMENT_MAX_BYTES + 1,
    files: 1,
    fields: 6,
    fieldSize: 2048,
    parts: 8,
  },
});

/**
 * Multer answers an oversize file with a bare 413; this swaps it for the same
 * coded body the service uses (QA_ATTACHMENT_TOO_LARGE) so the frontend has one
 * code to key on.
 */
@Injectable()
export class QaAttachmentFileInterceptor
  extends UploadInterceptor
  implements NestInterceptor
{
  override async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    try {
      return await super.intercept(context, next);
    } catch (error) {
      if (error instanceof PayloadTooLargeException) {
        throw qaAttachmentTooLarge('A screenshot may be at most 3 MB.');
      }
      throw error;
    }
  }
}

/**
 * Screenshots on a Project run item. Same prefix, guards and capability as the
 * other Project-run routes; the role rules live in QaRunAttachmentsService.
 */
@Controller('delivery-projects/:deliveryProjectId/qa-runs/:runId')
@UseGuards(SessionAuthGuard, CapabilityGuard)
@RequiresCapability('projects.qa-checklists')
export class DeliveryProjectQaAttachmentsController {
  constructor(private readonly attachments: QaRunAttachmentsService) {}

  /** multipart/form-data: file, caption?, source? ('capture' | 'paste' | 'upload'), kind? ('evidence'). */
  @Post('items/:itemId/attachments')
  @UseInterceptors(QaAttachmentFileInterceptor)
  add(
    @Req() req: Request,
    @Param('deliveryProjectId') deliveryProjectId: string,
    @Param('runId') runId: string,
    @Param('itemId') itemId: string,
    @Body() body: Record<string, unknown> | undefined,
    @UploadedFile() file: UploadedQaAttachmentFile | undefined,
  ) {
    return this.attachments.add(
      deliveryProjectId,
      actorContext(req),
      runId,
      itemId,
      file,
      parseQaAttachmentFields(body),
    );
  }

  /** Newest first. */
  @Get('items/:itemId/attachments')
  listForItem(
    @Req() req: Request,
    @Param('deliveryProjectId') deliveryProjectId: string,
    @Param('runId') runId: string,
    @Param('itemId') itemId: string,
  ) {
    return this.attachments.listForItem(
      deliveryProjectId,
      actorContext(req),
      runId,
      itemId,
    );
  }

  /** Every attachment of the run: one call renders all thumbnails. */
  @Get('attachments')
  listForRun(
    @Req() req: Request,
    @Param('deliveryProjectId') deliveryProjectId: string,
    @Param('runId') runId: string,
  ) {
    return this.attachments.listForRun(
      deliveryProjectId,
      actorContext(req),
      runId,
    );
  }

  @Delete('attachments/:attachmentId')
  @HttpCode(204)
  async remove(
    @Req() req: Request,
    @Param('deliveryProjectId') deliveryProjectId: string,
    @Param('runId') runId: string,
    @Param('attachmentId') attachmentId: string,
  ): Promise<void> {
    await this.attachments.remove(
      deliveryProjectId,
      actorContext(req),
      runId,
      attachmentId,
    );
  }
}
