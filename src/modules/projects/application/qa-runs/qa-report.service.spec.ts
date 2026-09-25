import { NotFoundException } from '@nestjs/common';

import type { ProvisionedProjectRow } from '../../infrastructure/projects.repository';
import type {
  QaRunSignoffRow,
  QaRunsRepository,
  QaVerificationRunRow,
} from '../../infrastructure/qa-runs.repository';
import type { QaAccessService } from '../qa-checklists/qa-access.service';
import type { QaRun } from './qa-runs.contracts';
import type { QaRunsService } from './qa-runs.service';
import { QaReportService } from './qa-report.service';

const projectRow = (
  overrides: Partial<ProvisionedProjectRow> = {},
): ProvisionedProjectRow => ({
  id: 'project-1',
  user_id: 'owner-1',
  repo_full_name: 'org/repo-name',
  template_id: 'be-nestjs',
  service_name: 'My Service',
  workflow_path: '.github/workflows/ci.yml',
  status: 'provisioned',
  github_commit_sha: null,
  github_commit_url: null,
  failure_reason: null,
  repo_url: null,
  visibility: null,
  repo_shape: null,
  project_type_id: null,
  workflow_recipe_id: null,
  project_options: null,
  workspace_id: 'workspace-1',
  is_example: false,
  created_at: '2026-09-25T00:00:00.000Z',
  updated_at: '2026-09-25T00:00:00.000Z',
  ...overrides,
});

const runRow = (
  overrides: Partial<QaVerificationRunRow> = {},
): QaVerificationRunRow => ({
  id: 'run-1',
  project_id: 'project-1',
  checklist_id: 'checklist-1',
  checklist_version: 1,
  checklist_name: 'Release checklist',
  branch: 'main',
  commit_sha: 'a'.repeat(40),
  commit_source: 'deployment',
  status: 'open',
  created_by: 'creator-1',
  created_by_login: 'creator-login',
  created_at: '2026-09-25T00:00:00.000Z',
  updated_at: '2026-09-25T00:00:00.000Z',
  ...overrides,
});

const frozenQaRun: QaRun = {
  id: 'run-1',
  projectId: 'project-1',
  checklistId: 'checklist-1',
  checklistName: 'Release checklist',
  checklistVersion: 1,
  branch: 'main',
  commitSha: 'a'.repeat(40),
  commitSource: 'deployment',
  status: 'signed_off',
  createdBy: { id: 'creator-1', login: 'creator-login' },
  createdAt: '2026-09-25T00:00:00.000Z',
  updatedAt: '2026-09-25T01:00:00.000Z',
  summary: {
    total: 1,
    byStatus: {
      pending: 0,
      in_progress: 0,
      passed: 1,
      failed: 0,
      blocked: 0,
      returned_to_dev: 0,
    },
    openDefects: 0,
    blockers: 0,
  },
  signoff: {
    id: 'signoff-1',
    verdict: 'APPROVED',
    summary: null,
    conditions: null,
    signedBy: { id: 'qa-1', login: 'qa-login' },
    signedAt: '2026-09-25T01:00:00.000Z',
  },
  items: [],
  permissions: {
    canUpdateItems: false,
    canReturnToDev: false,
    canRequestRetest: false,
    canSignOff: false,
    canReopen: true,
  },
  automation: { verify: null, quality: null },
};

const signoffRow = (
  overrides: Partial<QaRunSignoffRow> = {},
): QaRunSignoffRow => ({
  id: 'signoff-1',
  run_id: 'run-1',
  verdict: 'APPROVED',
  summary: null,
  conditions: null,
  signed_by: 'qa-1',
  signed_by_login: 'qa-login',
  signed_at: '2026-09-25T01:00:00.000Z',
  report_json: frozenQaRun as unknown as Record<string, unknown>,
  superseded_at: null,
  superseded_by: null,
  superseded_by_login: null,
  ...overrides,
});

