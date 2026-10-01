import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';

import type { PlatformAppRole } from '#kernel/ports/platform-admin.port';
import type {
  QaChecklistItemRow,
  QaChecklistRow,
  QaChecklistsRepository,
} from '../../infrastructure/qa-checklists.repository';
import type { ProvisionedProjectRow } from '../../infrastructure/projects.repository';
import {
  QaRunItemsChangedError,
  QaRunNotOpenError,
} from '../../infrastructure/qa-runs.repository';
import type {
  QaRunItemRow,
  QaRunSignoffRow,
  QaRunsRepository,
  QaVerificationRunRow,
} from '../../infrastructure/qa-runs.repository';
import type { QaAccessService } from '../qa-checklists/qa-access.service';
import type { QaAutomationService } from './qa-automation.service';
import type { QaCommitResolutionService } from './qa-commit-resolution.service';
import { QaRunsService, type QaRunActorContext } from './qa-runs.service';

const runRow = (
  overrides: Partial<QaVerificationRunRow> = {},
): QaVerificationRunRow => ({
  id: 'run-1',
  project_id: 'project-1',
  checklist_id: 'checklist-1',
  checklist_version: 1,
  checklist_name: 'Release checklist',
  branch: 'uat',
  commit_sha: 'a'.repeat(40),
  commit_source: 'deployment',
  status: 'open',
  created_by: 'creator-1',
  created_by_login: 'creator-login',
  created_at: '2026-09-25T00:00:00.000Z',
  updated_at: '2026-09-25T00:00:00.000Z',
  ...overrides,
});

const itemRow = (overrides: Partial<QaRunItemRow> = {}): QaRunItemRow => ({
  id: 'item-1',
  run_id: 'run-1',
  source_item_id: 'source-item-1',
  prior_run_item_id: null,
  position: 0,
  title: 'Smoke test login',
  description: null,
  target_persona: 'all',
  verification_type: 'manual',
  test_identifier: null,
  status: 'pending',
  notes: null,
  defect_severity: null,
  reproduction_steps: null,
  fix_requested_at: null,
  fix_requested_by: null,
  fix_requested_by_login: null,
  fix_note: null,
  verified_by: null,
  verified_by_login: null,
  verified_at: null,
  row_version: 1,
  updated_at: '2026-09-25T00:00:00.000Z',
  ...overrides,
});

const signoffRow = (
  overrides: Partial<QaRunSignoffRow> = {},
): QaRunSignoffRow => ({
  id: 'signoff-1',
  run_id: 'run-1',
  verdict: 'APPROVED',
  summary: null,
  conditions: null,
  signed_by: 'actor-1',
  signed_by_login: 'actor-login',
  signed_at: '2026-09-25T01:00:00.000Z',
  report_json: {},
  superseded_at: null,
  superseded_by: null,
  superseded_by_login: null,
  ...overrides,
});

