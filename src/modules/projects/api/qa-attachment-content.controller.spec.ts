import { ForbiddenException } from '@nestjs/common';
import type { Response } from 'express';

import type { QaAttachmentStoragePort } from '../application/qa-runs/qa-attachment-storage.port';
import { QaAttachmentContentController } from './qa-attachment-content.controller';

const PATH = 'run/item/att.png';
const BYTES = Buffer.from('png-bytes');

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
  it('serves the bytes with the stored type and cross-origin image headers', async () => {
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
