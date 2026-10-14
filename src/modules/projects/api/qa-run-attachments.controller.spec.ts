import type { Server } from 'node:http';

import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';

import { SessionAuthGuard } from '#kernel/auth/session-auth.guard';
import { CapabilityGuard } from '#kernel/composition/index.js';
import { pngBytes } from '../__fixtures__/qa-attachment-images';
import { QaRunAttachmentsService } from '../application/qa-runs/qa-run-attachments.service';
import { DeliveryProjectQaAttachmentsController } from './qa-run-attachments.controller';

const BASE = '/delivery-projects/dp-1/qa-runs/run-1';

const attachment = {
  id: 'att-1',
  runId: 'run-1',
  runItemId: 'ri-1',
  kind: 'evidence',
  contentType: 'image/png',
  byteSize: 33,
  width: 1280,
  height: 720,
  caption: 'Receipt',
  source: 'paste',
  testTitle: null,
  createdByLogin: 'qa',
  createdAt: '2026-10-14T10:00:00.000Z',
  url: 'https://signed.example/a.png',
  urlExpiresAt: '2026-10-14T10:05:00.000Z',
  canDelete: true,
};

describe('DeliveryProjectQaAttachmentsController (HTTP)', () => {
  let app: INestApplication;
  const http = () => app.getHttpServer() as Server;
  const service = {
    add: jest.fn(),
    listForItem: jest.fn(),
    listForRun: jest.fn(),
    remove: jest.fn(),
  };

  beforeAll(async () => {
    const allow = { canActivate: () => true };
    const moduleRef = await Test.createTestingModule({
      controllers: [DeliveryProjectQaAttachmentsController],
      providers: [{ provide: QaRunAttachmentsService, useValue: service }],
    })
      .overrideGuard(SessionAuthGuard)
      .useValue(allow)
      .overrideGuard(CapabilityGuard)
      .useValue(allow)
      .compile();
    app = moduleRef.createNestApplication();
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as unknown as { session: unknown }).session = {
        user: { id: 'qa-1', login: 'qa' },
        userId: 'qa-1',
        githubAccessToken: 'tok',
      };
      next();
    });
    // The same pipe main.ts installs: multipart fields must survive it.
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.resetAllMocks();
  });

  describe('POST items/:itemId/attachments', () => {
    it('reads the multipart file and fields and answers 201 with the attachment', async () => {
      service.add.mockResolvedValue(attachment);

      const response = await request(http())
        .post(`${BASE}/items/ri-1/attachments`)
        .field('caption', 'Receipt')
        .field('source', 'paste')
        .attach('file', pngBytes(1280, 720), {
          filename: 'shot.png',
          contentType: 'image/png',
        });

      expect(response.status).toBe(201);
      expect(response.body).toEqual(attachment);
      const [dp, actor, runId, itemId, file, fields] = service.add.mock
        .calls[0] as [
        string,
        { userId: string; userLogin: string },
        string,
        string,
        { buffer: Buffer; size: number },
        unknown,
      ];
      expect([dp, runId, itemId]).toEqual(['dp-1', 'run-1', 'ri-1']);
      expect(actor).toMatchObject({ userId: 'qa-1', userLogin: 'qa' });
      expect(file.buffer.equals(pngBytes(1280, 720))).toBe(true);
      expect(fields).toEqual({
        kind: 'evidence',
        source: 'paste',
        caption: 'Receipt',
      });
    });

    it('defaults source to upload and caption to null', async () => {
      service.add.mockResolvedValue(attachment);

      await request(http())
        .post(`${BASE}/items/ri-1/attachments`)
        .attach('file', pngBytes(10, 10), 'shot.png');

      expect(service.add.mock.calls[0]?.[5]).toEqual({
        kind: 'evidence',
        source: 'upload',
        caption: null,
      });
    });

    it('rejects kind=fix_proof with 400 QA_ATTACHMENT_KIND before calling the service', async () => {
      const response = await request(http())
        .post(`${BASE}/items/ri-1/attachments`)
        .field('kind', 'fix_proof')
        .attach('file', pngBytes(10, 10), 'shot.png');

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ code: 'QA_ATTACHMENT_KIND' });
      expect(service.add).not.toHaveBeenCalled();
    });

    it('answers a file over 3 MB with 413 and the coded QA_ATTACHMENT_TOO_LARGE body', async () => {
      const response = await request(http())
        .post(`${BASE}/items/ri-1/attachments`)
        .attach('file', Buffer.alloc(3 * 1024 * 1024 + 2048), 'big.png');

      expect(response.status).toBe(413);
      expect(response.body).toMatchObject({ code: 'QA_ATTACHMENT_TOO_LARGE' });
      expect(service.add).not.toHaveBeenCalled();
    });

    it('hands a missing file to the service (which answers 400)', async () => {
      service.add.mockResolvedValue(attachment);

      await request(http())
        .post(`${BASE}/items/ri-1/attachments`)
        .field('caption', 'no file');

      expect(service.add.mock.calls[0]?.[4]).toBeUndefined();
    });
  });

  it('GET items/:itemId/attachments lists one item', async () => {
    service.listForItem.mockResolvedValue({ items: [attachment] });

    const response = await request(http()).get(
      `${BASE}/items/ri-1/attachments`,
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ items: [attachment] });
    expect(service.listForItem).toHaveBeenCalledWith(
      'dp-1',
      expect.objectContaining({ userId: 'qa-1' }),
      'run-1',
      'ri-1',
    );
  });

  it('GET attachments lists the whole run', async () => {
    service.listForRun.mockResolvedValue({ items: [attachment] });

    const response = await request(http()).get(`${BASE}/attachments`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ items: [attachment] });
    expect(service.listForRun).toHaveBeenCalledWith(
      'dp-1',
      expect.objectContaining({ userId: 'qa-1' }),
      'run-1',
    );
  });

  it('DELETE attachments/:attachmentId answers 204 with no body', async () => {
    service.remove.mockResolvedValue(undefined);

    const response = await request(http()).delete(`${BASE}/attachments/att-1`);

    expect(response.status).toBe(204);
    expect(response.text).toBe('');
    expect(service.remove).toHaveBeenCalledWith(
      'dp-1',
      expect.objectContaining({ userId: 'qa-1' }),
      'run-1',
      'att-1',
    );
  });
});