const projectRow = (
  overrides: Partial<ProvisionedProjectRow> = {},
): ProvisionedProjectRow => ({
  id: 'project-1',
  user_id: 'owner-1',
  repo_full_name: 'org/repo',
  template_id: 'be-nestjs',
  service_name: 'api',
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

const checklistRow = (
  overrides: Partial<QaChecklistRow> = {},
): QaChecklistRow => ({
  id: 'checklist-1',
  workspace_id: 'workspace-1',
  name: 'Release checklist',
  description: null,
  version: 1,
  archived_at: null,
  created_by: 'lead-1',
  updated_by: null,
  created_at: '2026-09-25T00:00:00.000Z',
  updated_at: '2026-09-25T00:00:00.000Z',
  ...overrides,
});

const checklistItemRow = (
  overrides: Partial<QaChecklistItemRow> = {},
): QaChecklistItemRow => ({
  id: 'source-item-1',
  checklist_id: 'checklist-1',
  position: 0,
  title: 'Smoke test login',
  description: null,
  target_persona: 'all',
  verification_type: 'manual',
  test_identifier: null,
  ...overrides,
});

const makeRepository = (
  overrides: Partial<jest.Mocked<QaRunsRepository>> = {},
) =>
  ({
    createRun: jest.fn(),
    findRunForProject: jest.fn().mockResolvedValue(runRow()),
    findRunByKey: jest.fn().mockResolvedValue(null),
    listRunsForProject: jest.fn().mockResolvedValue([]),
    listItemsByRunId: jest.fn().mockResolvedValue([]),
    listItemsByRunIds: jest.fn().mockResolvedValue(new Map()),
    findItemForRun: jest.fn().mockResolvedValue(itemRow()),
    findActiveSignoffsByRunIds: jest.fn().mockResolvedValue(new Map()),
    findActiveSignoff: jest.fn().mockResolvedValue(null),
    findPriorItemSummaries: jest.fn().mockResolvedValue(new Map()),
    updateItem: jest.fn(),
    requestRetest: jest.fn(),
    createSignoff: jest.fn(),
    reopenRun: jest.fn(),
    listSupersededSignoffs: jest.fn().mockResolvedValue([]),
    listReturnedItemsForProject: jest.fn().mockResolvedValue([]),
    listOpenDeveloperItemsForProject: jest.fn().mockResolvedValue([]),
    ...overrides,
  }) as unknown as jest.Mocked<QaRunsRepository>;

const makeChecklistsRepository = (
  overrides: Partial<jest.Mocked<QaChecklistsRepository>> = {},
) =>
  ({
    listByProject: jest.fn().mockResolvedValue([checklistRow()]),
    listItemsByChecklistIds: jest
      .fn()
      .mockResolvedValue(new Map([['checklist-1', [checklistItemRow()]]])),
    ...overrides,
  }) as unknown as jest.Mocked<QaChecklistsRepository>;

const makeAccess = (overrides: Partial<jest.Mocked<QaAccessService>> = {}) =>
  ({
    findVisibleProject: jest.fn().mockResolvedValue(projectRow()),
    findAppRole: jest.fn().mockResolvedValue('member' as PlatformAppRole),
    listWorkspaceLeadIds: jest.fn().mockResolvedValue([]),
    listWorkspaceLeadAndDeveloperIds: jest.fn().mockResolvedValue([]),
    listWorkspaceQaIds: jest.fn().mockResolvedValue([]),
    ...overrides,
  }) as unknown as jest.Mocked<QaAccessService>;

const makeCommitResolution = (
  overrides: Partial<jest.Mocked<QaCommitResolutionService>> = {},
) =>
  ({
    resolve: jest.fn().mockResolvedValue({
      commitSha: 'a'.repeat(40),
      commitSource: 'deployment',
    }),
    resolveCommitAuthorUserId: jest.fn().mockResolvedValue(null),
    ...overrides,
  }) as unknown as jest.Mocked<QaCommitResolutionService>;

/** Defaults to "nothing has reported yet" — every item's automated resolves via matchAutomatedResult from this. */
const makeAutomation = (
  overrides: Partial<jest.Mocked<QaAutomationService>> = {},
) =>
  ({
    forRun: jest.fn().mockResolvedValue({ verify: null, quality: null }),
    ...overrides,
  }) as unknown as jest.Mocked<QaAutomationService>;

interface ServiceOverrides {
  repository?: jest.Mocked<QaRunsRepository>;
  checklists?: jest.Mocked<QaChecklistsRepository>;
  access?: jest.Mocked<QaAccessService>;
  commitResolution?: jest.Mocked<QaCommitResolutionService>;
  automation?: jest.Mocked<QaAutomationService>;
  audit?: { recordProjectEvent: jest.Mock };
  notifications?: { record: jest.Mock };
}

function makeService(overrides: ServiceOverrides = {}) {
  const repository = overrides.repository ?? makeRepository();
  const checklists = overrides.checklists ?? makeChecklistsRepository();
  const access = overrides.access ?? makeAccess();
  const commitResolution = overrides.commitResolution ?? makeCommitResolution();
  const automation = overrides.automation ?? makeAutomation();

  return {
    service: new QaRunsService(
      repository,
      checklists,
      access,
      commitResolution,
      automation,
      overrides.audit,
      overrides.notifications,
    ),
    repository,
    checklists,
    access,
    commitResolution,
    automation,
  };
}

const actor: QaRunActorContext = {
  userId: 'user-1',
  userLogin: 'user-login',
  oauthToken: null,
};

describe('QaRunsService.create', () => {
  it('404s when the project is not visible', async () => {
    const { service } = makeService({
      access: makeAccess({
        findVisibleProject: jest.fn().mockResolvedValue(null),
      }),
    });
    await expect(
      service.create('project-1', actor, {
        checklistId: 'checklist-1',
        branch: 'uat',
      }),
    ).rejects.toThrow(NotFoundException);
  });

  it('a member is forbidden from starting a run (403)', async () => {
    const { service } = makeService({
      access: makeAccess({
        findAppRole: jest.fn().mockResolvedValue('member'),
      }),
    });
    await expect(
      service.create('project-1', actor, {
        checklistId: 'checklist-1',
        branch: 'uat',
      }),
    ).rejects.toThrow(ForbiddenException);
  });

  it.each(['qa', 'lead', 'admin'] as const)(
    'role=%s may start a run',
    async (role) => {
      const repository = makeRepository({
        createRun: jest.fn().mockResolvedValue({
          created: true,
          run: runRow(),
          items: [itemRow()],
        }),
      });
      const { service } = makeService({
        repository,
        access: makeAccess({ findAppRole: jest.fn().mockResolvedValue(role) }),
      });
      await expect(
        service.create('project-1', actor, {
          checklistId: 'checklist-1',
          branch: 'uat',
        }),
      ).resolves.toBeDefined();
    },
  );

  // QA verifies the uat tier only: main is production and dev is not hosted.
  it.each(['dev', 'main'])(
    'rejects a run on %s with 400 (QA runs only on the QA branch)',
    async (branch) => {
      const { service } = makeService({
        access: makeAccess({ findAppRole: jest.fn().mockResolvedValue('qa') }),
      });
      await expect(
        service.create('project-1', actor, {
          checklistId: 'checklist-1',
          branch,
        }),
      ).rejects.toThrow(BadRequestException);
    },
  );

  it('rejects a checklist that is not shared to the project, or is archived (409)', async () => {
    const { service } = makeService({
      access: makeAccess({ findAppRole: jest.fn().mockResolvedValue('qa') }),
      checklists: makeChecklistsRepository({
        listByProject: jest.fn().mockResolvedValue([]),
      }),
    });
    await expect(
      service.create('project-1', actor, {
        checklistId: 'checklist-1',
        branch: 'uat',
      }),
    ).rejects.toThrow(ConflictException);
  });

  it('rejects when no commit can be resolved (409)', async () => {
    const { service } = makeService({
      access: makeAccess({ findAppRole: jest.fn().mockResolvedValue('qa') }),
      commitResolution: makeCommitResolution({
        resolve: jest.fn().mockResolvedValue(null),
      }),
    });
    await expect(
      service.create('project-1', actor, {
        checklistId: 'checklist-1',
        branch: 'uat',
      }),
    ).rejects.toThrow(ConflictException);
  });

  it('returns created=true (201 path) for a fresh run and records the audit event', async () => {
    const repository = makeRepository({
      createRun: jest.fn().mockResolvedValue({
        created: true,
        run: runRow(),
        items: [itemRow()],
      }),
    });
    const recordProjectEvent = jest.fn().mockResolvedValue(undefined);
    const { service } = makeService({
      repository,
      access: makeAccess({ findAppRole: jest.fn().mockResolvedValue('qa') }),
      audit: { recordProjectEvent },
    });

    const result = await service.create('project-1', actor, {
      checklistId: 'checklist-1',
      branch: 'uat',
    });

    expect(result.created).toBe(true);
    expect(recordProjectEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventCode: 'qa.run.created' }),
    );
  });

  it('returns created=false (200 path) for an idempotent repeat, without a create audit event', async () => {
    const repository = makeRepository({
      createRun: jest.fn().mockResolvedValue({
        created: false,
        run: runRow(),
        items: [itemRow()],
      }),
    });
    const recordProjectEvent = jest.fn().mockResolvedValue(undefined);
    const { service } = makeService({
      repository,
      access: makeAccess({ findAppRole: jest.fn().mockResolvedValue('lead') }),
      audit: { recordProjectEvent },
    });

    const result = await service.create('project-1', actor, {
      checklistId: 'checklist-1',
      branch: 'uat',
    });

    expect(result.created).toBe(false);
    expect(recordProjectEvent).not.toHaveBeenCalled();
  });
});

