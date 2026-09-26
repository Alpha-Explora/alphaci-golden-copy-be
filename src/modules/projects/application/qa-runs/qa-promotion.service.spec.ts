import { ForbiddenException, NotFoundException } from '@nestjs/common';

import type {
  AuditEventPublisher,
  NotificationEventPublisher,
} from '#kernel/events/platform-event-publisher.js';
import type {
  GitHubBranchSummary,
  GitHubPullRequestDetail,
  GitHubPullRequestSummary,
  GithubProjectPort,
} from '#kernel/ports/github.port';
import type { PlatformAppRole } from '#kernel/ports/platform-admin.port';
import type { QaChecklistRow } from '../../infrastructure/qa-checklists.repository';
import type { QaChecklistsRepository } from '../../infrastructure/qa-checklists.repository';
import type {
  QaRunSignoffRow,
  QaRunsRepository,
  QaVerificationRunRow,
} from '../../infrastructure/qa-runs.repository';
import type { ProvisionedProjectRow } from '../../infrastructure/projects.repository';
import type { QaAccessService } from '../qa-checklists/qa-access.service';
import { QaPromotionService } from './qa-promotion.service';
import type { QaRunActorContext } from './qa-runs.service';

const SHA = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';

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

const runRow = (
  overrides: Partial<QaVerificationRunRow> = {},
): QaVerificationRunRow => ({
  id: 'run-1',
  project_id: 'project-1',
  checklist_id: 'checklist-1',
  checklist_version: 1,
  checklist_name: 'Release checklist',
  branch: 'uat',
  commit_sha: SHA,
  commit_source: 'deployment',
  status: 'signed_off',
  created_by: 'creator-1',
  created_by_login: 'creator-login',
  created_at: '2026-09-25T00:00:00.000Z',
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
  signed_by: 'qa-1',
  signed_by_login: 'qa-login',
  signed_at: '2026-09-25T01:00:00.000Z',
  report_json: {},
  superseded_at: null,
  superseded_by: null,
  superseded_by_login: null,
  ...overrides,
});

const branch = (
  overrides: Partial<GitHubBranchSummary> = {},
): GitHubBranchSummary => ({
  name: 'uat',
  protected: true,
  commitSha: SHA,
  ...overrides,
});

const pullRequestSummary = (
  overrides: Partial<GitHubPullRequestSummary> = {},
): GitHubPullRequestSummary => ({
  number: 42,
  title: 'Promote uat to main',
  state: 'open',
  draft: false,
  merged: false,
  htmlUrl: 'https://github.com/org/repo/pull/42',
  headRef: 'uat',
  baseRef: 'main',
  author: 'lead-login',
  authorAvatarUrl: null,
  createdAt: '2026-09-25T00:00:00.000Z',
  updatedAt: '2026-09-25T00:00:00.000Z',
  additions: null,
  deletions: null,
  changedFiles: null,
  ...overrides,
});

const pullRequestDetail = (
  overrides: Partial<GitHubPullRequestDetail> = {},
): GitHubPullRequestDetail => ({
  ...pullRequestSummary(),
  mergeable: true,
  mergeableState: 'clean',
  headSha: SHA,
  body: null,
  ...overrides,
});

const makeAccess = (
  overrides: Partial<jest.Mocked<QaAccessService>> = {},
): jest.Mocked<QaAccessService> =>
  ({
    findVisibleProject: jest.fn().mockResolvedValue(projectRow()),
    findAppRole: jest.fn().mockResolvedValue('lead' as PlatformAppRole),
    listWorkspaceLeadIds: jest.fn().mockResolvedValue([]),
    ...overrides,
  }) as unknown as jest.Mocked<QaAccessService>;

const makeChecklistsRepository = (
  overrides: Partial<jest.Mocked<QaChecklistsRepository>> = {},
): jest.Mocked<QaChecklistsRepository> =>
  ({
    listByProject: jest.fn().mockResolvedValue([checklistRow()]),
    ...overrides,
  }) as unknown as jest.Mocked<QaChecklistsRepository>;

