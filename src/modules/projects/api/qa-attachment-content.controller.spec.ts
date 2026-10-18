import { createHash } from 'node:crypto';

import { ForbiddenException } from '@nestjs/common';
import type { Response } from 'express';

import type { QaAttachmentStoragePort } from '../application/qa-runs/qa-attachment-storage.port';
import {
  QA_ATTACHMENT_CONTENT_RATE_LIMIT,
  QaAttachmentContentController,
} from './qa-attachment-content.controller';

const PATH = 'run/item/att.png';
const BYTES = Buffer.from('png-bytes');
const ETAG = `"${createHash('sha256').update(BYTES).digest('base64url')}"`;

function setup(readSignedLink: jest.Mock) {
  const storage = { readSignedLink } as unknown as QaAttachmentStoragePort;
  const controller = new QaAttachmentContentController(storage);
  const res = {
    setHeader: jest.fn(),
    status: jest.fn().mockReturnThis(),
    end: jest.fn(),
  };
  return { controller, res, readSignedLink };
}

describe('QaAttachmentContentController', () => {
  it('pins a route-level throttle that is more generous than the app default and keeps the default throttler', () => {
    const handler = QaAttachmentContentController.prototype.getContent;

    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', handler)).toBe(300);
    expect(Reflect.getMetadata('THROTTLER:TTLdefault', handler)).toBe(60_000);
    expect(QA_ATTACHMENT_CONTENT_RATE_LIMIT).toEqual({
      ttl: 60_000,
      limit: 300,
    });
    expect(
      Reflect.getMetadata('THROTTLER:SKIPdefault', handler),
    ).toBeUndefined();
    expect(
      Reflect.getMetadata(
        'THROTTLER:SKIPdefault',
        QaAttachmentContentController,
      ),
    ).toBeUndefined();
  });

  it('serves the bytes with the stored type, a private cache lifetime and an ETag', async () => {
    const readSignedLink = jest.fn().mockResolvedValue({
      bytes: BYTES,
      contentType: 'image/png',
    });
    const { controller, res } = setup(readSignedLink);

    await controller.getContent(
      PATH,
      '1800000060',
      'a'.repeat(64),
      res as unknown as Response,
    );

    expect(readSignedLink).toHaveBeenCalledWith(
      PATH,
      1800000060,
      'a'.repeat(64),
    );
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'image/png');
    expect(res.setHeader).toHaveBeenCalledWith(
      'Cache-Control',
      'private, max-age=300',
    );
    expect(res.setHeader).toHaveBeenCalledWith('ETag', ETAG);
    expect(res.setHeader).toHaveBeenCalledWith(
      'Cross-Origin-Resource-Policy',
      'cross-origin',
    );
    expect(res.setHeader).toHaveBeenCalledWith(
      'X-Content-Type-Options',
      'nosniff',
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.end).toHaveBeenCalledWith(BYTES);
  });

  it('answers 304 with no body when If-None-Match names the current ETag', async () => {
    const readSignedLink = jest.fn().mockResolvedValue({
      bytes: BYTES,
      contentType: 'image/png',
    });
    const { controller, res } = setup(readSignedLink);

    await controller.getContent(
      PATH,
      '1800000060',
      'a'.repeat(64),
      res as unknown as Response,
      `"stale", W/${ETAG}`,
    );

    expect(res.status).toHaveBeenCalledWith(304);
    expect(res.end).toHaveBeenCalledWith();
    expect(res.setHeader).toHaveBeenCalledWith('ETag', ETAG);
    expect(res.setHeader).not.toHaveBeenCalledWith('Content-Type', 'image/png');
  });

  it('answers 304 for If-None-Match: *', async () => {
    const { controller, res } = setup(
      jest.fn().mockResolvedValue({ bytes: BYTES, contentType: 'image/png' }),
    );

    await controller.getContent(
      PATH,
      '1800000060',
      'a'.repeat(64),
      res as unknown as Response,
      '*',
    );

    expect(res.status).toHaveBeenCalledWith(304);
  });

  it('answers 200 with the bytes when If-None-Match names a different ETag', async () => {
    const { controller, res } = setup(
      jest.fn().mockResolvedValue({ bytes: BYTES, contentType: 'image/png' }),
    );

    await controller.getContent(
      PATH,
      '1800000060',
      'a'.repeat(64),
      res as unknown as Response,
      '"some-other-version"',
    );

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.end).toHaveBeenCalledWith(BYTES);
  });

  it('answers 403 for a link the storage does not accept', async () => {
    const { controller, res } = setup(jest.fn().mockResolvedValue(null));

    await expect(
      controller.getContent(
        PATH,
        '1800000060',
        'a'.repeat(64),
        res as unknown as Response,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(res.end).not.toHaveBeenCalled();
  });

  it('answers 403 without consulting storage when the expiry is not a number', async () => {
    const readSignedLink = jest.fn();
    const { controller, res } = setup(readSignedLink);

    await expect(
      controller.getContent(
        PATH,
        'soon',
        'a'.repeat(64),
        res as unknown as Response,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(readSignedLink).not.toHaveBeenCalled();
  });

  it('answers 403 without consulting storage when a parameter is missing', async () => {
    const readSignedLink = jest.fn();
    const { controller, res } = setup(readSignedLink);

    await expect(
      controller.getContent(
        undefined as unknown as string,
        '1800000060',
        'a'.repeat(64),
        res as unknown as Response,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(readSignedLink).not.toHaveBeenCalled();
  });
});
