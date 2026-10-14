import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';

import type { VisualRegressionRepository } from '../infrastructure/visual-regression.repository';
import type {
  VisualResultFileFieldsDto,
  VisualSummaryBodyDto,
} from '../api/dto/visual.dto';
import { VisualRegressionService } from './visual-regression.service';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('data'),
]);

const meta = (
  branch: string,
  name: string,
  sha256 = `sha-${branch}-${name}`,
) => ({
  branch,
  name,
  sha256,
  approvedByLogin: 'dev1',
  approvedAt: '2026-10-01T00:00:00.000Z',
});

const makeRepo = () =>
  ({
    listBaselineMeta: jest.fn().mockResolvedValue([]),
    getBaselinePng: jest.fn().mockResolvedValue(null),
    replaceSnapshots: jest.fn().mockResolvedValue(true),
    pruneRuns: jest.fn().mockResolvedValue(undefined),
    countRunNames: jest.fn().mockResolvedValue({ total: 0, present: false }),
    upsertImage: jest.fn().mockResolvedValue(undefined),
    findRunHeader: jest.fn().mockResolvedValue(null),
    listRunSnapshots: jest.fn().mockResolvedValue([]),
    getRunImagePng: jest.fn().mockResolvedValue(null),
    promoteActualsToBaselines: jest.fn().mockResolvedValue([]),
  }) as unknown as jest.Mocked<VisualRegressionRepository>;

