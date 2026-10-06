import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import type { Request } from 'express';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { ProjectVisualController } from './project-visual.controller';
import { ApproveVisualBaselinesDto } from './dto/approve-visual-baselines.dto';
import type { ProjectVisualService } from '../application/visual/project-visual.service';

const req = {
  session: { user: { id: 'u1', login: 'dev1' } },
} as unknown as Request;
const PNG = Buffer.from([0x89, 0x50]);

describe('ProjectVisualController', () => {
  let service: Record<string, jest.Mock>;
  let controller: ProjectVisualController;

  beforeEach(() => {
    service = {
      getLatest: jest.fn().mockResolvedValue({}),
      getImage: jest.fn().mockResolvedValue(PNG),
      approve: jest.fn().mockResolvedValue({ approved: [] }),
    };
    controller = new ProjectVisualController(
      service as unknown as ProjectVisualService,
    );
  });

  it('only accepts uat or main, and a numeric optional run id', () => {
    expect(() => controller.getVisual(req, 'p1', 'dev')).toThrow(
      BadRequestException,
    );
    expect(() => controller.getVisual(req, 'p1', undefined)).toThrow(
      BadRequestException,
    );
    expect(() => controller.getVisual(req, 'p1', 'uat', 'x1')).toThrow(
      BadRequestException,
    );
    void controller.getVisual(req, 'p1', 'main', '42');
    expect(service['getLatest']).toHaveBeenCalledWith('p1', 'u1', 'main', 42);
  });

  it('serves a PNG with a five-minute private cache', async () => {
    const res = { setHeader: jest.fn() };
    const file = await controller.getImage(
      req,
      'p1',
      res as never,
      'actual',
      'uat',
      '7',
      'a.png',
    );
    expect(res.setHeader).toHaveBeenCalledWith(
      'Cache-Control',
      'private, max-age=300',
    );
    expect(file.getHeaders().type).toBe('image/png');
  });

  it('validates kind, name and the run id that actual/diff need', async () => {
    const res = { setHeader: jest.fn() } as never;
    await expect(
      controller.getImage(req, 'p1', res, 'x', 'uat', '7', 'a.png'),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      controller.getImage(req, 'p1', res, 'actual', 'uat', '7', '../a.png'),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      controller.getImage(req, 'p1', res, 'diff', 'uat', undefined, 'a.png'),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      controller.getImage(
        req,
        'p1',
        res,
        'baseline',
        'uat',
        undefined,
        'a.png',
      ),
    ).resolves.toBeDefined();
  });

  it('passes the caller login to approve', async () => {
    const body = {
      branch: 'uat',
      runId: 1,
      names: ['a.png'],
    } as ApproveVisualBaselinesDto;
    await controller.approve(req, 'p1', body);
    expect(service['approve']).toHaveBeenCalledWith('p1', 'u1', 'dev1', body);
  });

  describe('ApproveVisualBaselinesDto', () => {
    const errors = (value: unknown) =>
      validate(plainToInstance(ApproveVisualBaselinesDto, value), {
        whitelist: true,
        forbidNonWhitelisted: true,
      });

    it('accepts a normal body', async () => {
      expect(
        await errors({ branch: 'uat', runId: 1, names: ['a.png'] }),
      ).toHaveLength(0);
    });

    it('rejects other branches, empty/duplicate/unsafe names', async () => {
      expect(
        await errors({ branch: 'dev', runId: 1, names: ['a.png'] }),
      ).not.toHaveLength(0);
      expect(
        await errors({ branch: 'uat', runId: 1, names: [] }),
      ).not.toHaveLength(0);
      expect(
        await errors({ branch: 'uat', runId: 1, names: ['a.png', 'a.png'] }),
      ).not.toHaveLength(0);
      expect(
        await errors({ branch: 'uat', runId: 1, names: ['../a.png'] }),
      ).not.toHaveLength(0);
    });
  });
});
