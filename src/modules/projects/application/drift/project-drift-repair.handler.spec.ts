import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';

import { ProjectDriftRepairService } from './project-drift-repair.handler';

describe('ProjectDriftRepairService', () => {
  const projectsRepository = {
    findByIdAndUser: jest.fn(),
    findAppRole: jest.fn(),
  };
  const findingsRepository = {
    findByIdForProject: jest.fn(),
    markStatus: jest.fn(),
  };
  const ciService = {
    issueProjectToken: jest.fn(),
  };
  const deploymentTargetsRepository = {
    deleteDeploymentTargetForUser: jest.fn(),
  };
  const projectWorkflowsService = {
    previewWorkflowSettings: jest.fn(),
    createWorkflowUpdatePullRequest: jest.fn(),
  };
  const capabilityResolver = {
    deployment: jest.fn(),
  };
  const auditEventsService = {
    recordProjectEvent: jest.fn(),
  };
  const notificationEventsService = {
    record: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    projectsRepository.findAppRole.mockResolvedValue('lead');
    projectsRepository.findByIdAndUser.mockResolvedValue({
      id: 'project-1',
      repo_full_name: 'tone/orders-api',
    });
    findingsRepository.findByIdForProject.mockResolvedValue({
      id: 'finding-1',
      projectId: 'project-1',
      targetId: null,
      source: 'local_snapshot',
      severity: 'error',
      code: 'ci_token_missing',
      message: 'No token',
      details: {},
      status: 'active',
      detectedAt: '2026-06-13T00:00:00.000Z',
      resolvedAt: null,
    });
    ciService.issueProjectToken.mockResolvedValue({
      token: 'aci_secret_raw_token',
      tokenPrefix: 'aci_prefix',
    });
    deploymentTargetsRepository.deleteDeploymentTargetForUser.mockResolvedValue(
      true,
    );
    projectWorkflowsService.previewWorkflowSettings.mockResolvedValue({
      workflowFiles: [{ path: '.github/workflows/00-alphaci-access.yml' }],
      validationWarnings: [],
    });
    projectWorkflowsService.createWorkflowUpdatePullRequest.mockResolvedValue({
      pullRequestNumber: 42,
      pullRequestUrl: 'https://github.com/tone/orders-api/pull/42',
    });
    capabilityResolver.deployment.mockReturnValue(
      new Set(['runtime.drift-repair', 'projects.workflow-update-pr']),
    );
  });

  function createService() {
    return new ProjectDriftRepairService(
      projectsRepository as never,
      findingsRepository as never,
      ciService,
      deploymentTargetsRepository,
      projectWorkflowsService as never,
      auditEventsService as never,
      notificationEventsService as never,
      capabilityResolver as never,
    );
  }

  describe('repair_branch_protection', () => {
    const githubService = {
      ensurePullRequestProtection: jest
        .fn()
        .mockResolvedValue({ status: 'applied' }),
    };
    const branchFinding = (overrides: Record<string, unknown> = {}) => ({
      id: 'finding-bp',
      projectId: 'project-1',
      targetId: null,
      source: 'github_live',
      severity: 'error',
      code: 'branch_protection_missing',
      message: 'uat unprotected',
      details: { branch: 'uat', repoFullName: 'tone/orders-api' },
      status: 'active',
      detectedAt: '2026-06-13T00:00:00.000Z',
      resolvedAt: null,
      ...overrides,
    });
    function serviceWithGithub() {
      return new ProjectDriftRepairService(
        { ...projectsRepository, findAppRole } as never,
        findingsRepository as never,
        ciService,
        deploymentTargetsRepository,
        projectWorkflowsService as never,
        auditEventsService as never,
        notificationEventsService as never,
        capabilityResolver as never,
        githubService as never,
      );
    }
    const findAppRole = jest.fn();
    const repairAs = (role: string, token: string | null = 'gh-token') => {
      findAppRole.mockResolvedValue(role);
      return serviceWithGithub().repair(
        'project-1',
        'finding-bp',
        'user-1',
        'repair_branch_protection',
        token,
      );
    };

    beforeEach(() => {
      findingsRepository.findByIdForProject.mockResolvedValue(branchFinding());
    });

    it.each(['lead', 'admin'])('re-applies protection for %s', async (role) => {
      await expect(repairAs(role)).resolves.toMatchObject({
        status: 'completed',
        result: { branch: 'uat' },
      });
      expect(githubService.ensurePullRequestProtection).toHaveBeenCalledWith(
        'gh-token',
        'tone',
        'orders-api',
        'uat',
      );
      expect(findingsRepository.markStatus).toHaveBeenCalledWith(
        'finding-bp',
        'resolved',
      );
    });

    it.each(['member', 'qa'])(
      'refuses %s and never touches GitHub',
      async (role) => {
        await expect(repairAs(role)).rejects.toThrow(ForbiddenException);
        expect(
          githubService.ensurePullRequestProtection,
        ).not.toHaveBeenCalled();
        expect(findingsRepository.markStatus).not.toHaveBeenCalled();
      },
    );

    it('refuses a finding that is not a pipeline-branch protection finding', async () => {
      findingsRepository.findByIdForProject.mockResolvedValue(
        branchFinding({ code: 'branch_dev_protected_legacy' }),
      );

      await expect(repairAs('lead')).rejects.toThrow(
        'does not support finding',
      );
      expect(githubService.ensurePullRequestProtection).not.toHaveBeenCalled();
    });

    it('repairs dev too: every pipeline branch needs a pull request', async () => {
      findingsRepository.findByIdForProject.mockResolvedValue(
        branchFinding({ details: { branch: 'dev' } }),
      );

      await expect(repairAs('lead')).resolves.toMatchObject({
        status: 'completed',
        result: { branch: 'dev' },
      });
      expect(githubService.ensurePullRequestProtection).toHaveBeenCalledWith(
        'gh-token',
        'tone',
        'orders-api',
        'dev',
      );
    });

    it('refuses a branch outside the pipeline', async () => {
      findingsRepository.findByIdForProject.mockResolvedValue(
        branchFinding({ details: { branch: 'feature/x' } }),
      );

      await expect(repairAs('lead')).rejects.toThrow(BadRequestException);
      expect(githubService.ensurePullRequestProtection).not.toHaveBeenCalled();
    });

    it('does not resolve the finding when GitHub refuses the rule', async () => {
      githubService.ensurePullRequestProtection.mockResolvedValueOnce({
        status: 'failed',
        error: 'HTTP 403 on uat: the credential lacks admin permission',
      });

      await expect(repairAs('lead')).rejects.toThrow(
        'could not be applied to uat',
      );
      expect(findingsRepository.markStatus).not.toHaveBeenCalled();
    });

    it('needs a GitHub session', async () => {
      await expect(repairAs('lead', null)).rejects.toThrow(BadRequestException);
      expect(githubService.ensurePullRequestProtection).not.toHaveBeenCalled();
    });
  });

  describe('persona gate on non-protection repairs', () => {
    const lifecycleActions = [
      'mark_ignored',
      'rotate_ci_token',
      'detach_target',
    ] as const;
    const prActions = [
      'regenerate_workflow_preview',
      'create_workflow_update_pr',
    ] as const;

    it.each(
      ['member', 'qa'].flatMap((role) =>
        lifecycleActions.map((action) => [role, action] as const),
      ),
    )(
      '%s is refused %s with PROJECT_ROLE_FORBIDDEN and nothing is changed',
      async (role, action) => {
        projectsRepository.findAppRole.mockResolvedValue(role);
        const error = await createService()
          .repair('project-1', 'finding-1', 'user-1', action, null)
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ForbiddenException);
        expect((error as ForbiddenException).getResponse()).toMatchObject({
          code: 'PROJECT_ROLE_FORBIDDEN',
        });
        expect(findingsRepository.markStatus).not.toHaveBeenCalled();
        expect(ciService.issueProjectToken).not.toHaveBeenCalled();
        expect(
          deploymentTargetsRepository.deleteDeploymentTargetForUser,
        ).not.toHaveBeenCalled();
      },
    );

    it.each(prActions)('qa is refused %s', async (action) => {
      projectsRepository.findAppRole.mockResolvedValue('qa');
      findingsRepository.findByIdForProject.mockResolvedValueOnce({
        id: 'finding-1',
        projectId: 'project-1',
        targetId: null,
        code: 'workflow_files_missing',
        details: {},
        status: 'active',
        message: 'x',
      });
      await expect(
        createService().repair('project-1', 'finding-1', 'user-1', action, 't'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(
        projectWorkflowsService.createWorkflowUpdatePullRequest,
      ).not.toHaveBeenCalled();
      expect(
        projectWorkflowsService.previewWorkflowSettings,
      ).not.toHaveBeenCalled();
    });

    it('fails closed when the role is unresolvable', async () => {
      projectsRepository.findAppRole.mockResolvedValue(undefined);
      await expect(
        createService().repair(
          'project-1',
          'finding-1',
          'user-1',
          'rotate_ci_token',
          null,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('a project the caller cannot see is a 404 before the role is read', async () => {
      projectsRepository.findByIdAndUser.mockResolvedValueOnce(null);
      await expect(
        createService().repair(
          'project-1',
          'finding-1',
          'user-1',
          'rotate_ci_token',
          null,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(projectsRepository.findAppRole).not.toHaveBeenCalled();
    });
  });

  it('rotates a CI token without returning the raw token value', async () => {
    const response = await createService().repair(
      'project-1',
      'finding-1',
      'user-1',
      'rotate_ci_token',
      null,
    );

    expect(ciService.issueProjectToken).toHaveBeenCalledWith('project-1');
    expect(findingsRepository.markStatus).toHaveBeenCalledWith(
      'finding-1',
      'resolved',
    );
    expect(JSON.stringify(response)).toContain('aci_prefix');
    expect(JSON.stringify(response)).not.toContain('aci_secret_raw_token');
    expect(auditEventsService.recordProjectEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: 'user-1',
        projectId: 'project-1',
        eventCode: 'ci_token_rotated',
      }),
    );
    expect(notificationEventsService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        projectId: 'project-1',
        eventCode: 'ci_token_rotated',
      }),
    );
  });

  it('detaches a target from ALPHACI without deleting provider resources', async () => {
    findingsRepository.findByIdForProject.mockResolvedValueOnce({
      id: 'finding-2',
      projectId: 'project-1',
      targetId: 'target-1',
      source: 'local_snapshot',
      severity: 'error',
      code: 'deployment_target_metadata_missing',
      message: 'Bad target',
      details: {},
      status: 'active',
      detectedAt: '2026-06-13T00:00:00.000Z',
      resolvedAt: null,
    });

    await expect(
      createService().repair(
        'project-1',
        'finding-2',
        'user-1',
        'detach_target',
        null,
      ),
    ).resolves.toMatchObject({
      status: 'completed',
      result: { targetId: 'target-1' },
    });
    expect(
      deploymentTargetsRepository.deleteDeploymentTargetForUser,
    ).toHaveBeenCalledWith('project-1', 'target-1', 'user-1');
    expect(auditEventsService.recordProjectEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: 'user-1',
        projectId: 'project-1',
        eventCode: 'drift_repair_completed',
      }),
    );
  });

  it('returns disabled state for live provider repairs', async () => {
    findingsRepository.findByIdForProject.mockResolvedValueOnce({
      id: 'finding-3',
      projectId: 'project-1',
      targetId: 'target-1',
      source: 'local_snapshot',
      severity: 'error',
      code: 'provider_target_missing_live',
      message: 'Provider target missing',
      details: {},
      status: 'active',
      detectedAt: '2026-06-13T00:00:00.000Z',
      resolvedAt: null,
    });

    await expect(
      createService().repair(
        'project-1',
        'finding-3',
        'user-1',
        'detach_target',
        null,
      ),
    ).resolves.toMatchObject({
      enabled: false,
      status: 'disabled',
      message: 'Live provider activation required',
    });
    expect(
      deploymentTargetsRepository.deleteDeploymentTargetForUser,
    ).not.toHaveBeenCalled();
  });

  it('rejects repair for inactive findings', async () => {
    findingsRepository.findByIdForProject.mockResolvedValueOnce({
      id: 'finding-4',
      projectId: 'project-1',
      targetId: null,
      source: 'local_snapshot',
      severity: 'warning',
      code: 'workflow_files_missing',
      message: 'No workflow',
      details: {},
      status: 'resolved',
      detectedAt: '2026-06-13T00:00:00.000Z',
      resolvedAt: '2026-06-13T00:10:00.000Z',
    });

    await expect(
      createService().repair(
        'project-1',
        'finding-4',
        'user-1',
        'regenerate_workflow_preview',
        null,
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('throws when project is not owned by the user', async () => {
    projectsRepository.findByIdAndUser.mockResolvedValueOnce(null);

    await expect(
      createService().repair(
        'project-1',
        'finding-1',
        'user-2',
        'mark_ignored',
        null,
      ),
    ).rejects.toThrow(NotFoundException);
  });

  it('returns disabled state when drift repair is disabled', async () => {
    capabilityResolver.deployment.mockReturnValueOnce(new Set());

    await expect(
      createService().repair(
        'project-1',
        'finding-1',
        'user-1',
        'mark_ignored',
        null,
      ),
    ).resolves.toMatchObject({
      enabled: false,
      status: 'disabled',
      message: 'Drift repair is disabled',
    });
  });

  it('throws when the finding does not exist for the project', async () => {
    findingsRepository.findByIdForProject.mockResolvedValueOnce(null);

    await expect(
      createService().repair(
        'project-1',
        'finding-1',
        'user-1',
        'mark_ignored',
        null,
      ),
    ).rejects.toThrow('Drift finding not found');
  });

  it('marks active findings ignored', async () => {
    await expect(
      createService().repair(
        'project-1',
        'finding-1',
        'user-1',
        'mark_ignored',
        null,
      ),
    ).resolves.toMatchObject({
      action: 'mark_ignored',
      status: 'completed',
      message: 'Finding marked ignored',
    });
    expect(findingsRepository.markStatus).toHaveBeenCalledWith(
      'finding-1',
      'ignored',
    );
  });

  it('rejects unsupported repair action and finding code combinations', async () => {
    await expect(
      createService().repair(
        'project-1',
        'finding-1',
        'user-1',
        'detach_target',
        null,
      ),
    ).rejects.toThrow('does not support finding');
  });

  it('throws when detaching a target finding without a target id', async () => {
    findingsRepository.findByIdForProject.mockResolvedValueOnce({
      id: 'finding-2',
      projectId: 'project-1',
      targetId: null,
      source: 'local_snapshot',
      severity: 'error',
      code: 'deployment_target_metadata_missing',
      message: 'Bad target',
      details: {},
      status: 'active',
      detectedAt: '2026-06-13T00:00:00.000Z',
      resolvedAt: null,
    });

    await expect(
      createService().repair(
        'project-1',
        'finding-2',
        'user-1',
        'detach_target',
        null,
      ),
    ).rejects.toThrow('Finding is not associated with a target');
  });

  it('regenerates workflow previews for workflow findings', async () => {
    findingsRepository.findByIdForProject.mockResolvedValueOnce({
      id: 'finding-5',
      projectId: 'project-1',
      targetId: null,
      source: 'local_snapshot',
      severity: 'warning',
      code: 'workflow_files_missing',
      message: 'No workflow',
      details: {},
      status: 'active',
      detectedAt: '2026-06-13T00:00:00.000Z',
      resolvedAt: null,
    });

    await expect(
      createService().repair(
        'project-1',
        'finding-5',
        'user-1',
        'regenerate_workflow_preview',
        null,
      ),
    ).resolves.toMatchObject({
      status: 'completed',
      result: {
        workflowFiles: [{ path: '.github/workflows/00-alphaci-access.yml' }],
      },
    });
  });

  it('returns disabled state when workflow update PR creation is disabled', async () => {
    findingsRepository.findByIdForProject.mockResolvedValueOnce({
      id: 'finding-6',
      projectId: 'project-1',
      targetId: null,
      source: 'local_snapshot',
      severity: 'warning',
      code: 'central_workflow_ref_outdated',
      message: 'Ref outdated',
      details: {},
      status: 'active',
      detectedAt: '2026-06-13T00:00:00.000Z',
      resolvedAt: null,
    });
    capabilityResolver.deployment.mockReturnValue(
      new Set(['runtime.drift-repair']),
    );

    await expect(
      createService().repair(
        'project-1',
        'finding-6',
        'user-1',
        'create_workflow_update_pr',
        null,
      ),
    ).resolves.toMatchObject({
      enabled: false,
      status: 'disabled',
      message: 'Workflow update PR creation is disabled',
    });
  });

  it('creates workflow update PRs and resolves the finding', async () => {
    findingsRepository.findByIdForProject.mockResolvedValueOnce({
      id: 'finding-7',
      projectId: 'project-1',
      targetId: null,
      source: 'local_snapshot',
      severity: 'warning',
      code: 'central_workflow_ref_outdated',
      message: 'Ref outdated',
      details: {},
      status: 'active',
      detectedAt: '2026-06-13T00:00:00.000Z',
      resolvedAt: null,
    });

    await expect(
      createService().repair(
        'project-1',
        'finding-7',
        'user-1',
        'create_workflow_update_pr',
        'gh-token',
      ),
    ).resolves.toMatchObject({
      status: 'completed',
      result: {
        pullRequestNumber: 42,
        pullRequestUrl: 'https://github.com/tone/orders-api/pull/42',
      },
    });
    expect(
      projectWorkflowsService.createWorkflowUpdatePullRequest,
    ).toHaveBeenCalledWith('project-1', 'user-1', 'gh-token', {});
    expect(findingsRepository.markStatus).toHaveBeenCalledWith(
      'finding-7',
      'resolved',
    );
  });
});
