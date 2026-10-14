import 'reflect-metadata';
import {
  ForbiddenException,
  PayloadTooLargeException,
  UnauthorizedException,
} from '@nestjs/common';

import { CiPlaywrightProgressController } from './ci-playwright-progress.controller';
import type { PlaywrightProgressBodyDto } from './dto/playwright-progress.dto';
import type { CiService } from '../application/ci.service';
import type { PlaywrightLiveService } from '../application/playwright-live.service';

function makeBody(
  overrides: Partial<PlaywrightProgressBodyDto> = {},
): PlaywrightProgressBodyDto {
  return {
    repoFullName: 'owner/repo',
    branch: 'uat',
    runId: 1,
    runAttempt: 1,
    commitSha: 'a'.repeat(40),
    events: [{ type: 'run_started', at: '2026-10-08T10:00:00.000Z', total: 1 }],
    ...overrides,
  } as PlaywrightProgressBodyDto;
}

describe('CiPlaywrightProgressController', () => {
  let ci: { validateRun: jest.Mock };
  let live: { ingest: jest.Mock };
  let controller: CiPlaywrightProgressController;

  beforeEach(() => {
    ci = {
      validateRun: jest.fn().mockResolvedValue({ repoFullName: 'Owner/Repo' }),
    };
    live = { ingest: jest.fn().mockResolvedValue({ accepted: 1 }) };
    controller = new CiPlaywrightProgressController(
      ci as unknown as CiService,
      live as unknown as PlaywrightLiveService,
    );
  });

  it('authorizes like the visual calls (bearer token + repo, stage verify) and stores under the canonical repo', async () => {
    const body = makeBody();
    await expect(controller.ingest('Bearer aci_tok', body)).resolves.toEqual({
      accepted: 1,
    });
    expect(ci.validateRun).toHaveBeenCalledWith({
      token: 'aci_tok',
      repoFullName: 'owner/repo',
      stage: 'verify',
    });
    expect(live.ingest).toHaveBeenCalledWith('Owner/Repo', body);
  });

  it('answers 202', () => {
    const status = Reflect.getMetadata(
      '__httpCode__',
      CiPlaywrightProgressController.prototype.ingest,
    ) as number;
    expect(status).toBe(202);
  });

  it('is a 403 when the token belongs to another project than the repo named', async () => {
    ci.validateRun.mockRejectedValue(
      new ForbiddenException('CI token is not authorized for this repository'),
    );
    await expect(
      controller.ingest('Bearer aci_tok', makeBody({ repoFullName: 'x/y' })),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(live.ingest).not.toHaveBeenCalled();
  });

  it('is a 401 without a bearer, before any lookup', async () => {
    await expect(
      controller.ingest(undefined, makeBody()),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(ci.validateRun).not.toHaveBeenCalled();
  });

  it('is a 413 above 256 KB, after authorization, without storing', async () => {
    const big = makeBody({
      events: Array.from({ length: 200 }, () => ({
        type: 'test_finished' as const,
        at: '2026-10-08T10:00:00.000Z',
        test: {
          id: 'i'.repeat(300),
          file: 'f'.repeat(300),
          title: 't'.repeat(300),
          project: 'chromium',
          status: 'failed' as const,
          durationMs: 1,
          error: 'e'.repeat(1000),
        },
      })),
    });
    await expect(
      controller.ingest('Bearer aci_tok', big),
    ).rejects.toBeInstanceOf(PayloadTooLargeException);
    expect(ci.validateRun).toHaveBeenCalled();
    expect(live.ingest).not.toHaveBeenCalled();
  });
});