describe('QaRunsService.current', () => {
  it.each(['dev', 'main'])(
    'rejects %s with 400 (QA runs only on the QA branch)',
    async (branch) => {
      const { service } = makeService();
      await expect(
        service.current('project-1', actor, branch, undefined),
      ).rejects.toThrow(BadRequestException);
    },
  );

  it('resolves nulls (no 409) when no commit can be resolved', async () => {
    const { service } = makeService({
      commitResolution: makeCommitResolution({
        resolve: jest.fn().mockResolvedValue(null),
      }),
    });
    const result = await service.current(
      'project-1',
      actor,
      'uat',
      'checklist-1',
    );
    expect(result).toEqual({ commitSha: null, commitSource: null, run: null });
  });

  it('returns the resolved commit with a null run when no checklistId is given', async () => {
    const { service } = makeService();
    const result = await service.current('project-1', actor, 'uat', undefined);
    expect(result.run).toBeNull();
    expect(result.commitSha).toBe('a'.repeat(40));
    expect(result.commitSource).toBe('deployment');
  });

  it('returns the assembled run when one exists for (checklist, branch, commit)', async () => {
    const { service } = makeService({
      repository: makeRepository({
        findRunByKey: jest.fn().mockResolvedValue(runRow()),
      }),
    });
    const result = await service.current(
      'project-1',
      actor,
      'uat',
      'checklist-1',
    );
    expect(result.run).not.toBeNull();
    expect(result.run?.id).toBe('run-1');
  });
});

describe('QaRunsService.updateItem — persona permission matrix', () => {
  it.each([
    ['developer', 'member', true],
    ['developer', 'qa', true],
    ['developer', 'lead', true],
    ['developer', 'admin', true],
    ['qa', 'member', false],
    ['qa', 'qa', true],
    ['qa', 'lead', true],
    ['qa', 'admin', true],
    ['all', 'member', true],
    ['all', 'qa', true],
    ['all', 'lead', true],
    ['all', 'admin', true],
  ] as const)(
    'persona=%s role=%s allowed=%s',
    async (persona, role, allowed) => {
      const item = itemRow({ target_persona: persona });
      const updated = itemRow({ ...item, notes: 'updated' });
      const repository = makeRepository({
        findItemForRun: jest.fn().mockResolvedValue(item),
        updateItem: jest.fn().mockResolvedValue(updated),
        listItemsByRunId: jest.fn().mockResolvedValue([updated]),
      });
      const { service } = makeService({
        repository,
        access: makeAccess({ findAppRole: jest.fn().mockResolvedValue(role) }),
      });

      const call = service.updateItem('project-1', actor, 'run-1', 'item-1', {
        expectedRowVersion: 1,
        notes: 'updated',
      });

      if (allowed) {
        await expect(call).resolves.toBeDefined();
      } else {
        await expect(call).rejects.toThrow(ForbiddenException);
      }
    },
  );
});

describe('QaRunsService.updateItem — returned_to_dev restriction', () => {
  it('a member cannot set an "all"-persona item to returned_to_dev, even though they may otherwise edit it', async () => {
    const item = itemRow({ target_persona: 'all', status: 'in_progress' });
    const { service } = makeService({
      repository: makeRepository({
        findItemForRun: jest.fn().mockResolvedValue(item),
      }),
      access: makeAccess({
        findAppRole: jest.fn().mockResolvedValue('member'),
      }),
    });

    await expect(
      service.updateItem('project-1', actor, 'run-1', 'item-1', {
        expectedRowVersion: 1,
        status: 'returned_to_dev',
        defectSeverity: 'major',
      }),
    ).rejects.toThrow(ForbiddenException);
  });

  it.each(['qa', 'lead', 'admin'] as const)(
    'role=%s may set returned_to_dev',
    async (role) => {
      const item = itemRow({ target_persona: 'all', status: 'in_progress' });
      const updated = itemRow({
        ...item,
        status: 'returned_to_dev',
        defect_severity: 'major',
      });
      const repository = makeRepository({
        findItemForRun: jest.fn().mockResolvedValue(item),
        updateItem: jest.fn().mockResolvedValue(updated),
        listItemsByRunId: jest.fn().mockResolvedValue([updated]),
      });
      const { service } = makeService({
        repository,
        access: makeAccess({ findAppRole: jest.fn().mockResolvedValue(role) }),
      });

      await expect(
        service.updateItem('project-1', actor, 'run-1', 'item-1', {
          expectedRowVersion: 1,
          status: 'returned_to_dev',
          defectSeverity: 'major',
        }),
      ).resolves.toBeDefined();
    },
  );
});

