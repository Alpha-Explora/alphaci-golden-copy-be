import { createHash } from 'node:crypto';

import {
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Inject,
  Query,
  Res,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';

import {
  QA_ATTACHMENT_STORAGE,
  type QaAttachmentStoragePort,
} from '../application/qa-runs/qa-attachment-storage.port';

/**
 * Requests one client address may make to the content route per minute. The
 * app default (60) is sized for JSON calls, and a QA run page loads one request
 * per screenshot, so this is five times that. Each request reads up to 3 MB
 * from a pool of three connections, so the cap stays well short of a flood. The
 * route has no session, so the limiter keys on the client address.
 */
export const QA_ATTACHMENT_CONTENT_RATE_LIMIT = { ttl: 60_000, limit: 300 };

/** Browser cache lifetime for served bytes; matches the five-minute link lifetime. */
export const QA_ATTACHMENT_CACHE_MAX_AGE_SECONDS = 300;

/**
 * Serves screenshot bytes to the signed links the postgres driver mints.
 *
 * No session guard: the HMAC link is the authorization, valid for five minutes,
 * the same role the Supabase signed URL plays on SaaS. Screenshots load into
 * <img> tags on the frontend's origin, which cannot send the session cookie
 * cross-site, so a session check here would break every image. A bad, forged or
 * expired link gets the same 403, so the route does not reveal which paths exist.
 *
 * The ETag is a SHA-256 of the stored bytes. Objects are insert-only, so a
 * matching If-None-Match is answered 304 without a body.
 */
@Controller('qa-attachments')
export class QaAttachmentContentController {
  constructor(
    @Inject(QA_ATTACHMENT_STORAGE)
    private readonly storage: QaAttachmentStoragePort,
  ) {}

  @Get('content')
  @Throttle({ default: QA_ATTACHMENT_CONTENT_RATE_LIMIT })
  async getContent(
    @Query('path') path: string,
    @Query('exp') exp: string,
    @Query('sig') sig: string,
    @Res() res: Response,
    @Headers('if-none-match') ifNoneMatch?: string,
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

    const etag = `"${createHash('sha256').update(object.bytes).digest('base64url')}"`;
    res.setHeader('ETag', etag);
    res.setHeader(
      'Cache-Control',
      `private, max-age=${String(QA_ATTACHMENT_CACHE_MAX_AGE_SECONDS)}`,
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Helmet's default (same-origin) would block the frontend's <img> loads.
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    if (etagMatches(ifNoneMatch, etag)) {
      res.status(304).end();
      return;
    }

    res.setHeader('Content-Type', object.contentType);
    res.setHeader('Content-Length', String(object.bytes.length));
    res.status(200).end(object.bytes);
  }
}

/** True when an If-None-Match header lists the current strong ETag (or `*`). */
function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) {
    return false;
  }
  return header
    .split(',')
    .map((candidate) => candidate.trim().replace(/^W\//, ''))
    .some((candidate) => candidate === '*' || candidate === etag);
}
