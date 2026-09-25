import {
  BadRequestException,
  NotFoundException,
  StreamableFile,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import type { Request } from 'express';

import { ProjectQaRunsController } from './qa-runs.controller';
import { QaRunsService } from '../application/qa-runs/qa-runs.service';
import { QaReportService } from '../application/qa-runs/qa-report.service';
import { QA_REPORT_SCHEMA_VERSION } from '../application/qa-runs/qa-report.contracts';
import type { QaReport } from '../application/qa-runs/qa-report.contracts';
import type { QaRun } from '../application/qa-runs/qa-runs.contracts';

const fakeUser = { id: 'user-1', login: 'tone' };

const makeRequest = (user: typeof fakeUser | undefined = fakeUser) =>
  ({
    session: { user, userId: user?.id, githubAccessToken: 'token-1' },
  }) as unknown as Request;

const run = (overrides: Partial<QaRun> = {}): QaRun => ({
  id: 'run-1',
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
    reopen: jest.fn().mockResolvedValue(run()),
    listReturnedItems: jest.fn(),
  }) as unknown as QaRunsService;

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

describe('ProjectQaRunsController.reopen', () => {
  it('passes the full actor context (id + login), not just the user id', async () => {
    const runsService = makeRunsService();
    const controller = await compileController(
      runsService,
      makeReportService(),
    );

    await controller.reopen(makeRequest(), 'project-1', 'run-1');

    expect(runsService.reopen).toHaveBeenCalledWith(
      'project-1',
      { userId: 'user-1', userLogin: 'tone', oauthToken: 'token-1' },
      'run-1',
    );
  });
});