describe('QaRunsService.updateItem — defect severity requirement', () => {
  it('400s marking an item failed with no defectSeverity in the body or already stored', async () => {
    const item = itemRow({ status: 'in_progress', defect_severity: null });
    const { service } = makeService({
      repository: makeRepository({
        findItemForRun: jest.fn().mockResolvedValue(item),
      }),
    });

    await expect(
      service.updateItem('project-1', actor, 'run-1', 'item-1', {
        expectedRowVersion: 1,
        status: 'failed',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('accepts marking an item failed when a defectSeverity is already stored on the row', async () => {
    const item = itemRow({ status: 'in_progress', defect_severity: 'minor' });
    const updated = itemRow({ ...item, status: 'failed' });
    const repository = makeRepository({
      findItemForRun: jest.fn().mockResolvedValue(item),
      updateItem: jest.fn().mockResolvedValue(updated),
      listItemsByRunId: jest.fn().mockResolvedValue([updated]),
    });
    const { service } = makeService({ repository });

    await expect(
      service.updateItem('project-1', actor, 'run-1', 'item-1', {
        expectedRowVersion: 1,
        status: 'failed',
      }),
    ).resolves.toBeDefined();
  });

  it('does not require a defectSeverity for "blocked"', async () => {
    const item = itemRow({ status: 'in_progress', defect_severity: null });
    const updated = itemRow({ ...item, status: 'blocked' });
    const repository = makeRepository({
      findItemForRun: jest.fn().mockResolvedValue(item),
      updateItem: jest.fn().mockResolvedValue(updated),
      listItemsByRunId: jest.fn().mockResolvedValue([updated]),
    });
    const { service } = makeService({ repository });

    await expect(
      service.updateItem('project-1', actor, 'run-1', 'item-1', {
        expectedRowVersion: 1,
        status: 'blocked',
      }),
    ).resolves.toBeDefined();
  });
});

describe('QaRunsService.updateItem — row version conflict', () => {
  it('surfaces a lost row-version race as 409', async () => {
    const repository = makeRepository({
      updateItem: jest.fn().mockResolvedValue(null),
    });
    const { service } = makeService({ repository });

    await expect(
      service.updateItem('project-1', actor, 'run-1', 'item-1', {
        expectedRowVersion: 5,
        notes: 'x',
      }),
    ).rejects.toThrow(ConflictException);
  });
});

describe('QaRunsService — run-row locking outcomes', () => {
  it('maps a signoff that committed during an item write to the signed-off 409', async () => {
    const repository = makeRepository({
      updateItem: jest.fn().mockRejectedValue(new QaRunNotOpenError('run-1')),
    });
    const { service } = makeService({ repository });

    await expect(
      service.updateItem('project-1', actor, 'run-1', 'item-1', {
        expectedRowVersion: 1,
        notes: 'x',
      }),
    ).rejects.toThrow('This run is signed off. Reopen it to make changes.');
  });

  it('maps a signoff that committed during a re-test request to the signed-off 409', async () => {
    const repository = makeRepository({
      findItemForRun: jest
        .fn()
        .mockResolvedValue(
          itemRow({ status: 'returned_to_dev', defect_severity: 'major' }),
        ),
      requestRetest: jest
        .fn()
        .mockRejectedValue(new QaRunNotOpenError('run-1')),
    });
    const { service } = makeService({
      repository,
      access: makeAccess({
        findAppRole: jest.fn().mockResolvedValue('member'),
      }),
    });

    await expect(
      service.requestRetest('project-1', actor, 'run-1', 'item-1', {}),
    ).rejects.toThrow(ConflictException);
  });

  it('passes the item fingerprint it validated to the signoff, and 409s if items changed', async () => {
    const items = [
      itemRow({ id: 'item-1', status: 'passed', row_version: 3 }),
      itemRow({ id: 'item-2', position: 1, status: 'passed', row_version: 4 }),
    ];
    const createSignoff = jest
      .fn()
      .mockRejectedValue(new QaRunItemsChangedError('run-1'));
    const { service } = makeService({
      repository: makeRepository({
        listItemsByRunId: jest.fn().mockResolvedValue(items),
        createSignoff,
      }),
      access: makeAccess({ findAppRole: jest.fn().mockResolvedValue('qa') }),
    });

    await expect(
      service.signoff('project-1', actor, 'run-1', { verdict: 'APPROVED' }),
    ).rejects.toThrow(/changed while you were signing off/);
    expect(createSignoff).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedItems: { count: 2, rowVersionSum: 7 },
      }),
    );
  });
});

describe('signed-off runs are read-only', () => {
  it('updateItem 409s', async () => {
    const { service } = makeService({
      repository: makeRepository({
        findRunForProject: jest
          .fn()
          .mockResolvedValue(runRow({ status: 'signed_off' })),
      }),
    });
    await expect(
      service.updateItem('project-1', actor, 'run-1', 'item-1', {
        expectedRowVersion: 1,
        notes: 'x',
      }),
    ).rejects.toThrow(ConflictException);
  });

  it('requestRetest 409s', async () => {
    const { service } = makeService({
      repository: makeRepository({
        findRunForProject: jest
          .fn()
          .mockResolvedValue(runRow({ status: 'signed_off' })),
        findItemForRun: jest
          .fn()
          .mockResolvedValue(itemRow({ status: 'returned_to_dev' })),
      }),
    });
    await expect(
      service.requestRetest('project-1', actor, 'run-1', 'item-1', {}),
    ).rejects.toThrow(ConflictException);
  });

  it('signoff 409s on an already signed-off run', async () => {
    const { service } = makeService({
      repository: makeRepository({
        findRunForProject: jest
          .fn()
          .mockResolvedValue(runRow({ status: 'signed_off' })),
      }),
    });
    await expect(
      service.signoff('project-1', actor, 'run-1', { verdict: 'REJECTED' }),
    ).rejects.toThrow(ConflictException);
  });
});

describe('QaRunsService.requestRetest', () => {
  it('qa is forbidden from requesting a retest', async () => {
    const { service } = makeService({
      repository: makeRepository({
        findItemForRun: jest
          .fn()
          .mockResolvedValue(itemRow({ status: 'returned_to_dev' })),
      }),
      access: makeAccess({ findAppRole: jest.fn().mockResolvedValue('qa') }),
    });
    await expect(
      service.requestRetest('project-1', actor, 'run-1', 'item-1', {}),
    ).rejects.toThrow(ForbiddenException);
  });

  it.each(['member', 'lead', 'admin'] as const)(
    'role=%s may request a retest',
    async (role) => {
      const item = itemRow({ status: 'returned_to_dev', verified_by: 'qa-1' });
      const updated = itemRow({
        ...item,
        status: 'pending',
        verified_by: null,
      });
      const repository = makeRepository({
        findItemForRun: jest.fn().mockResolvedValue(item),
        requestRetest: jest.fn().mockResolvedValue(updated),
        listItemsByRunId: jest.fn().mockResolvedValue([updated]),
      });
      const { service } = makeService({
        repository,
        access: makeAccess({ findAppRole: jest.fn().mockResolvedValue(role) }),
      });

      await expect(
        service.requestRetest('project-1', actor, 'run-1', 'item-1', {
          note: 'fixed',
        }),
      ).resolves.toBeDefined();
    },
  );

  it('409s when the item is not currently returned_to_dev', async () => {
    const { service } = makeService({
      repository: makeRepository({
        findItemForRun: jest
          .fn()
          .mockResolvedValue(itemRow({ status: 'passed' })),
      }),
      access: makeAccess({
        findAppRole: jest.fn().mockResolvedValue('member'),
      }),
    });
    await expect(
      service.requestRetest('project-1', actor, 'run-1', 'item-1', {}),
    ).rejects.toThrow(ConflictException);
  });

  it('notifies the previous verifier, excluding the actor when they are the same person', async () => {
    const item = itemRow({
      status: 'returned_to_dev',
      verified_by: 'qa-1',
      verified_by_login: 'qa-login',
    });
    const updated = itemRow({ ...item, status: 'pending', verified_by: null });
    const record = jest.fn().mockResolvedValue(undefined);
    const repository = makeRepository({
      findItemForRun: jest.fn().mockResolvedValue(item),
      requestRetest: jest.fn().mockResolvedValue(updated),
      listItemsByRunId: jest.fn().mockResolvedValue([updated]),
    });
    const { service } = makeService({
      repository,
      access: makeAccess({
        findAppRole: jest.fn().mockResolvedValue('member'),
      }),
      notifications: { record },
    });

    await service.requestRetest('project-1', actor, 'run-1', 'item-1', {
      note: 'fixed',
    });

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'qa-1',
        eventCode: 'qa.item.retest_requested',
      }),
    );
  });

  it('does not notify when the previous verifier is the actor themself', async () => {
    const item = itemRow({
      status: 'returned_to_dev',
      verified_by: actor.userId,
      verified_by_login: actor.userLogin,
    });
    const updated = itemRow({ ...item, status: 'pending', verified_by: null });
    const record = jest.fn().mockResolvedValue(undefined);
    const repository = makeRepository({
      findItemForRun: jest.fn().mockResolvedValue(item),
      requestRetest: jest.fn().mockResolvedValue(updated),
      listItemsByRunId: jest.fn().mockResolvedValue([updated]),
    });
    const { service } = makeService({
      repository,
      access: makeAccess({
        findAppRole: jest.fn().mockResolvedValue('member'),
      }),
      notifications: { record },
    });

    await service.requestRetest('project-1', actor, 'run-1', 'item-1', {});

    expect(record).not.toHaveBeenCalled();
  });
});