describe('VisualRegressionService', () => {
  let repo: jest.Mocked<VisualRegressionRepository>;
  let service: VisualRegressionService;

  beforeEach(() => {
    repo = makeRepo();
    service = new VisualRegressionService(repo);
  });

  describe('baselines for the pipeline', () => {
    it('lists a branch own baselines with a url naming that branch', async () => {
      repo.listBaselineMeta.mockResolvedValue([
        meta('uat', 'a b.png'.replace(' ', '-')),
      ]);

      const result = await service.listBaselinesForPipeline('o/r', 'uat');

      expect(repo.listBaselineMeta).toHaveBeenCalledWith('o/r', ['uat']);
      expect(result.baselines).toEqual([
        {
          name: 'a-b.png',
          sha256: 'sha-uat-a-b.png',
          url: '/api/v1/ci/visual-baselines/file?repoFullName=o%2Fr&branch=uat&name=a-b.png',
        },
      ]);
    });

    it('main falls back to uat per name, marked inheritedFrom', async () => {
      repo.listBaselineMeta.mockResolvedValue([
        meta('main', 'own.png'),
        meta('uat', 'own.png'),
        meta('uat', 'only-uat.png'),
      ]);

      const { baselines } = await service.listBaselinesForPipeline(
        'o/r',
        'main',
      );

      expect(repo.listBaselineMeta).toHaveBeenCalledWith('o/r', [
        'main',
        'uat',
      ]);
      expect(baselines.map((b) => [b.name, b.sha256, b.inheritedFrom])).toEqual(
        [
          ['only-uat.png', 'sha-uat-only-uat.png', 'uat'],
          ['own.png', 'sha-main-own.png', undefined],
        ],
      );
      expect(baselines[0]?.url).toContain('branch=main');
    });

    it('other branches never inherit', async () => {
      await service.listBaselinesForPipeline('o/r', 'dev');
      expect(repo.listBaselineMeta).toHaveBeenCalledWith('o/r', ['dev']);
    });

    it('serves the main baseline, else uat, else 404', async () => {
      repo.getBaselinePng
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(PNG);
      await expect(
        service.readBaselineForPipeline('o/r', 'main', 'a.png'),
      ).resolves.toBe(PNG);
      expect(repo.getBaselinePng.mock.calls.map((c) => c[1])).toEqual([
        'main',
        'uat',
      ]);

      repo.getBaselinePng.mockResolvedValue(null);
      await expect(
        service.readBaselineForPipeline('o/r', 'uat', 'a.png'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('summary ingestion', () => {
    const body = (
      snapshots: VisualSummaryBodyDto['snapshots'],
    ): VisualSummaryBodyDto =>
      ({
        repoFullName: 'o/r',
        branch: 'uat',
        commitSha: 'abcdef1',
        runId: 7,
        runAttempt: 2,
        browser: 'chromium',
        snapshots,
      }) as VisualSummaryBodyDto;

    it('stores the snapshots and prunes to the retention window', async () => {
      await expect(
        service.ingestSummary('o/r', body([{ name: 'a.png', status: 'new' }])),
      ).resolves.toEqual({ received: true });
      expect(repo.replaceSnapshots).toHaveBeenCalledWith(
        { repoFullName: 'o/r', branch: 'uat', runId: 7, browser: 'chromium' },
        'abcdef1',
        2,
        [{ name: 'a.png', status: 'new' }],
      );
      expect(repo.pruneRuns).toHaveBeenCalledWith('o/r', 'uat');
    });

    it('rejects a duplicated snapshot name', async () => {
      await expect(
        service.ingestSummary(
          'o/r',
          body([
            { name: 'a.png', status: 'new' },
            { name: 'a.png', status: 'passed' },
          ]),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.replaceSnapshots).not.toHaveBeenCalled();
    });
  });

  describe('file ingestion', () => {
    const fields = (
      overrides: Partial<VisualResultFileFieldsDto> = {},
    ): VisualResultFileFieldsDto => ({
      repoFullName: 'o/r',
      branch: 'uat',
      commitSha: 'abcdef1',
      runId: '7',
      browser: 'chromium',
      name: 'a.png',
      kind: 'actual',
      ...overrides,
    });

    it('stores a PNG with its hash and a numeric run id, then prunes', async () => {
      const result = await service.ingestFile('o/r', fields(), {
        buffer: PNG,
        size: PNG.length,
      });
      expect(result.received).toBe(true);
      expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(repo.upsertImage).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: 7,
          kind: 'actual',
          png: PNG,
          sha256: result.sha256,
        }),
      );
      expect(repo.pruneRuns).toHaveBeenCalledWith('o/r', 'uat');
    });

    it('requires a file', async () => {
      await expect(
        service.ingestFile('o/r', fields(), undefined),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects bytes that are not a PNG whatever the client declared', async () => {
      const gif = Buffer.from('GIF89a-not-a-png');
      await expect(
        service.ingestFile('o/r', fields(), { buffer: gif, size: gif.length }),
      ).rejects.toMatchObject({ response: { code: 'VISUAL_NOT_PNG' } });
      expect(repo.upsertImage).not.toHaveBeenCalled();
    });

    it('rejects a file over 3 MB', async () => {
      await expect(
        service.ingestFile('o/r', fields(), {
          buffer: PNG,
          size: 3 * 1024 * 1024 + 1,
        }),
      ).rejects.toBeInstanceOf(PayloadTooLargeException);
    });

    it('refuses a 61st snapshot name but allows re-upload of a known one', async () => {
      repo.countRunNames.mockResolvedValue({ total: 60, present: false });
      await expect(
        service.ingestFile('o/r', fields(), { buffer: PNG, size: PNG.length }),
      ).rejects.toMatchObject({
        response: { code: 'VISUAL_TOO_MANY_SNAPSHOTS' },
      });

      repo.countRunNames.mockResolvedValue({ total: 60, present: true });
      await expect(
        service.ingestFile('o/r', fields(), { buffer: PNG, size: PNG.length }),
      ).resolves.toMatchObject({ received: true });
    });
  });

  describe('latest run for the Visual tab', () => {
    it('returns null when nothing was reported', async () => {
      await expect(service.getRun('o/r', 'uat')).resolves.toBeNull();
    });

    it('resolves baselines (own, inherited, approved) per snapshot', async () => {
      repo.findRunHeader.mockResolvedValue({
        runId: 9,
        runAttempt: 1,
        commitSha: 'abc',
        browser: 'chromium',
        reportedAt: '2026-10-05T00:00:00.000Z',
      });
      repo.listRunSnapshots.mockResolvedValue([
        {
          name: 'a.png',
          status: 'passed',
          hasActual: false,
          hasDiff: false,
          actualSha256: null,
        },
        {
          name: 'b.png',
          status: 'changed',
          hasActual: true,
          hasDiff: true,
          actualSha256: 'new-b',
        },
        {
          name: 'c.png',
          status: 'new',
          hasActual: true,
          hasDiff: false,
          actualSha256: 'sha-main-c.png',
        },
      ]);
      repo.listBaselineMeta.mockResolvedValue([
        meta('uat', 'a.png'),
        meta('uat', 'b.png'),
        meta('main', 'c.png'),
      ]);

      const run = await service.getRun('o/r', 'main');

      expect(run).toMatchObject({
        runId: 9,
        browser: 'chromium',
        branch: 'main',
      });
      const [a, b, c] = run!.snapshots;
      expect(a?.baseline?.inheritedFrom).toBe('uat');
      expect(b).toMatchObject({ hasDiff: true, approved: false });
      expect(b?.baseline?.inheritedFrom).toBe('uat');
      expect(c).toMatchObject({ approved: true });
      expect(c?.baseline?.inheritedFrom).toBeNull();
    });
  });

  describe('images', () => {
    it('serves baselines with the main -> uat fallback', async () => {
      repo.getBaselinePng
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(PNG);
      await expect(
        service.readImage({
          repoFullName: 'o/r',
          branch: 'main',
          kind: 'baseline',
          name: 'a.png',
        }),
      ).resolves.toBe(PNG);
    });

    it('needs a run id for actual and diff, and reads the browser the tab shows', async () => {
      await expect(
        service.readImage({
          repoFullName: 'o/r',
          branch: 'uat',
          kind: 'actual',
          name: 'a.png',
        }),
      ).resolves.toBeNull();

      repo.findRunHeader.mockResolvedValue({
        runId: 9,
        runAttempt: 1,
        commitSha: 'a',
        browser: 'webkit',
        reportedAt: '',
      });
      repo.getRunImagePng.mockResolvedValue(PNG);
      await expect(
        service.readImage({
          repoFullName: 'o/r',
          branch: 'uat',
          kind: 'diff',
          name: 'a.png',
          runId: 9,
        }),
      ).resolves.toBe(PNG);
      expect(repo.getRunImagePng).toHaveBeenCalledWith(
        { repoFullName: 'o/r', branch: 'uat', runId: 9, browser: 'webkit' },
        'a.png',
        'diff',
      );
    });
  });

  describe('approve', () => {
    const header = {
      runId: 9,
      runAttempt: 1,
      commitSha: 'abc',
      browser: 'chromium',
      reportedAt: '',
    };
    const input = {
      repoFullName: 'o/r',
      branch: 'uat',
      runId: 9,
      names: ['b.png'],
      approvedByUserId: 'u1',
      approvedByLogin: 'dev1',
    };

    it('404s an unknown or aged-out run', async () => {
      await expect(service.approve(input)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('refuses a run that is not the latest, naming the latest', async () => {
      repo.findRunHeader
        .mockResolvedValueOnce(header)
        .mockResolvedValueOnce({ ...header, runId: 12 });
      const error = await service.approve(input).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({
        code: 'VISUAL_RUN_SUPERSEDED',
        latestRunId: 12,
      });
      expect(repo.promoteActualsToBaselines).not.toHaveBeenCalled();
    });

    it('promotes changed and new snapshots', async () => {
      repo.findRunHeader.mockResolvedValue(header);
      repo.listRunSnapshots.mockResolvedValue([
        {
          name: 'b.png',
          status: 'changed',
          hasActual: true,
          hasDiff: true,
          actualSha256: 'x',
        },
      ]);
      repo.promoteActualsToBaselines.mockResolvedValue(['b.png']);

      await expect(service.approve(input)).resolves.toEqual(['b.png']);
      expect(repo.promoteActualsToBaselines).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: 9,
          browser: 'chromium',
          names: ['b.png'],
          approvedByUserId: 'u1',
          approvedByLogin: 'dev1',
        }),
      );
    });

    it('refuses the whole batch, naming offenders: passed, unknown, or no image', async () => {
      repo.findRunHeader.mockResolvedValue(header);
      repo.listRunSnapshots.mockResolvedValue([
        {
          name: 'ok.png',
          status: 'changed',
          hasActual: true,
          hasDiff: false,
          actualSha256: 'x',
        },
        {
          name: 'pass.png',
          status: 'passed',
          hasActual: true,
          hasDiff: false,
          actualSha256: 'x',
        },
        {
          name: 'noimg.png',
          status: 'new',
          hasActual: false,
          hasDiff: false,
          actualSha256: null,
        },
      ]);

      const error = await service
        .approve({
          ...input,
          names: ['ok.png', 'pass.png', 'noimg.png', 'ghost.png'],
        })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({
        code: 'VISUAL_NOT_APPROVABLE',
        names: ['pass.png', 'noimg.png', 'ghost.png'],
      });
      expect(repo.promoteActualsToBaselines).not.toHaveBeenCalled();
    });

    it('conflicts when a concurrent change shrinks the promoted set', async () => {
      repo.findRunHeader.mockResolvedValue(header);
      repo.listRunSnapshots.mockResolvedValue([
        {
          name: 'a.png',
          status: 'new',
          hasActual: true,
          hasDiff: false,
          actualSha256: 'x',
        },
        {
          name: 'b.png',
          status: 'new',
          hasActual: true,
          hasDiff: false,
          actualSha256: 'y',
        },
      ]);
      repo.promoteActualsToBaselines.mockResolvedValue(['a.png']);
      await expect(
        service.approve({ ...input, names: ['a.png', 'b.png'] }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });
});
