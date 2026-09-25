import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';

import type { AuditEventPublisher } from '#kernel/events/platform-event-publisher.js';
import type {
  GitHubBranchSummary,
  GithubProjectPort,
} from '#kernel/ports/github.port';
import type { PlatformAppRole } from '#kernel/ports/platform-admin.port';
import type { ProvisionedProjectRow } from '../../infrastructure/projects.repository';
import type {
  QaRunsRepository,
  QaVerificationRunRow,
} from '../../infrastructure/qa-runs.repository';
import type { QaAccessService } from '../qa-checklists/qa-access.service';
import { QaAutomationDispatchService } from './qa-automation-dispatch.service';
import type { QaRunActorContext } from './qa-runs.service';

const projectRow = (
  overrides: Partial<ProvisionedProjectRow> = {},
): ProvisionedProjectRow => ({
  id: 'project-1',
  user_id: 'owner-1',
  repo_full_name: 'org/repo',
  template_id: 'be-nestjs',
  service_name: 'api',
  workflow_path: '.github/workflows/00-alphaci-access.yml',
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

const branch = (
  overrides: Partial<GitHubBranchSummary> = {},
): GitHubBranchSummary => ({
  name: 'main',
  protected: false,
  commitSha: 'a'.repeat(40),
  ...overrides,
});

const makeAccess = (
  overrides: Partial<jest.Mocked<QaAccessService>> = {},
): jest.Mocked<QaAccessService> =>
  ({
    findVisibleProject: jest.fn().mockResolvedValue(projectRow()),
    findAppRole: jest.fn().mockResolvedValue('qa' as PlatformAppRole),
    ...overrides,
  }) as unknown as jest.Mocked<QaAccessService>;

const makeRepository = (
  overrides: Partial<jest.Mocked<QaRunsRepository>> = {},
): jest.Mocked<QaRunsRepository> =>
  ({
    findRunForProject: jest.fn().mockResolvedValue(runRow()),
    ...overrides,
  }) as unknown as jest.Mocked<QaRunsRepository>;

const makeGithub = (
  overrides: Partial<jest.Mocked<GithubProjectPort>> = {},
): jest.Mocked<GithubProjectPort> =>
  ({
    listBranches: jest.fn().mockResolvedValue([branch()]),
    dispatchWorkflow: jest.fn().mockResolvedValue({ dispatched: true }),
    ...overrides,
  }) as unknown as jest.Mocked<GithubProjectPort>;

const makeAudit = () =>
  ({
    recordProjectEvent: jest.fn(),
  }) as unknown as jest.Mocked<AuditEventPublisher>;

const actorWithToken: QaRunActorContext = {
  userId: 'user-1',
  userLogin: 'user-login',
  oauthToken: 'gho_token',
};

function makeService(
  overrides: {
    access?: jest.Mocked<QaAccessService>;
    repository?: jest.Mocked<QaRunsRepository>;
    github?: jest.Mocked<GithubProjectPort>;
    audit?: jest.Mocked<AuditEventPublisher>;
  } = {},
) {
  const access = overrides.access ?? makeAccess();
  const repository = overrides.repository ?? makeRepository();
  const github = overrides.github ?? makeGithub();
  const audit = overrides.audit ?? makeAudit();

  return {
    service: new QaAutomationDispatchService(access, repository, github, audit),
    access,
    repository,
    github,
    audit,
  };
}

describe('QaAutomationDispatchService.dispatch — visibility and role', () => {
  it('404s when the project is not visible', async () => {
    const { service } = makeService({
      access: makeAccess({
        findVisibleProject: jest.fn().mockResolvedValue(null),
      }),
    });
    await expect(
      service.dispatch('project-1', actorWithToken, 'run-1'),
    ).rejects.toThrow(NotFoundException);
  });

  it('404s when the run does not belong to the project', async () => {
    const { service } = makeService({
      repository: makeRepository({
        findRunForProject: jest.fn().mockResolvedValue(null),
      }),
    });
    await expect(
      service.dispatch('project-1', actorWithToken, 'run-1'),
    ).rejects.toThrow(NotFoundException);
  });

  it.each(['qa', 'lead', 'admin'] as const)(
    'role=%s may dispatch',
    async (role) => {
      const { service, github } = makeService({
        access: makeAccess({ findAppRole: jest.fn().mockResolvedValue(role) }),
      });
      await expect(
        service.dispatch('project-1', actorWithToken, 'run-1'),
      ).resolves.toBeDefined();
      expect(github.dispatchWorkflow).toHaveBeenCalled();
    },
  );

  it('403s a member', async () => {
    const { service, github } = makeService({
      access: makeAccess({
        findAppRole: jest.fn().mockResolvedValue('member'),
      }),
    });
    await expect(
      service.dispatch('project-1', actorWithToken, 'run-1'),
    ).rejects.toThrow(ForbiddenException);
    expect(github.dispatchWorkflow).not.toHaveBeenCalled();
  });
});

describe('QaAutomationDispatchService.dispatch — run state', () => {
  it('409s a signed-off run without calling GitHub', async () => {
    const { service, github } = makeService({
      repository: makeRepository({
        findRunForProject: jest
          .fn()
          .mockResolvedValue(runRow({ status: 'signed_off' })),
      }),
    });
    await expect(
      service.dispatch('project-1', actorWithToken, 'run-1'),
    ).rejects.toThrow(ConflictException);
    expect(github.dispatchWorkflow).not.toHaveBeenCalled();
  });
});

describe('QaAutomationDispatchService.dispatch — GITHUB_REAUTH', () => {
  it('409s with code GITHUB_REAUTH when the session has no GitHub token, without calling GitHub', async () => {
    const { service, github } = makeService();
    const actorNoToken: QaRunActorContext = {
      ...actorWithToken,
      oauthToken: null,
    };

    await expect(
      service.dispatch('project-1', actorNoToken, 'run-1'),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'GITHUB_REAUTH' }),
    });
    expect(github.listBranches).not.toHaveBeenCalled();
    expect(github.dispatchWorkflow).not.toHaveBeenCalled();
  });

  it('409s with code GITHUB_REAUTH when GitHub answers the dispatch with 401', async () => {
    const { service } = makeService({
      github: makeGithub({
        dispatchWorkflow: jest.fn().mockResolvedValue({
          dispatched: false,
          reason: 'unauthorized',
          message: 'stale token',
        }),
      }),
    });

    await expect(
      service.dispatch('project-1', actorWithToken, 'run-1'),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'GITHUB_REAUTH' }),
    });
  });
});