const openQaRun: QaRun = {
  id: 'run-1',
  projectId: 'project-1',
  checklistId: 'checklist-1',
  checklistName: 'Release checklist',
  checklistVersion: 1,
  branch: 'main',
  commitSha: 'a'.repeat(40),
  commitSource: 'deployment',
  status: 'open',
  createdBy: { id: 'creator-1', login: 'creator-login' },
  createdAt: '2026-09-25T00:00:00.000Z',
  updatedAt: '2026-09-25T00:00:00.000Z',
  summary: {
    total: 1,
    byStatus: {
      pending: 1,
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
};

function makeAccess(
  overrides: Partial<jest.Mocked<QaAccessService>> = {},
): jest.Mocked<QaAccessService> {
  return {
    findVisibleProject: jest.fn().mockResolvedValue(projectRow()),
    ...overrides,
  } as unknown as jest.Mocked<QaAccessService>;
}

function makeRunsRepository(
  overrides: Partial<jest.Mocked<QaRunsRepository>> = {},
): jest.Mocked<QaRunsRepository> {
  return {
    findRunForProject: jest.fn().mockResolvedValue(runRow()),
    findActiveSignoff: jest.fn().mockResolvedValue(null),
    listSupersededSignoffs: jest.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as jest.Mocked<QaRunsRepository>;
}

function makeQaRunsService(
  overrides: Partial<jest.Mocked<QaRunsService>> = {},
): jest.Mocked<QaRunsService> {
  return {
    getById: jest.fn().mockResolvedValue(openQaRun),
    ...overrides,
  } as unknown as jest.Mocked<QaRunsService>;
}

describe('QaReportService.build', () => {
  it('404s when the project is not visible', async () => {
    const access = makeAccess({
      findVisibleProject: jest.fn().mockResolvedValue(null),
    });
    const service = new QaReportService(
      access,
      makeRunsRepository(),
      makeQaRunsService(),
    );

    await expect(service.build('project-1', 'user-1', 'run-1')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('404s when the run does not belong to the project', async () => {
    const runsRepository = makeRunsRepository({
      findRunForProject: jest.fn().mockResolvedValue(null),
    });
    const service = new QaReportService(
      makeAccess(),
      runsRepository,
      makeQaRunsService(),
    );

    await expect(service.build('project-1', 'user-1', 'run-1')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('a signed-off run uses EXACTLY the active signoff report_json, never rebuilt', async () => {
    const getById = jest.fn();
    const runsRepository = makeRunsRepository({
      findRunForProject: jest
        .fn()
        .mockResolvedValue(runRow({ status: 'signed_off' })),
      findActiveSignoff: jest.fn().mockResolvedValue(signoffRow()),
    });
    const service = new QaReportService(
      makeAccess(),
      runsRepository,
      makeQaRunsService({ getById }),
    );

    const report = await service.build('project-1', 'user-1', 'run-1');

    expect(report.frozen).toBe(true);
    expect(report.run).toBe(frozenQaRun);
    expect(getById).not.toHaveBeenCalled();
  });

  it('an open run is assembled live via QaRunsService.getById (the same assembly GET run uses)', async () => {
    const getById = jest.fn().mockResolvedValue(openQaRun);
    const runsRepository = makeRunsRepository({
      findRunForProject: jest
        .fn()
        .mockResolvedValue(runRow({ status: 'open' })),
    });
    const service = new QaReportService(
      makeAccess(),
      runsRepository,
      makeQaRunsService({ getById }),
    );

    const report = await service.build('project-1', 'user-1', 'run-1');

    expect(report.frozen).toBe(false);
    expect(report.run).toBe(openQaRun);
    expect(getById).toHaveBeenCalledWith('project-1', 'user-1', 'run-1');
  });

  it('falls back to the live assembly if a signed-off run has no active signoff row (benign race)', async () => {
    const getById = jest.fn().mockResolvedValue(openQaRun);
    const runsRepository = makeRunsRepository({
      findRunForProject: jest
        .fn()
        .mockResolvedValue(runRow({ status: 'signed_off' })),
      findActiveSignoff: jest.fn().mockResolvedValue(null),
    });
    const service = new QaReportService(
      makeAccess(),
      runsRepository,
      makeQaRunsService({ getById }),
    );

    const report = await service.build('project-1', 'user-1', 'run-1');

    expect(report.frozen).toBe(false);
    expect(getById).toHaveBeenCalled();
  });

  it("uses the project's service_name as the report name when present", async () => {
    const access = makeAccess({
      findVisibleProject: jest
        .fn()
        .mockResolvedValue(projectRow({ service_name: 'My Service' })),
    });
    const service = new QaReportService(
      access,
      makeRunsRepository(),
      makeQaRunsService(),
    );

    const report = await service.build('project-1', 'user-1', 'run-1');

    expect(report.project).toEqual({
      id: 'project-1',
      repoFullName: 'org/repo-name',
      name: 'My Service',
    });
  });

  it('falls back to the repo name when service_name is blank', async () => {
    const access = makeAccess({
      findVisibleProject: jest
        .fn()
        .mockResolvedValue(projectRow({ service_name: '   ' })),
    });
    const service = new QaReportService(
      access,
      makeRunsRepository(),
      makeQaRunsService(),
    );

    const report = await service.build('project-1', 'user-1', 'run-1');

    expect(report.project.name).toBe('repo-name');
  });

  it('maps every superseded signoff into signoffHistory', async () => {
    const superseded = signoffRow({
      id: 'signoff-old',
      verdict: 'REJECTED',
      superseded_at: '2026-09-24T00:00:00.000Z',
      superseded_by: 'lead-1',
      superseded_by_login: 'lead-login',
    });
    const runsRepository = makeRunsRepository({
      listSupersededSignoffs: jest.fn().mockResolvedValue([superseded]),
    });
    const service = new QaReportService(
      makeAccess(),
      runsRepository,
      makeQaRunsService(),
    );

    const report = await service.build('project-1', 'user-1', 'run-1');

    expect(report.signoffHistory).toEqual([
      {
        verdict: 'REJECTED',
        summary: null,
        conditions: null,
        signedBy: { id: 'qa-1', login: 'qa-login' },
        signedAt: '2026-09-25T01:00:00.000Z',
        supersededAt: '2026-09-24T00:00:00.000Z',
        supersededBy: { id: 'lead-1', login: 'lead-login' },
      },
    ]);
  });

  it('generatedAt is a fresh timestamp, not derived from the run', async () => {
    const before = Date.now();
    const service = new QaReportService(
      makeAccess(),
      makeRunsRepository(),
      makeQaRunsService(),
    );

    const report = await service.build('project-1', 'user-1', 'run-1');
    const after = Date.now();

    const generatedAtMs = new Date(report.generatedAt).getTime();
    expect(generatedAtMs).toBeGreaterThanOrEqual(before);
    expect(generatedAtMs).toBeLessThanOrEqual(after);
  });
});