const makeRunsRepository = (
  overrides: Partial<jest.Mocked<QaRunsRepository>> = {},
): jest.Mocked<QaRunsRepository> =>
  ({
    findRunByKey: jest.fn().mockResolvedValue(runRow()),
    findActiveSignoffsByRunIds: jest
      .fn()
      .mockResolvedValue(new Map([['run-1', signoffRow()]])),
    ...overrides,
  }) as unknown as jest.Mocked<QaRunsRepository>;

const makeGithub = (
  overrides: Partial<jest.Mocked<GithubProjectPort>> = {},
): jest.Mocked<GithubProjectPort> =>
  ({
    getEnforcedOrg: jest.fn().mockReturnValue(''),
    getOrganizationProvisioningContextByLogin: jest.fn(),
    getInstallationAccessTokenForUserRepo: jest
      .fn()
      .mockResolvedValue('installation-token'),
    listBranches: jest.fn().mockResolvedValue([branch()]),
    findOpenPullRequest: jest.fn().mockResolvedValue(pullRequestSummary()),
    getPullRequest: jest.fn().mockResolvedValue(pullRequestDetail()),
    openPullRequest: jest.fn().mockResolvedValue({
      created: true,
      pullRequest: pullRequestSummary(),
    }),
    mergePullRequest: jest.fn().mockResolvedValue({
      merged: true,
      message: 'Merged.',
      sha: 'merged-sha',
    }),
    ...overrides,
  }) as unknown as jest.Mocked<GithubProjectPort>;

const makeAudit = () =>
  ({
    recordProjectEvent: jest.fn(),
  }) as unknown as jest.Mocked<AuditEventPublisher>;

const makeNotifications = () =>
  ({ record: jest.fn() }) as unknown as jest.Mocked<NotificationEventPublisher>;

const actor: QaRunActorContext = {
  userId: 'lead-1',
  userLogin: 'lead-login',
  oauthToken: 'gho_actor_token',
};

interface Overrides {
  access?: jest.Mocked<QaAccessService>;
  checklists?: jest.Mocked<QaChecklistsRepository>;
  runs?: jest.Mocked<QaRunsRepository>;
  github?: jest.Mocked<GithubProjectPort>;
  audit?: jest.Mocked<AuditEventPublisher>;
  notifications?: jest.Mocked<NotificationEventPublisher>;
}

function makeService(overrides: Overrides = {}) {
  const access = overrides.access ?? makeAccess();
  const checklists = overrides.checklists ?? makeChecklistsRepository();
  const runs = overrides.runs ?? makeRunsRepository();
  const github = overrides.github ?? makeGithub();
  const audit = overrides.audit ?? makeAudit();
  const notifications = overrides.notifications ?? makeNotifications();

  return {
    service: new QaPromotionService(
      access,
      checklists,
      runs,
      github,
      audit,
      notifications,
    ),
    access,
    checklists,
    runs,
    github,
    audit,
    notifications,
  };
}

