import 'reflect-metadata';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { CiVisualController } from './ci-visual.controller';
import { CiActiveTokenGuard } from './ci-bearer';
import {
  VisualResultFileFieldsDto,
  VisualSummaryBodyDto,
} from './dto/visual.dto';
import type { CiService } from '../application/ci.service';
import type { VisualRegressionService } from '../application/visual-regression.service';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('CiVisualController', () => {
  let ci: { validateRun: jest.Mock; assertActiveToken: jest.Mock };
  let visual: Record<string, jest.Mock>;
  let controller: CiVisualController;

  beforeEach(() => {
    ci = {
      validateRun: jest.fn().mockResolvedValue({ repoFullName: 'Owner/Repo' }),
      assertActiveToken: jest.fn().mockResolvedValue(undefined),
    };
    visual = {
      listBaselinesForPipeline: jest.fn().mockResolvedValue({ baselines: [] }),
      readBaselineForPipeline: jest.fn().mockResolvedValue(PNG),
      ingestSummary: jest.fn().mockResolvedValue({ received: true }),
      ingestFile: jest.fn().mockResolvedValue({ received: true, sha256: 'x' }),
    };
    controller = new CiVisualController(
      ci as unknown as CiService,
      visual as unknown as VisualRegressionService,
    );
  });

  it('authorizes like /ci/report (token + repo, stage verify) and stores under the canonical repo', async () => {
    await controller.listBaselines('Bearer aci_tok', {
      repoFullName: 'owner/repo',
      branch: 'uat',
    });
    expect(ci.validateRun).toHaveBeenCalledWith({
      token: 'aci_tok',
      repoFullName: 'owner/repo',
      stage: 'verify',
    });
    expect(visual.listBaselinesForPipeline).toHaveBeenCalledWith(
      'Owner/Repo',
      'uat',
    );
  });

  it('rejects a missing bearer on every route before touching data', async () => {
    await expect(
      controller.listBaselines(undefined, {
        repoFullName: 'a/b',
        branch: 'uat',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      controller.ingestSummary(undefined, {} as VisualSummaryBodyDto),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      controller.ingestFile(
        undefined,
        { repoFullName: 'a/b' } as VisualResultFileFieldsDto,
        undefined,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(visual.ingestSummary).not.toHaveBeenCalled();
    expect(visual.ingestFile).not.toHaveBeenCalled();
  });

  it('propagates a token that is not valid for the repository', async () => {
    ci.validateRun.mockRejectedValue(new ForbiddenException('nope'));
    await expect(
      controller.ingestSummary('Bearer t', {
        repoFullName: 'a/b',
      } as VisualSummaryBodyDto),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(visual.ingestSummary).not.toHaveBeenCalled();
  });

  it('serves the baseline as image/png with no caching', async () => {
    const res = { setHeader: jest.fn() };
    const file = await controller.getBaselineFile(
      'Bearer t',
      { repoFullName: 'a/b', branch: 'main', name: 'a.png' },
      res as never,
    );
    expect(res.setHeader).toHaveBeenCalledWith(
      'Cache-Control',
      'private, no-store',
    );
    expect(file.getHeaders().type).toBe('image/png');
  });

  it('hands the uploaded file to the service', async () => {
    const fields = { repoFullName: 'a/b' } as VisualResultFileFieldsDto;
    const upload = { buffer: PNG, size: PNG.length };
    await controller.ingestFile('Bearer t', fields, upload);
    expect(visual.ingestFile).toHaveBeenCalledWith(
      'Owner/Repo',
      fields,
      upload,
    );
  });

  describe('CiActiveTokenGuard (runs before the multipart body is buffered)', () => {
    const ctx = (authorization?: string) =>
      ({
        switchToHttp: () => ({
          getRequest: () => ({ headers: { authorization } }),
        }),
      }) as never;

    it('lets an active token through and refuses anonymous callers', async () => {
      const guard = new CiActiveTokenGuard(ci as unknown as CiService);
      await expect(guard.canActivate(ctx('Bearer aci_x'))).resolves.toBe(true);
      expect(ci.assertActiveToken).toHaveBeenCalledWith('aci_x');
      await expect(guard.canActivate(ctx())).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });
  });

  describe('wire validation (global pipe: whitelist + forbidNonWhitelisted)', () => {
    const opts = { whitelist: true, forbidNonWhitelisted: true };
    const summary = (overrides: Record<string, unknown> = {}) => ({
      repoFullName: 'o/r',
      branch: 'uat',
      commitSha: 'abcdef1234',
      runId: 12,
      runAttempt: 1,
      browser: 'chromium',
      snapshots: [{ name: 'home.png', status: 'changed' }],
      ...overrides,
    });
    const errors = (value: unknown) =>
      validate(plainToInstance(VisualSummaryBodyDto, value), opts);

    it('accepts the workflow payload (runId/runAttempt as numbers)', async () => {
      expect(await errors(summary())).toHaveLength(0);
    });

    it('rejects more than 60 snapshots, unsafe names and bad statuses', async () => {
      const many = Array.from({ length: 61 }, (_, i) => ({
        name: `s${String(i)}.png`,
        status: 'new',
      }));
      expect(await errors(summary({ snapshots: many }))).not.toHaveLength(0);
      expect(
        await errors(
          summary({ snapshots: [{ name: '../x.png', status: 'new' }] }),
        ),
      ).not.toHaveLength(0);
      expect(
        await errors(
          summary({ snapshots: [{ name: 'x.png', status: 'weird' }] }),
        ),
      ).not.toHaveLength(0);
      expect(await errors(summary({ extra: 1 }))).not.toHaveLength(0);
    });

    it('accepts multipart strings for the file fields and rejects unsafe ones', async () => {
      const fields = (o: Record<string, unknown> = {}) =>
        validate(
          plainToInstance(VisualResultFileFieldsDto, {
            repoFullName: 'o/r',
            branch: 'uat',
            commitSha: 'abcdef1',
            runId: '12',
            browser: 'chromium',
            name: 'home.png',
            kind: 'diff',
            ...o,
          }),
          opts,
        );
      expect(await fields()).toHaveLength(0);
      expect(await fields({ name: 'a/b.png' })).not.toHaveLength(0);
      expect(await fields({ name: 'a.jpg' })).not.toHaveLength(0);
      expect(await fields({ kind: 'baseline' })).not.toHaveLength(0);
      expect(await fields({ runId: '-1' })).not.toHaveLength(0);
    });
  });
});