describe('QaAutomationDispatchService.dispatch — VERIFY_WORKFLOW_MISSING', () => {
  it('409s with code VERIFY_WORKFLOW_MISSING when GitHub answers the dispatch with 404', async () => {
    const { service } = makeService({
      github: makeGithub({
        dispatchWorkflow: jest.fn().mockResolvedValue({
          dispatched: false,
          reason: 'not_found',
          message: 'no such workflow',
        }),
      }),
    });

    await expect(
      service.dispatch('project-1', actorWithToken, 'run-1'),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'VERIFY_WORKFLOW_MISSING',
        message: "This project's pipeline has no verify workflow yet.",
      }),
    });
  });
});

describe('QaAutomationDispatchService.dispatch — 403 forbidden', () => {
  it("403s with GitHub's own message when GitHub answers the dispatch with 403", async () => {
    const { service } = makeService({
      github: makeGithub({
        dispatchWorkflow: jest.fn().mockResolvedValue({
          dispatched: false,
          reason: 'forbidden',
          message: 'Resource not accessible by integration',
        }),
      }),
    });

    await expect(
      service.dispatch('project-1', actorWithToken, 'run-1'),
    ).rejects.toThrow(ForbiddenException);
  });
});

describe('QaAutomationDispatchService.dispatch — success shape', () => {
  it('resolves the workflow file from workflow_path with no variant suffix', async () => {
    const { service, github } = makeService();
    const result = await service.dispatch('project-1', actorWithToken, 'run-1');

    expect(github.dispatchWorkflow).toHaveBeenCalledWith(
      'gho_token',
      'org/repo',
      '30-alphaci-verify.yml',
      'main',
    );
    expect(result.workflowFile).toBe('30-alphaci-verify.yml');
    expect(result.ref).toBe('main');
  });

  it('carries the microservices variant suffix from workflow_path into the verify filename', async () => {
    const { service, github } = makeService({
      access: makeAccess({
        findVisibleProject: jest.fn().mockResolvedValue(
          projectRow({
            workflow_path: '.github/workflows/00-alphaci-access-backend.yml',
          }),
        ),
      }),
    });

    await service.dispatch('project-1', actorWithToken, 'run-1');

    expect(github.dispatchWorkflow).toHaveBeenCalledWith(
      'gho_token',
      'org/repo',
      '30-alphaci-verify-backend.yml',
      'main',
    );
  });

  it('targetsRunCommit is true when the branch head equals the run commit', async () => {
    const { service } = makeService({
      repository: makeRepository({
        findRunForProject: jest
          .fn()
          .mockResolvedValue(runRow({ commit_sha: 'a'.repeat(40) })),
      }),
      github: makeGithub({
        listBranches: jest
          .fn()
          .mockResolvedValue([branch({ commitSha: 'a'.repeat(40) })]),
      }),
    });

    const result = await service.dispatch('project-1', actorWithToken, 'run-1');

    expect(result.targetsRunCommit).toBe(true);
    expect(result.headSha).toBe('a'.repeat(40));
  });

  it('targetsRunCommit is false when the branch has moved past the run commit', async () => {
    const { service } = makeService({
      repository: makeRepository({
        findRunForProject: jest
          .fn()
          .mockResolvedValue(runRow({ commit_sha: 'a'.repeat(40) })),
      }),
      github: makeGithub({
        listBranches: jest
          .fn()
          .mockResolvedValue([branch({ commitSha: 'b'.repeat(40) })]),
      }),
    });

    const result = await service.dispatch('project-1', actorWithToken, 'run-1');

    expect(result.targetsRunCommit).toBe(false);
    expect(result.headSha).toBe('b'.repeat(40));
  });

  it('records a qa.automation.dispatched audit event on success', async () => {
    const { service, audit } = makeService();

    await service.dispatch('project-1', actorWithToken, 'run-1');

    expect(audit.recordProjectEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project-1',
        actorUserId: 'user-1',
        eventCode: 'qa.automation.dispatched',
      }),
    );
  });

  it('does not record an audit event when the dispatch is refused', async () => {
    const { service, audit } = makeService({
      github: makeGithub({
        dispatchWorkflow: jest.fn().mockResolvedValue({
          dispatched: false,
          reason: 'not_found',
          message: 'no such workflow',
        }),
      }),
    });

    await expect(
      service.dispatch('project-1', actorWithToken, 'run-1'),
    ).rejects.toThrow(ConflictException);
    expect(audit.recordProjectEvent).not.toHaveBeenCalled();
  });
});