describe('QaPromotionService.getStatus', () => {
  it('404s when the project is not visible', async () => {
    const { service } = makeService({
      access: makeAccess({
        findVisibleProject: jest.fn().mockResolvedValue(null),
      }),
    });

    await expect(service.getStatus('project-1', actor)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('reports eligible: true and canMerge: true for a lead when every checklist is approved on the current head', async () => {
    const { service } = makeService();

    const status = await service.getStatus('project-1', actor);

    expect(status.qaBranch).toBe('uat');
    expect(status.targetBranch).toBe('main');
    expect(status.headSha).toBe(SHA);
    expect(status.eligible).toBe(true);
    expect(status.reasons).toEqual([]);
    expect(status.canMerge).toBe(true);
    expect(status.checklists).toEqual([
      {
        id: 'checklist-1',
        name: 'Release checklist',
        runId: 'run-1',
        verdict: 'APPROVED',
        runStatus: 'signed_off',
        approvedForHead: true,
      },
    ]);
    expect(status.pullRequest).toEqual({
      number: 42,
      url: 'https://github.com/org/repo/pull/42',
      headSha: SHA,
    });
  });

  it('canMerge is false for a qa-role caller even though the gate itself is eligible', async () => {
    const { service } = makeService({
      access: makeAccess({ findAppRole: jest.fn().mockResolvedValue('qa') }),
    });

    const status = await service.getStatus('project-1', actor);

    expect(status.eligible).toBe(true);
    expect(status.canMerge).toBe(false);
  });

  it('headSha null and no pull request when the branch head cannot be read (no usable token)', async () => {
    const { service } = makeService({
      github: makeGithub({
        getInstallationAccessTokenForUserRepo: jest
          .fn()
          .mockResolvedValue(null),
      }),
      access: makeAccess(),
    });
    const noTokenActor: QaRunActorContext = { ...actor, oauthToken: null };

    const status = await service.getStatus('project-1', noTokenActor);

    expect(status.headSha).toBeNull();
    expect(status.eligible).toBe(false);
    expect(status.reasons).toContain('Could not read the uat branch head');
    expect(status.pullRequest).toBeNull();
  });

  it('pullRequest is null when there is no open uat->main pull request', async () => {
    const { service } = makeService({
      github: makeGithub({
        findOpenPullRequest: jest.fn().mockResolvedValue(null),
      }),
    });

    const status = await service.getStatus('project-1', actor);

    expect(status.pullRequest).toBeNull();
  });
});

describe('QaPromotionService.merge — access', () => {
  it('404s when the project is not visible', async () => {
    const { service } = makeService({
      access: makeAccess({
        findVisibleProject: jest.fn().mockResolvedValue(null),
      }),
    });

    await expect(service.merge('project-1', actor)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('403s for a qa-role caller (not lead|admin), without recomputing the gate', async () => {
    const checklists = makeChecklistsRepository();
    const { service } = makeService({
      access: makeAccess({ findAppRole: jest.fn().mockResolvedValue('qa') }),
      checklists,
    });

    await expect(service.merge('project-1', actor)).rejects.toThrow(
      ForbiddenException,
    );
    expect(checklists.listByProject).not.toHaveBeenCalled();
  });

  it('403s for a member-role caller', async () => {
    const { service } = makeService({
      access: makeAccess({
        findAppRole: jest.fn().mockResolvedValue('member'),
      }),
    });

    await expect(service.merge('project-1', actor)).rejects.toThrow(
      ForbiddenException,
    );
  });
});

describe('QaPromotionService.merge — gate recheck', () => {
  it('409s with QA_PROMOTION_BLOCKED and the gate reasons when not eligible', async () => {
    const { service } = makeService({
      runs: makeRunsRepository({
        findRunByKey: jest.fn().mockResolvedValue(null),
      }),
    });

    await expect(service.merge('project-1', actor)).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'QA_PROMOTION_BLOCKED',
        reasons: [`"Release checklist": no QA run on uat @ ${SHA.slice(0, 7)}`],
      }),
    });
  });
});

describe('QaPromotionService.merge — GITHUB_REAUTH', () => {
  it('409s with GITHUB_REAUTH when the session has no GitHub token, without calling GitHub to merge', async () => {
    const github = makeGithub();
    const { service } = makeService({ github });
    const noTokenActor: QaRunActorContext = { ...actor, oauthToken: null };

    await expect(
      service.merge('project-1', noTokenActor),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'GITHUB_REAUTH' }),
    });
    expect(github.mergePullRequest).not.toHaveBeenCalled();
    expect(github.openPullRequest).not.toHaveBeenCalled();
  });
});

