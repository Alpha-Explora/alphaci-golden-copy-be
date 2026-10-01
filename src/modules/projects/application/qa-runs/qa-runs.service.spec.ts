import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';

import type { QaProjectRunsRepository } from '../../infrastructure/qa-project-runs.repository';
import type { QaRequirementsRepository } from '../../infrastructure/qa-requirements.repository';
import type {
  QaRunItemRow,
  QaRunsRepository,
  QaVerificationRunRow,
} from '../../infrastructure/qa-runs.repository';
import type { QaAccessService } from '../qa-checklists/qa-access.service';
import type { QaProjectContextService } from '../qa-checklists/qa-project-context.service';
import type { QaRequirementsService } from '../qa-checklists/qa-requirements.service';
import type { QaAutomationService } from './qa-automation.service';
import type { QaCommitResolutionService } from './qa-commit-resolution.service';
import type { QaProjectRunsService } from './qa-project-runs.service';
import { QaRunsService } from './qa-runs.service';

const actor = { userId: 'user-1', userLogin: 'dev', oauthToken: 'tok' };

const legacyRun = (): QaVerificationRunRow => ({
  id: 'run-1',
  scope: 'repository',
  delivery_project_id: null,
  heads_fingerprint: null,
  project_id: 'project-1',
  checklist_id: 'checklist-1',
  checklist_version: 1,
  checklist_name: 'Release checklist',
  branch: 'uat',
  commit_sha: 'a'.repeat(40),
  commit_source: 'branch_head',
  status: 'signed_off',
  created_by: 'qa-1',
  created_by_login: 'qa',
  created_at: '2026-09-25T00:00:00.000Z',
  updated_at: '2026-09-25T00:00:00.000Z',
});

const runItem = (overrides: Partial<QaRunItemRow> = {}): QaRunItemRow =>
  ({
    id: 'ri-1',
    run_id: 'run-1',
    source_item_id: 'item-1',
    prior_run_item_id: null,
    position: 0,
    title: 'Login works',
    description: null,
    target_persona: 'all',
    verification_type: 'manual',
    test_identifier: null,
    status: 'passed',
    notes: null,
    defect_severity: null,
    reproduction_steps: null,
    fix_requested_at: null,
    fix_requested_by: null,
    fix_requested_by_login: null,
    fix_note: null,
    verified_by: 'qa-1',
    verified_by_login: 'qa',
    verified_at: '2026-09-25T00:00:00.000Z',
    row_version: 2,
    updated_at: '2026-09-25T00:00:00.000Z',
    requirement_id: null,
    requirement_name: null,
    requirement_kind: null,
    acceptance_criteria: null,
    ...overrides,
  }) as QaRunItemRow;