describe('QaRunsService.signoff', () => {
  it('a member is forbidden from signing off', async () => {
    const { service } = makeService({
      access: makeAccess({
        findAppRole: jest.fn().mockResolvedValue('member'),
      }),
    });
    await expect(
      service.signoff('project-1', actor, 'run-1', { verdict: 'REJECTED' }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('APPROVED rejects when not every item is passed (409, names the count)', async () => {
    const { service } = makeService({
      repository: makeRepository({
        listItemsByRunId: jest
          .fn()
          .mockResolvedValue([
            itemRow({ id: 'i-1', status: 'passed' }),
            itemRow({ id: 'i-2', status: 'pending' }),
          ]),
      }),
      access: makeAccess({ findAppRole: jest.fn().mockResolvedValue('qa') }),
    });
    await expect(
      service.signoff('project-1', actor, 'run-1', { verdict: 'APPROVED' }),
    ).rejects.toThrow(ConflictException);
  });

  it('APPROVED succeeds when every item is passed', async () => {
    const { service } = makeService({
      repository: makeRepository({
        listItemsByRunId: jest
          .fn()
          .mockResolvedValue([itemRow({ status: 'passed' })]),
        createSignoff: jest.fn().mockResolvedValue({
          run: runRow({ status: 'signed_off' }),
          signoff: signoffRow(),
        }),
      }),
      access: makeAccess({ findAppRole: jest.fn().mockResolvedValue('qa') }),
    });
    await expect(
      service.signoff('project-1', actor, 'run-1', { verdict: 'APPROVED' }),
    ).resolves.toBeDefined();
  });

  it('CONDITIONAL requires non-empty conditions (400)', async () => {
    const { service } = makeService({
      repository: makeRepository({
        listItemsByRunId: jest
          .fn()
          .mockResolvedValue([itemRow({ status: 'passed' })]),
      }),
      access: makeAccess({ findAppRole: jest.fn().mockResolvedValue('qa') }),
    });
    await expect(
      service.signoff('project-1', actor, 'run-1', { verdict: 'CONDITIONAL' }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.signoff('project-1', actor, 'run-1', {
        verdict: 'CONDITIONAL',
        conditions: '   ',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('CONDITIONAL rejects when an item is still pending or in_progress (409)', async () => {
    const { service } = makeService({
      repository: makeRepository({
        listItemsByRunId: jest
          .fn()
          .mockResolvedValue([itemRow({ status: 'in_progress' })]),
      }),
      access: makeAccess({ findAppRole: jest.fn().mockResolvedValue('qa') }),
    });
    await expect(
      service.signoff('project-1', actor, 'run-1', {
        verdict: 'CONDITIONAL',
        conditions: 'known issue',
      }),
    ).rejects.toThrow(ConflictException);
  });

  it('CONDITIONAL succeeds with conditions and no pending/in_progress items', async () => {
    const { service } = makeService({
      repository: makeRepository({
        listItemsByRunId: jest
          .fn()
          .mockResolvedValue([
            itemRow({ status: 'blocked', defect_severity: 'minor' }),
          ]),
        createSignoff: jest.fn().mockResolvedValue({
          run: runRow({ status: 'signed_off' }),
          signoff: signoffRow({
            verdict: 'CONDITIONAL',
            conditions: 'known issue',
          }),
        }),
      }),
      access: makeAccess({ findAppRole: jest.fn().mockResolvedValue('qa') }),
    });
    await expect(
      service.signoff('project-1', actor, 'run-1', {
        verdict: 'CONDITIONAL',
        conditions: 'known issue',
      }),
    ).resolves.toBeDefined();
  });

  it('REJECTED is always allowed, regardless of item state', async () => {
    const { service } = makeService({
      repository: makeRepository({
        listItemsByRunId: jest
          .fn()
          .mockResolvedValue([itemRow({ status: 'pending' })]),
        createSignoff: jest.fn().mockResolvedValue({
          run: runRow({ status: 'signed_off' }),
          signoff: signoffRow({ verdict: 'REJECTED' }),
        }),
      }),
      access: makeAccess({ findAppRole: jest.fn().mockResolvedValue('qa') }),
    });
    await expect(
      service.signoff('project-1', actor, 'run-1', { verdict: 'REJECTED' }),
    ).resolves.toBeDefined();
  });

  it('409s when the signoff races another signoff/reopen (repository returns null)', async () => {
    const { service } = makeService({
      repository: makeRepository({
        listItemsByRunId: jest
          .fn()
          .mockResolvedValue([itemRow({ status: 'pending' })]),
        createSignoff: jest.fn().mockResolvedValue(null),
      }),
      access: makeAccess({ findAppRole: jest.fn().mockResolvedValue('qa') }),
    });
    await expect(
      service.signoff('project-1', actor, 'run-1', { verdict: 'REJECTED' }),
    ).rejects.toThrow(ConflictException);
  });

  it('notifies the run creator, project owner, and workspace leads, excluding the actor', async () => {
    const record = jest.fn().mockResolvedValue(undefined);
    const { service } = makeService({
      repository: makeRepository({
        findRunForProject: jest
          .fn()
          .mockResolvedValue(runRow({ created_by: 'creator-1' })),
        listItemsByRunId: jest
          .fn()
          .mockResolvedValue([itemRow({ status: 'passed' })]),
        createSignoff: jest.fn().mockResolvedValue({
          run: runRow({ status: 'signed_off', created_by: 'creator-1' }),
          signoff: signoffRow(),
        }),
      }),
      access: makeAccess({
        findAppRole: jest.fn().mockResolvedValue('lead'),
        listWorkspaceLeadIds: jest
          .fn()
          .mockResolvedValue(['lead-2', actor.userId]),
      }),
      notifications: { record },
    });

    await service.signoff('project-1', actor, 'run-1', { verdict: 'APPROVED' });

    const recipientIds = record.mock.calls
      .map((call) => (call[0] as { userId: string }).userId)
      .sort();
    expect(recipientIds).toEqual(['creator-1', 'lead-2', 'owner-1'].sort());
    expect(recipientIds).not.toContain(actor.userId);
  });
});

describe('QaRunsService.reopen', () => {
  it('a qa user is forbidden from reopening', async () => {
    const { service } = makeService({
      repository: makeRepository({
        findRunForProject: jest
          .fn()
          .mockResolvedValue(runRow({ status: 'signed_off' })),
      }),
      access: makeAccess({ findAppRole: jest.fn().mockResolvedValue('qa') }),
    });
    await expect(service.reopen('project-1', actor, 'run-1')).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('409s when the run is not signed off', async () => {
    const { service } = makeService({
      repository: makeRepository({
        findRunForProject: jest
          .fn()
          .mockResolvedValue(runRow({ status: 'open' })),
      }),
      access: makeAccess({ findAppRole: jest.fn().mockResolvedValue('lead') }),
    });
    await expect(service.reopen('project-1', actor, 'run-1')).rejects.toThrow(
      ConflictException,
    );
  });

  it.each(['lead', 'admin'] as const)(
    'role=%s may reopen a signed-off run',
    async (role) => {
      const reopenRun = jest.fn().mockResolvedValue(runRow({ status: 'open' }));
      const { service } = makeService({
        repository: makeRepository({
          findRunForProject: jest
            .fn()
            .mockResolvedValue(runRow({ status: 'signed_off' })),
          reopenRun,
        }),
        access: makeAccess({ findAppRole: jest.fn().mockResolvedValue(role) }),
      });
      await expect(
        service.reopen('project-1', actor, 'run-1'),
      ).resolves.toBeDefined();
      // Reopen supersedes the active signoff as this actor -- the report
      // export's signoffHistory needs the login, not just the id.
      expect(reopenRun).toHaveBeenCalledWith('run-1', {
        id: actor.userId,
        login: actor.userLogin,
      });
    },
  );
});

describe('QaRunsService.listReturnedItems', () => {
  it('maps repository rows into the QaReturnedItem shape', async () => {
    const item = itemRow({ status: 'returned_to_dev' });
    const { service } = makeService({
      repository: makeRepository({
        listReturnedItemsForProject: jest.fn().mockResolvedValue([
          {
            item,
            runBranch: 'uat',
            runCommitSha: 'a'.repeat(40),
            runChecklistName: 'Release checklist',
          },
        ]),
      }),
    });

    const result = await service.listReturnedItems('project-1', actor.userId);

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      runId: 'run-1',
      branch: 'uat',
      commitSha: 'a'.repeat(40),
      checklistName: 'Release checklist',
    });
    expect(result.items[0]?.item.status).toBe('returned_to_dev');
  });

  it('dedupes the automation lookup across rows that share a (branch, commitSha), one per distinct run', async () => {
    const sameRunItemA = itemRow({ id: 'item-a', status: 'returned_to_dev' });
    const sameRunItemB = itemRow({ id: 'item-b', status: 'returned_to_dev' });
    const otherRunItem = itemRow({ id: 'item-c', status: 'returned_to_dev' });
    const forRun = jest.fn().mockResolvedValue({ verify: null, quality: null });
    const { service } = makeService({
      repository: makeRepository({
        listReturnedItemsForProject: jest.fn().mockResolvedValue([
          {
            item: sameRunItemA,
            runBranch: 'uat',
            runCommitSha: 'sha-a',
            runChecklistName: 'c',
          },
          {
            item: sameRunItemB,
            runBranch: 'uat',
            runCommitSha: 'sha-a',
            runChecklistName: 'c',
          },
          {
            item: otherRunItem,
            runBranch: 'dev',
            runCommitSha: 'sha-b',
            runChecklistName: 'c',
          },
        ]),
      }),
      automation: makeAutomation({ forRun }),
    });

    const result = await service.listReturnedItems('project-1', actor.userId);

    expect(result.items).toHaveLength(3);
    expect(forRun).toHaveBeenCalledTimes(2);
    expect(forRun).toHaveBeenCalledWith('org/repo', 'uat', 'sha-a');
    expect(forRun).toHaveBeenCalledWith('org/repo', 'dev', 'sha-b');
  });
});

describe('QaRunsService.listMyItems', () => {
  it('combines listReturnedItems output with open developer-targeted items on uat', async () => {
    const returnedItem = itemRow({
      id: 'item-returned',
      status: 'returned_to_dev',
    });
    const developerItem = itemRow({
      id: 'item-dev',
      target_persona: 'developer',
      status: 'failed',
    });
    const { service, repository } = makeService({
      repository: makeRepository({
        listReturnedItemsForProject: jest.fn().mockResolvedValue([
          {
            item: returnedItem,
            runBranch: 'uat',
            runCommitSha: 'a'.repeat(40),
            runChecklistName: 'Release checklist',
          },
        ]),
        listOpenDeveloperItemsForProject: jest.fn().mockResolvedValue([
          {
            item: developerItem,
            runBranch: 'uat',
            runCommitSha: 'b'.repeat(40),
            runChecklistName: 'Release checklist',
          },
        ]),
      }),
    });

    const result = await service.listMyItems('project-1', actor.userId);

    expect(result.returned).toHaveLength(1);
    expect(result.returned[0]?.item.id).toBe('item-returned');
    expect(result.developerItems).toHaveLength(1);
    expect(result.developerItems[0]?.item.id).toBe('item-dev');
    expect(repository.listOpenDeveloperItemsForProject).toHaveBeenCalledWith(
      'project-1',
      'uat',
    );
  });

  it("computes canUpdate for developer items using the caller's own role", async () => {
    const developerItem = itemRow({
      id: 'item-dev',
      target_persona: 'developer',
      status: 'pending',
    });
    const { service } = makeService({
      access: makeAccess({
        findAppRole: jest.fn().mockResolvedValue('member'),
      }),
      repository: makeRepository({
        listOpenDeveloperItemsForProject: jest.fn().mockResolvedValue([
          {
            item: developerItem,
            runBranch: 'uat',
            runCommitSha: 'b'.repeat(40),
            runChecklistName: 'Release checklist',
          },
        ]),
      }),
    });

    const result = await service.listMyItems('project-1', actor.userId);

    // developer persona + open run + role 'member' -> canUpdate true.
    expect(result.developerItems[0]?.item.canUpdate).toBe(true);
  });

  it('returns empty arrays when nothing is returned or outstanding', async () => {
    const { service } = makeService();

    const result = await service.listMyItems('project-1', actor.userId);

    expect(result).toEqual({ returned: [], developerItems: [] });
  });
});

/**
 * assembleRun's automation wiring (used by getById, create, current,
 * updateItem, requestRetest, signoff, reopen) -- verified once here on
 * getById rather than duplicated per method, since they all share the
 * private assembleRun implementation.
 */
describe('QaRunsService — assembleRun automation wiring', () => {
  it('getById asks QaAutomationService for the run own (repo, branch, commitSha) and threads the result onto QaRun.automation', async () => {
    const forRun = jest.fn().mockResolvedValue({ verify: null, quality: null });
    const { service } = makeService({
      access: makeAccess({
        findVisibleProject: jest
          .fn()
          .mockResolvedValue(projectRow({ repo_full_name: 'acme/orders-api' })),
      }),
      repository: makeRepository({
        findRunForProject: jest
          .fn()
          .mockResolvedValue(
            runRow({ branch: 'uat', commit_sha: 'c'.repeat(40) }),
          ),
      }),
      automation: makeAutomation({ forRun }),
    });

    const run = await service.getById('project-1', actor.userId, 'run-1');

    expect(forRun).toHaveBeenCalledWith(
      'acme/orders-api',
      'uat',
      'c'.repeat(40),
    );
    expect(run.automation).toEqual({ verify: null, quality: null });
  });

  it('threads QaRunAutomation into each item.automated through the real matcher, not a stub', async () => {
    const verifyReport = {
      stage: 'verify' as const,
      status: 'failure' as const,
      runId: 99,
      runUrl: 'https://github.com/acme/orders-api/actions/runs/99',
      reportedAt: '2026-09-25T00:00:00.000Z',
      tests: {
        total: 1,
        passed: 0,
        failed: 1,
        failures: [
          {
            name: 'e2e/checkout.spec.ts > Checkout > pays',
            message: 'timeout',
          },
        ],
        failuresTruncated: false,
      },
    };
    const { service } = makeService({
      repository: makeRepository({
        listItemsByRunId: jest.fn().mockResolvedValue([
          itemRow({
            verification_type: 'playwright',
            test_identifier: 'e2e/checkout.spec.ts › Checkout › pays',
          }),
        ]),
      }),
      automation: makeAutomation({
        forRun: jest
          .fn()
          .mockResolvedValue({ verify: verifyReport, quality: null }),
      }),
    });

    const run = await service.getById('project-1', actor.userId, 'run-1');

    expect(run.items[0]?.automated).toEqual({
      source: 'playwright',
      stage: 'verify',
      status: 'failed',
      scope: 'spec',
      matchedSpec: 'e2e/checkout.spec.ts',
      failure: {
        name: 'e2e/checkout.spec.ts > Checkout > pays',
        message: 'timeout',
      },
      runId: 99,
      runUrl: verifyReport.runUrl,
      reportedAt: verifyReport.reportedAt,
    });
  });

  it('is null on a manual item even when the run has automation for other items', async () => {
    const { service } = makeService({
      repository: makeRepository({
        listItemsByRunId: jest
          .fn()
          .mockResolvedValue([itemRow({ verification_type: 'manual' })]),
      }),
      automation: makeAutomation({
        forRun: jest.fn().mockResolvedValue({
          verify: {
            stage: 'verify',
            status: 'success',
            runId: 1,
            runUrl: 'https://github.com/acme/orders-api/actions/runs/1',
            reportedAt: '2026-09-25T00:00:00.000Z',
            tests: null,
          },
          quality: null,
        }),
      }),
    });

    const run = await service.getById('project-1', actor.userId, 'run-1');

    expect(run.items[0]?.automated).toBeNull();
  });
});

describe('QaRunsService notification recipients', () => {
  const returnedItem = itemRow({
    status: 'in_progress',
    defect_severity: 'major',
    target_persona: 'all',
  });

  const returnToDev = async (options: {
    access?: Partial<jest.Mocked<QaAccessService>>;
    commitResolution?: Partial<jest.Mocked<QaCommitResolutionService>>;
    actorOverride?: QaRunActorContext;
  }) => {
    const record = jest.fn().mockResolvedValue(undefined);
    const updated = itemRow({
      ...returnedItem,
      status: 'returned_to_dev',
      defect_severity: 'major',
    });
    const commitResolution = makeCommitResolution(options.commitResolution);
    const { service } = makeService({
      repository: makeRepository({
        findItemForRun: jest.fn().mockResolvedValue(returnedItem),
        updateItem: jest.fn().mockResolvedValue(updated),
        listItemsByRunId: jest.fn().mockResolvedValue([updated]),
      }),
      access: makeAccess({
        findAppRole: jest.fn().mockResolvedValue('qa'),
        ...options.access,
      }),
      commitResolution,
      notifications: { record },
    });
    await service.updateItem(
      'project-1',
      options.actorOverride ?? actor,
      'run-1',
      'item-1',
      { expectedRowVersion: 1, status: 'returned_to_dev' },
    );
    const recipients = record.mock.calls
      .map(([input]) => input as { userId: string; eventCode: string })
      .filter((input) => input.eventCode === 'qa.item.returned_to_dev')
      .map((input) => input.userId);
    return { recipients, commitResolution };
  };

  it('returned_to_dev reaches owner, leads and developers, deduplicated, minus the actor', async () => {
    const { recipients } = await returnToDev({
      access: {
        listWorkspaceLeadAndDeveloperIds: jest
          .fn()
          .mockResolvedValue(['lead-1', 'dev-1', 'owner-1', actor.userId]),
      },
    });

    expect([...recipients].sort()).toEqual(['dev-1', 'lead-1', 'owner-1']);
  });

  it('returned_to_dev adds the commit author when they can see the project', async () => {
    const { recipients, commitResolution } = await returnToDev({
      commitResolution: {
        resolveCommitAuthorUserId: jest.fn().mockResolvedValue('author-1'),
      },
    });

    expect(recipients).toContain('author-1');
    expect(commitResolution.resolveCommitAuthorUserId).toHaveBeenCalledWith(
      'org/repo',
      actor.userId,
      'a'.repeat(40),
      null,
    );
  });

  it('returned_to_dev skips a commit author who cannot see the project', async () => {
    const findVisibleProject = jest
      .fn()
      .mockImplementation((_projectId: string, userId: string) =>
        Promise.resolve(userId === 'author-1' ? null : projectRow()),
      );
    const { recipients } = await returnToDev({
      access: { findVisibleProject },
      commitResolution: {
        resolveCommitAuthorUserId: jest.fn().mockResolvedValue('author-1'),
      },
    });

    expect(recipients).not.toContain('author-1');
  });

  it('returned_to_dev does not duplicate an author who is already a developer', async () => {
    const { recipients } = await returnToDev({
      access: {
        listWorkspaceLeadAndDeveloperIds: jest
          .fn()
          .mockResolvedValue(['dev-1']),
      },
      commitResolution: {
        resolveCommitAuthorUserId: jest.fn().mockResolvedValue('dev-1'),
      },
    });

    expect(recipients.filter((id) => id === 'dev-1')).toHaveLength(1);
  });

  it('returned_to_dev excludes the actor even when they authored the commit', async () => {
    const { recipients } = await returnToDev({
      commitResolution: {
        resolveCommitAuthorUserId: jest.fn().mockResolvedValue(actor.userId),
      },
    });

    expect(recipients).not.toContain(actor.userId);
  });

  it('retest_requested reaches the previous verifier and the QA team, deduplicated, minus the actor', async () => {
    const item = itemRow({ status: 'returned_to_dev', verified_by: 'qa-1' });
    const updated = itemRow({ ...item, status: 'pending', verified_by: null });
    const record = jest.fn().mockResolvedValue(undefined);
    const { service } = makeService({
      repository: makeRepository({
        findItemForRun: jest.fn().mockResolvedValue(item),
        requestRetest: jest.fn().mockResolvedValue(updated),
        listItemsByRunId: jest.fn().mockResolvedValue([updated]),
      }),
      access: makeAccess({
        findAppRole: jest.fn().mockResolvedValue('member'),
        listWorkspaceQaIds: jest
          .fn()
          .mockResolvedValue(['qa-1', 'qa-2', actor.userId]),
      }),
      notifications: { record },
    });

    await service.requestRetest('project-1', actor, 'run-1', 'item-1', {});

    const ids = record.mock.calls.map(
      ([input]) => (input as { userId: string }).userId,
    );
    expect([...ids].sort()).toEqual(['qa-1', 'qa-2']);
  });

  it('retest_requested still reaches the QA team when there is no previous verifier', async () => {
    const item = itemRow({ status: 'returned_to_dev', verified_by: null });
    const updated = itemRow({ ...item, status: 'pending' });
    const record = jest.fn().mockResolvedValue(undefined);
    const { service } = makeService({
      repository: makeRepository({
        findItemForRun: jest.fn().mockResolvedValue(item),
        requestRetest: jest.fn().mockResolvedValue(updated),
        listItemsByRunId: jest.fn().mockResolvedValue([updated]),
      }),
      access: makeAccess({
        findAppRole: jest.fn().mockResolvedValue('member'),
        listWorkspaceQaIds: jest.fn().mockResolvedValue(['qa-2']),
      }),
      notifications: { record },
    });

    await service.requestRetest('project-1', actor, 'run-1', 'item-1', {});

    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'qa-2' }),
    );
  });
});
