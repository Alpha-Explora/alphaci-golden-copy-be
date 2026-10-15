import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  StreamableFile,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import type { Request } from 'express';

import {
  ProjectQaMyItemsController,
  ProjectQaPromotionController,
  ProjectQaRunsController,
} from './qa-runs.controller';
import { QaRunsService } from '../application/qa-runs/qa-runs.service';
import { QaPromotionService } from '../application/qa-runs/qa-promotion.service';
import { DeliveryProjectPromotionController } from './qa-runs.controller';
import { QaReportService } from '../application/qa-runs/qa-report.service';
import { QA_REPORT_SCHEMA_VERSION } from '../application/qa-runs/qa-report.contracts';
import type { QaReport } from '../application/qa-runs/qa-report.contracts';
import type { QaRun } from '../application/qa-runs/qa-runs.contracts';
import type { QaPromotionStatus } from '../application/qa-runs/qa-promotion.contracts';

const fakeUser = { id: 'user-1', login: 'tone' };

const makeRequest = (user: typeof fakeUser | undefined = fakeUser) =>
  ({
    session: { user, userId: user?.id, githubAccessToken: 'token-1' },
  }) as unknown as Request;

const run = (overrides: Partial<QaRun> = {}): QaRun => ({
  id: 'run-1',
  scope: 'repository' as const,
  legacy: true as const,
  projectId: 'project-1',
  checklistId: 'checklist-1',
  checklistName: 'Release checklist',
  checklistVersion: 1,
  branch: 'main',
  commitSha: 'abcdef01234567890123456789012345678901',
  commitSource: 'deployment',
  status: 'open',
  createdBy: { id: 'creator-1', login: 'creator' },
  createdAt: '2026-09-25T00:00:00.000Z',
  updatedAt: '2026-09-25T00:00:00.000Z',
  summary: {
    total: 0,
    byStatus: {
      pending: 0,
      in_progress: 0,
      passed: 0,
      failed: 0,
      blocked: 0,
      returned_to_dev: 0,
    },
    openDefects: 0,
    blockers: 0,
  },
  signoff: null,
  items: [],
  permissions: {
    canUpdateItems: true,
    canReturnToDev: true,
    canRequestRetest: true,
    canSignOff: true,
    canReopen: false,
  },
  automation: { verify: null, quality: null },
  ...overrides,
});

const reportFixture = (overrides: Partial<QaReport> = {}): QaReport => ({
  schemaVersion: QA_REPORT_SCHEMA_VERSION,
  generatedAt: '2026-09-25T06:00:00.000Z',
  frozen: false,
  project: {
    id: 'project-1',
    repoFullName: 'Alpha-Explora/alphaci-golden-copy-be',
    name: 'alphaci-golden-copy-be',
  },
  run: run(),
  summary: {
    totalItems: 0,
    passed: 0,
    failed: 0,
    blocked: 0,
    returnedToDev: 0,
    pending: 0,
    inProgress: 0,
    completionRate: 0,
    openDefects: 0,
    blockers: 0,
    verdict: null,
  },
  defects: [],
  automatedResults: null,
  signoffHistory: [],
  ...overrides,
});

// The controller always constructs StreamableFile from a Buffer, so the
// stream only ever yields Buffer chunks; the explicit cast (rather than
// `Buffer.from(chunk)` on an implicit `any`) keeps this typesafe.
async function readStreamable(file: StreamableFile): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of file.getStream()) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const makeRunsService = () =>
  ({
    listForProject: jest.fn(),
    current: jest.fn(),
    create: jest.fn(),
    getById: jest.fn(),
    updateItem: jest.fn(),
    requestRetest: jest.fn(),
    signoff: jest.fn(),
    refuseWrite: jest.fn().mockRejectedValue(new ConflictException('refused')),
    listReturnedItems: jest.fn(),
    listMyItems: jest.fn(),
  }) as unknown as QaRunsService;