function setup({ visible = true }: { visible?: boolean } = {}) {
  const repository = {
    listRunsForProject: jest.fn().mockResolvedValue([legacyRun()]),
    listItemsByRunIds: jest
      .fn()
      .mockResolvedValue(new Map([['run-1', [runItem()]]])),
    listItemsByRunId: jest.fn().mockResolvedValue([runItem()]),
    findActiveSignoffsByRunIds: jest.fn().mockResolvedValue(new Map()),
    findActiveSignoff: jest.fn().mockResolvedValue(null),
    findRunForProject: jest.fn().mockResolvedValue(legacyRun()),
    findRunByKey: jest.fn().mockResolvedValue(null),
    findPriorItemSummaries: jest.fn().mockResolvedValue(new Map()),
  } as unknown as jest.Mocked<QaRunsRepository>;
  const access = {
    findVisibleProject: jest
      .fn()
      .mockResolvedValue(visible ? { id: 'project-1' } : null),
    findAppRole: jest.fn().mockResolvedValue('member'),
  } as unknown as jest.Mocked<QaAccessService>;
  const automation = {
    forRun: jest.fn().mockResolvedValue({ verify: null, quality: null }),
  } as unknown as jest.Mocked<QaAutomationService>;
  const projectContext = {
    findProjectOfRepository: jest.fn().mockResolvedValue({
      deliveryProjectId: 'dp-1',
      groupId: 'group-1',
      name: 'Checkout',
      repositories: [],
    }),
  } as unknown as jest.Mocked<QaProjectContextService>;
  const projectRunsService = {
    myItems: jest.fn(),
    getById: jest.fn().mockResolvedValue({ id: 'prun-1', scope: 'project' }),
  } as unknown as jest.Mocked<QaProjectRunsService>;
  const projectRunsRepository = {
    findRunItemWithProjectRun: jest.fn().mockResolvedValue(null),
    listCoverageByRunIds: jest.fn().mockResolvedValue(new Map()),
  } as unknown as jest.Mocked<QaProjectRunsRepository>;
  const requirementsRepository = {
    findItem: jest.fn().mockResolvedValue({ row_version: 4 }),
  } as unknown as jest.Mocked<QaRequirementsRepository>;
  const requirementsService = {
    setProgress: jest.fn().mockResolvedValue({}),
  } as unknown as jest.Mocked<QaRequirementsService>;
  const service = new QaRunsService(
    repository,
    access,
    {} as QaCommitResolutionService,
    automation,
    projectContext,
    projectRunsService,
    projectRunsRepository,
    requirementsRepository,
    requirementsService,
  );
  return {
    service,
    repository,
    access,
    projectContext,
    projectRunsService,
    projectRunsRepository,
    requirementsService,
  };
}

describe('QaRunsService - repository-scope runs are read-only history', () => {
  it('lists runs flagged legacy, scope repository, and with every control off', async () => {
    const { service } = setup();

    const { items } = await service.listForProject('project-1', 'user-1', {
      branch: undefined,
      checklistId: undefined,
      limit: undefined,
    });
    expect(items[0]).toMatchObject({ scope: 'repository', legacy: true });

    const run = await service.getById('project-1', 'user-1', 'run-1');
    expect(run.permissions).toEqual({
      canUpdateItems: false,
      canReturnToDev: false,
      canRequestRetest: false,
      canSignOff: false,
      canReopen: false,
    });
    expect(run.items[0]?.canUpdate).toBe(false);
  });

  it('404s a project the caller cannot see, and a run that is not a repository run', async () => {
    await expect(
      setup({ visible: false }).service.getById('project-1', 'user-1', 'run-1'),
    ).rejects.toThrow(NotFoundException);

    const { service, repository } = setup();
    repository.findRunForProject.mockResolvedValue(null);
    await expect(
      service.getById('project-1', 'user-1', 'run-1'),
    ).rejects.toThrow(NotFoundException);
  });

  it('create answers QA_RUN_LEGACY_READONLY with a pointer to the Project runs', async () => {
    const { service } = setup();

    await expect(service.create('project-1', actor)).rejects.toMatchObject({
      response: {
        code: 'QA_RUN_LEGACY_READONLY',
        projectRunsUrl: '/delivery-projects/dp-1/qa-runs',
      },
    });
  });

  it('item write, sign-off, reopen and dispatch on a repository run answer QA_RUN_LEGACY_READONLY', async () => {
    const { service } = setup();

    await expect(
      service.refuseWrite('project-1', actor, 'run-1'),
    ).rejects.toMatchObject({ response: { code: 'QA_RUN_LEGACY_READONLY' } });
  });

  it('refuseWrite 404s an unknown run before refusing', async () => {
    const { service, repository } = setup();
    repository.findRunForProject.mockResolvedValue(null);

    await expect(
      service.refuseWrite('project-1', actor, 'missing'),
    ).rejects.toThrow(NotFoundException);
  });
});