describe('QaPromotionService.merge — pull request resolution', () => {
  it('reuses the existing open pull request rather than creating one', async () => {
    const github = makeGithub();
    const { service } = makeService({ github });

    const result = await service.merge('project-1', actor);

    expect(github.openPullRequest).not.toHaveBeenCalled();
    expect(github.mergePullRequest).toHaveBeenCalledWith(
      'gho_actor_token',
      'org/repo',
      42,
      { method: 'merge', sha: SHA },
    );
    expect(result.pullRequest).toEqual({
      number: 42,
      url: 'https://github.com/org/repo/pull/42',
    });
  });

  it('creates a pull request with the user token when none is open, then merges it', async () => {
    const github = makeGithub({
      findOpenPullRequest: jest.fn().mockResolvedValue(null),
    });
    const { service } = makeService({ github });

    const result = await service.merge('project-1', actor);

    expect(github.openPullRequest).toHaveBeenCalledWith(
      'gho_actor_token',
      'org/repo',
      expect.objectContaining({
        title: 'Promote uat to main',
        head: 'uat',
        base: 'main',
        body: expect.stringContaining('Release checklist'),
      }),
    );
    expect(github.mergePullRequest).toHaveBeenCalledWith(
      'gho_actor_token',
      'org/repo',
      42,
      { method: 'merge', sha: SHA },
    );
    expect(result.merged).toBe(true);
  });

  it("returns merged:false with GitHub's message and no pull request when creation is refused", async () => {
    const github = makeGithub({
      findOpenPullRequest: jest.fn().mockResolvedValue(null),
      openPullRequest: jest.fn().mockResolvedValue({
        created: false,
        message: 'No commits between main and uat.',
      }),
    });
    const { service } = makeService({ github });

    const result = await service.merge('project-1', actor);

    expect(result).toEqual({
      merged: false,
      sha: null,
      message: 'No commits between main and uat.',
      pullRequest: null,
    });
    expect(github.mergePullRequest).not.toHaveBeenCalled();
  });

  it('409s with QA_UAT_MOVED when the existing pull request head differs from the checked headSha', async () => {
    const github = makeGithub({
      getPullRequest: jest
        .fn()
        .mockResolvedValue(pullRequestDetail({ headSha: 'f'.repeat(40) })),
    });
    const { service } = makeService({ github });

    await expect(service.merge('project-1', actor)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'QA_UAT_MOVED' }),
    });
    expect(github.mergePullRequest).not.toHaveBeenCalled();
  });
});

describe('QaPromotionService.merge — GitHub refusal passthrough', () => {
  it("returns merged:false with GitHub's own refusal text (e.g. required reviews), not an exception", async () => {
    const github = makeGithub({
      mergePullRequest: jest.fn().mockResolvedValue({
        merged: false,
        message:
          'At least 1 approving review is required by reviewers with write access.',
        sha: null,
      }),
    });
    const { service, audit, notifications } = makeService({ github });

    const result = await service.merge('project-1', actor);

    expect(result).toEqual({
      merged: false,
      sha: null,
      message:
        'At least 1 approving review is required by reviewers with write access.',
      pullRequest: { number: 42, url: 'https://github.com/org/repo/pull/42' },
    });
    expect(audit.recordProjectEvent).not.toHaveBeenCalled();
    expect(notifications.record).not.toHaveBeenCalled();
  });
});

describe('QaPromotionService.merge — success', () => {
  it('records the qa.promotion.merged audit event and notifies workspace leads, excluding the actor', async () => {
    const { service, access, audit, notifications } = makeService({
      access: makeAccess({
        findAppRole: jest.fn().mockResolvedValue('lead'),
        listWorkspaceLeadIds: jest
          .fn()
          .mockResolvedValue(['lead-1', 'lead-2', 'lead-3']),
      }),
    });

    const result = await service.merge('project-1', actor);

    expect(result.merged).toBe(true);
    expect(result.sha).toBe('merged-sha');
    expect(audit.recordProjectEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'workspace-1',
        projectId: 'project-1',
        actorUserId: 'lead-1',
        eventCode: 'qa.promotion.merged',
      }),
    );
    // lead-1 is the actor and must be excluded.
    expect(notifications.record).toHaveBeenCalledTimes(2);
    const notifiedUserIds = notifications.record.mock.calls
      .map((call) => call[0].userId)
      .sort();
    expect(notifiedUserIds).toEqual(['lead-2', 'lead-3']);
    expect(access.listWorkspaceLeadIds).toHaveBeenCalledWith('workspace-1');
  });

  it('sends no notifications when the only lead is the actor', async () => {
    const { service, notifications } = makeService({
      access: makeAccess({
        findAppRole: jest.fn().mockResolvedValue('lead'),
        listWorkspaceLeadIds: jest.fn().mockResolvedValue(['lead-1']),
      }),
    });

    await service.merge('project-1', actor);

    expect(notifications.record).not.toHaveBeenCalled();
  });
});