const promotionStatusFixture = (
  overrides: Partial<QaPromotionStatus> = {},
): QaPromotionStatus => ({
  qaBranch: 'uat',
  targetBranch: 'main',
  headSha: 'a'.repeat(40),
  scope: 'project',
  deliveryProject: null,
  run: null,
  repositories: [],
  requirementsChanged: false,
  checklists: [],
  eligible: false,
  reasons: ['No QA checklist is shared to this project'],
  repositoryDelivered: false,
  iterationDelivered: false,
  iteration: null,
  reasonCodes: [],
  pullRequest: null,
  canMerge: false,
  ...overrides,
});

const makePromotionService = (
  overrides: Partial<jest.Mocked<QaPromotionService>> = {},
) =>
  ({
    getStatus: jest.fn().mockResolvedValue(promotionStatusFixture()),
    merge: jest.fn(),
    ...overrides,
  }) as unknown as jest.Mocked<QaPromotionService>;

const makeReportService = (
  overrides: Partial<jest.Mocked<QaReportService>> = {},
) =>
  ({
    build: jest.fn().mockResolvedValue(reportFixture()),
    ...overrides,
  }) as unknown as jest.Mocked<QaReportService>;

async function compileController(
  runsService: QaRunsService,
  reportService: QaReportService,
) {
  const module: TestingModule = await Test.createTestingModule({
    controllers: [ProjectQaRunsController],
    providers: [
      { provide: QaRunsService, useValue: runsService },
      { provide: QaReportService, useValue: reportService },
    ],
  })
    .overrideGuard(
      require('#kernel/auth/session-auth.guard.js').SessionAuthGuard,
    )
    .useValue({ canActivate: () => true })
    .overrideGuard(require('#kernel/composition/index.js').CapabilityGuard)
    .useValue({ canActivate: () => true })
    .compile();
  return module.get(ProjectQaRunsController);
}

describe('ProjectQaRunsController.report', () => {
  it('defaults to format=json, setting Content-Type and an attachment filename', async () => {
    const reportService = makeReportService();
    const controller = await compileController(
      makeRunsService(),
      reportService,
    );

    const file = await controller.report(
      makeRequest(),
      'project-1',
      'run-1',
      undefined,
    );

    expect(reportService.build).toHaveBeenCalledWith(
      'project-1',
      'user-1',
      'run-1',
    );
    const headers = file.getHeaders();
    expect(headers.type).toBe('application/json; charset=utf-8');
    expect(headers.disposition).toBe(
      'attachment; filename="QA-Report-alphaci-golden-copy-be-main-abcdef0.json"',
    );

    const body = JSON.parse(await readStreamable(file)) as QaReport;
    expect(body.schemaVersion).toBe(QA_REPORT_SCHEMA_VERSION);
  });

  it('format=json is equivalent to the default', async () => {
    const controller = await compileController(
      makeRunsService(),
      makeReportService(),
    );
    const file = await controller.report(
      makeRequest(),
      'project-1',
      'run-1',
      'json',
    );
    expect(file.getHeaders().type).toBe('application/json; charset=utf-8');
  });

  it('streams Markdown for format=md, with the .md filename and a rendered heading', async () => {
    const controller = await compileController(
      makeRunsService(),
      makeReportService(),
    );

    const file = await controller.report(
      makeRequest(),
      'project-1',
      'run-1',
      'md',
    );

    const headers = file.getHeaders();
    expect(headers.type).toBe('text/markdown; charset=utf-8');
    expect(headers.disposition).toBe(
      'attachment; filename="QA-Report-alphaci-golden-copy-be-main-abcdef0.md"',
    );
    const body = await readStreamable(file);
    expect(body).toContain(
      '# QA report — Alpha-Explora/alphaci-golden-copy-be',
    );
  });

  it('400s on an unsupported format without calling the report service', async () => {
    const reportService = makeReportService();
    const controller = await compileController(
      makeRunsService(),
      reportService,
    );

    await expect(
      controller.report(makeRequest(), 'project-1', 'run-1', 'xml'),
    ).rejects.toThrow(BadRequestException);
    expect(reportService.build).not.toHaveBeenCalled();
  });

  it('sanitises a branch name with disallowed characters into the filename', async () => {
    const reportService = makeReportService({
      build: jest
        .fn()
        .mockResolvedValue(
          reportFixture({ run: run({ branch: 'feature/odd branch!' }) }),
        ),
    });
    const controller = await compileController(
      makeRunsService(),
      reportService,
    );

    const file = await controller.report(
      makeRequest(),
      'project-1',
      'run-1',
      'json',
    );

    expect(file.getHeaders().disposition).toBe(
      'attachment; filename="QA-Report-alphaci-golden-copy-be-feature-odd-branch-abcdef0.json"',
    );
  });

  it('propagates a 404 when the project or run is not visible', async () => {
    const reportService = makeReportService({
      build: jest
        .fn()
        .mockRejectedValue(new NotFoundException('QA run not found')),
    });
    const controller = await compileController(
      makeRunsService(),
      reportService,
    );

    await expect(
      controller.report(makeRequest(), 'project-1', 'missing-run', 'json'),
    ).rejects.toThrow(NotFoundException);
  });
});