describe('QaRunsService.requestRetest (alias)', () => {
  it('on a repository run: QA_RUN_LEGACY_READONLY', async () => {
    const { service } = setup();

    await expect(
      service.requestRetest('project-1', actor, 'run-1', 'ri-1', {}),
    ).rejects.toMatchObject({ response: { code: 'QA_RUN_LEGACY_READONLY' } });
  });

  it('on a Project run: sets the source item Progress to done and answers with the Project run', async () => {
    const { service, repository, projectRunsRepository, requirementsService } =
      setup();
    repository.findRunForProject.mockResolvedValue(null);
    projectRunsRepository.findRunItemWithProjectRun.mockResolvedValue({
      item: runItem({
        id: 'ri-9',
        run_id: 'prun-1',
        source_item_id: 'item-9',
        requirement_id: 'req-9',
      }),
      run: { id: 'prun-1', delivery_project_id: 'dp-1' },
    } as never);

    const result = await service.requestRetest(
      'project-1',
      actor,
      'prun-1',
      'ri-9',
      { note: 'fixed' },
    );

    expect(requirementsService.setProgress).toHaveBeenCalledWith(
      'req-9',
      'item-9',
      actor,
      { progress: 'done', expectedRowVersion: 4, note: 'fixed' },
    );
    expect(result).toMatchObject({ id: 'prun-1' });
  });

  it('refuses a Project run of a different Project, and a QA caller', async () => {
    const { service, repository, projectRunsRepository, access } = setup();
    repository.findRunForProject.mockResolvedValue(null);
    projectRunsRepository.findRunItemWithProjectRun.mockResolvedValue({
      item: runItem({ run_id: 'prun-1' }),
      run: { id: 'prun-1', delivery_project_id: 'dp-other' },
    } as never);
    await expect(
      service.requestRetest('project-1', actor, 'prun-1', 'ri-1', {}),
    ).rejects.toThrow(NotFoundException);

    projectRunsRepository.findRunItemWithProjectRun.mockResolvedValue({
      item: runItem({
        run_id: 'prun-1',
        requirement_id: 'r',
        source_item_id: 's',
      }),
      run: { id: 'prun-1', delivery_project_id: 'dp-1' },
    } as never);
    access.findAppRole.mockResolvedValue('qa');
    await expect(
      service.requestRetest('project-1', actor, 'prun-1', 'ri-1', {}),
    ).rejects.toThrow(ForbiddenException);
  });
});

describe('QaRunsService deprecated feeds', () => {
  const entry = (overrides: Record<string, unknown> = {}) => ({
    requirement: { id: 'req-1', name: 'Login', kind: 'functional' },
    item: {},
    runId: 'prun-1',
    runItem: runItem({ status: 'returned_to_dev' }),
    ...overrides,
  });

  it('derives returned and developerItems from the repository Project, skipping entries with no run item', async () => {
    const { service, projectRunsService, projectRunsRepository } = setup();
    projectRunsService.myItems.mockResolvedValue({
      returned: [entry()],
      inProgress: [entry({ runItem: runItem({ status: 'pending' }) })],
      todo: [entry({ runId: null, runItem: null })],
      readyForQa: [],
    } as never);
    projectRunsRepository.listCoverageByRunIds.mockResolvedValue(
      new Map([
        [
          'prun-1',
          [
            {
              run_id: 'prun-1',
              project_id: 'project-1',
              repo_full_name: 'acme/api',
              head_sha: 'd'.repeat(40),
            },
          ],
        ],
      ]),
    );

    const result = await service.listMyItems('project-1', actor);

    expect(projectRunsService.myItems).toHaveBeenCalledWith('dp-1', actor);
    expect(result.returned).toHaveLength(1);
    expect(result.returned[0]).toMatchObject({
      runId: 'prun-1',
      branch: 'uat',
      commitSha: 'd'.repeat(40),
      checklistName: 'Login',
    });
    expect(result.developerItems).toHaveLength(1);
  });

  it('is empty for a repository filed under no Project', async () => {
    const { service, projectContext, projectRunsService } = setup();
    projectContext.findProjectOfRepository.mockResolvedValue(null);

    const result = await service.listReturnedItems('project-1', actor);

    expect(result.items).toEqual([]);
    expect(projectRunsService.myItems).not.toHaveBeenCalled();
  });
});

describe('QaRunsService.current', () => {
  it('only supports the uat branch', async () => {
    const { service } = setup();

    await expect(
      service.current('project-1', actor, 'main', undefined),
    ).rejects.toThrow(BadRequestException);
  });
});
