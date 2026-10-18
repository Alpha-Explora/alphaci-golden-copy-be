import {
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';

import {
  QA_ATTACHMENT_STORAGE,
  type QaAttachmentStoragePort,
} from '../application/qa-runs/qa-attachment-storage.port';

/**
 * Serves screenshot bytes to the signed links the postgres driver mints.
 *
 * No session guard: the HMAC link is the authorization, valid for five minutes,
 * the same role the Supabase signed URL plays on SaaS. Screenshots load into
 * <img> tags on the frontend's origin, which cannot send the session cookie
 * cross-site, so a session check here would break every image. A bad, forged or
 * expired link gets the same 403, so the route does not reveal which paths exist.
 */
@Controller('qa-attachments')
export class QaAttachmentContentController {
  constructor(
    @Inject(QA_ATTACHMENT_STORAGE)
    private readonly storage: QaAttachmentStoragePort,
  ) {}

  @Get('content')
  async getContent(
    @Query('path') path: string,
    @Query('exp') exp: string,
    @Query('sig') sig: string,
    @Res() res: Response,
  ): Promise<void> {
    const object =
      typeof path === 'string' &&
      typeof sig === 'string' &&
      /^\d{1,12}$/.test(String(exp))
        ? await this.storage.readSignedLink(path, Number(exp), sig)
        : null;
    if (!object) {
      throw new ForbiddenException(
        'This attachment link is invalid or has expired.',
      );
    }

    res.setHeader('Content-Type', object.contentType);
    res.setHeader('Content-Length', String(object.bytes.length));
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Helmet's default (same-origin) would block the frontend's <img> loads.
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.status(200).end(object.bytes);
  }
}