describe('ProjectQaRunsController - repository-scope runs are read-only history', () => {
  it('refuses reopen, sign-off, item writes and dispatch through refuseWrite with the full actor context', async () => {
    const runsService = makeRunsService();
    const controller = await compileController(
      runsService,
      makeReportService(),
    );
    const actor = {
      userId: 'user-1',
      userLogin: 'tone',
      oauthToken: 'token-1',
    };

    await expect(
      controller.reopen(makeRequest(), 'project-1', 'run-1'),
    ).rejects.toThrow(ConflictException);
    await expect(
      controller.signoff(makeRequest(), 'project-1', 'run-1'),
    ).rejects.toThrow(ConflictException);
    await expect(
      controller.updateItem(makeRequest(), 'project-1', 'run-1'),
    ).rejects.toThrow(ConflictException);
    await expect(
      controller.dispatchAutomation(makeRequest(), 'project-1', 'run-1'),
    ).rejects.toThrow(ConflictException);

    expect(runsService.refuseWrite).toHaveBeenCalledTimes(4);
    expect(runsService.refuseWrite).toHaveBeenCalledWith(
      'project-1',
      actor,
      'run-1',
    );
  });

  it('refuses creating a repository-scope run', async () => {
    const runsService = makeRunsService();
    (runsService.create as jest.Mock).mockRejectedValue(
      new ConflictException('refused'),
    );
    const controller = await compileController(
      runsService,
      makeReportService(),
    );

    await expect(controller.create(makeRequest(), 'project-1')).rejects.toThrow(
      ConflictException,
    );
  });
});

async function compileMyItemsController(runsService: QaRunsService) {
  const module: TestingModule = await Test.createTestingModule({
    controllers: [ProjectQaMyItemsController],
    providers: [{ provide: QaRunsService, useValue: runsService }],
  })
    .overrideGuard(
      require('#kernel/auth/session-auth.guard.js').SessionAuthGuard,
    )
    .useValue({ canActivate: () => true })
    .overrideGuard(require('#kernel/composition/index.js').CapabilityGuard)
    .useValue({ canActivate: () => true })
    .compile();
  return module.get(ProjectQaMyItemsController);
}

describe('ProjectQaMyItemsController.list', () => {
  it('delegates to QaRunsService.listMyItems with the caller id', async () => {
    const runsService = makeRunsService();
    (runsService.listMyItems as jest.Mock).mockResolvedValue({
      returned: [],
      developerItems: [],
    });
    const controller = await compileMyItemsController(runsService);

    const result = await controller.list(makeRequest(), 'project-1');

    expect(runsService.listMyItems).toHaveBeenCalledWith('project-1', {
      userId: 'user-1',
      userLogin: 'tone',
      oauthToken: 'token-1',
    });
    expect(result).toEqual({ returned: [], developerItems: [] });
  });
});

async function compilePromotionController(
  promotionService: QaPromotionService,
) {
  const module: TestingModule = await Test.createTestingModule({
    controllers: [ProjectQaPromotionController],
    providers: [{ provide: QaPromotionService, useValue: promotionService }],
  })
    .overrideGuard(
      require('#kernel/auth/session-auth.guard.js').SessionAuthGuard,
    )
    .useValue({ canActivate: () => true })
    .overrideGuard(require('#kernel/composition/index.js').CapabilityGuard)
    .useValue({ canActivate: () => true })
    .compile();
  return module.get(ProjectQaPromotionController);
}

describe('ProjectQaPromotionController.status', () => {
  it('passes the full actor context and returns the service result verbatim', async () => {
    const status = promotionStatusFixture({ eligible: true, canMerge: true });
    const promotionService = makePromotionService({
      getStatus: jest.fn().mockResolvedValue(status),
    });
    const controller = await compilePromotionController(promotionService);

    const result = await controller.status(makeRequest(), 'project-1');

    expect(promotionService.getStatus).toHaveBeenCalledWith('project-1', {
      userId: 'user-1',
      userLogin: 'tone',
      oauthToken: 'token-1',
    });
    expect(result).toBe(status);
  });
});

describe('ProjectQaPromotionController.merge', () => {
  it('passes the full actor context and returns the merge result verbatim', async () => {
    const promotionService = makePromotionService({
      merge: jest.fn().mockResolvedValue({
        merged: true,
        sha: 'merged-sha',
        message: 'Merged.',
        pullRequest: { number: 42, url: 'https://github.com/org/repo/pull/42' },
      }),
    });
    const controller = await compilePromotionController(promotionService);

    const result = await controller.merge(makeRequest(), 'project-1');

    expect(promotionService.merge).toHaveBeenCalledWith('project-1', {
      userId: 'user-1',
      userLogin: 'tone',
      oauthToken: 'token-1',
    });
    expect(result).toEqual({
      merged: true,
      sha: 'merged-sha',
      message: 'Merged.',
      pullRequest: { number: 42, url: 'https://github.com/org/repo/pull/42' },
    });
  });

  it('propagates a 403 for a caller who is not lead|admin', async () => {
    const promotionService = makePromotionService({
      merge: jest.fn().mockRejectedValue(new ForbiddenException()),
    });
    const controller = await compilePromotionController(promotionService);

    await expect(controller.merge(makeRequest(), 'project-1')).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('propagates a 409 QA_PROMOTION_BLOCKED unchanged', async () => {
    const promotionService = makePromotionService({
      merge: jest.fn().mockRejectedValue(
        new ConflictException({
          code: 'QA_PROMOTION_BLOCKED',
          message: 'QA promotion is not eligible yet.',
          reasons: ['No QA checklist is shared to this project'],
        }),
      ),
    });
    const controller = await compilePromotionController(promotionService);

    await expect(controller.merge(makeRequest(), 'project-1')).rejects.toThrow(
      ConflictException,
    );
  });
});

describe('DeliveryProjectPromotionController.mergeAll', () => {
  it('passes the full actor context and returns the result verbatim', async () => {
    const result = {
      repositories: [
        {
          projectId: 'p-api',
          repoFullName: 'acme/api',
          merged: true,
          how: 'merged',
          message: null,
        },
      ],
      delivered: true,
      iteration: { id: 'it-1', number: 1, status: 'delivered' },
    };
    const promotionService = makePromotionService({
      mergeAll: jest.fn().mockResolvedValue(result),
    });
    const module: TestingModule = await Test.createTestingModule({
      controllers: [DeliveryProjectPromotionController],
      providers: [{ provide: QaPromotionService, useValue: promotionService }],
    })
      .overrideGuard(
        require('#kernel/auth/session-auth.guard.js').SessionAuthGuard,
      )
      .useValue({ canActivate: () => true })
      .overrideGuard(require('#kernel/composition/index.js').CapabilityGuard)
      .useValue({ canActivate: () => true })
      .compile();
    const controller = module.get(DeliveryProjectPromotionController);

    const answer = await controller.mergeAll(makeRequest(), 'dp-1');

    expect(promotionService.mergeAll).toHaveBeenCalledWith('dp-1', {
      userId: 'user-1',
      userLogin: 'tone',
      oauthToken: 'token-1',
    });
    expect(answer).toBe(result);
  });
});
