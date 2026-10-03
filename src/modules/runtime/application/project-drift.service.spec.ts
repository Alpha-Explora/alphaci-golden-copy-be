import { ProjectDriftService } from './project-drift.service';

describe('ProjectDriftService', () => {
  const projectReference = {
    projectId: 'project-1',
    userId: 'user-1',
    repoFullName: 'tone/orders-api',
    repoUrl: 'https://github.com/tone/orders-api',
    workflowPath: '.github/workflows/00-alphaci-access.yml',
    projectOptions: { workflowFiles: [] },
  };
  const incompleteProjectReference = {
    ...projectReference,
    repoUrl: null,
    workflowPath: '',
    projectOptions: {},
  };
  const findingsRepository = {
    findActiveByProject: jest.fn(),
    replaceActiveFindings: jest.fn(),
  };
  const deploymentTargetsRepository = {
    listDeploymentTargets: jest.fn(),
  };
  const envVarsRepository = {
    listEnvMetadata: jest.fn(),
  };
  const ciTokensRepository = {
    findProjectTokenStatus: jest.fn(),
  };
  const capabilityResolver = {
    deployment: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    findingsRepository.findActiveByProject.mockResolvedValue([]);
    findingsRepository.replaceActiveFindings.mockImplementation(
      async (_projectId: string, findings: Array<{ code: string }>) =>
        findings.map((finding, index) => ({
          id: `finding-${index + 1}`,
          projectId: 'project-1',
          status: 'active',
          detectedAt: '2026-06-13T00:00:00.000Z',
          resolvedAt: null,
          ...finding,
        })),
    );
    deploymentTargetsRepository.listDeploymentTargets.mockResolvedValue([]);
    envVarsRepository.listEnvMetadata.mockResolvedValue([]);
    ciTokensRepository.findProjectTokenStatus.mockResolvedValue({
      status: 'active',
      tokenPrefix: 'aci_test',
    });
    capabilityResolver.deployment.mockReturnValue(
      new Set(['runtime.drift-detection']),
    );
  });

  function createService() {
    return new ProjectDriftService(
      findingsRepository as never,
      deploymentTargetsRepository as never,
      envVarsRepository as never,
      ciTokensRepository,
      capabilityResolver as never,
    );
  }

  it('lists active findings without running detection', async () => {
    findingsRepository.findActiveByProject.mockResolvedValueOnce([
      { id: 'finding-1', code: 'ci_token_missing' },
    ]);

    await expect(
      createService().listFindings(projectReference),
    ).resolves.toMatchObject({
      enabled: true,
      mode: 'local_snapshot',
      findings: [{ code: 'ci_token_missing' }],
    });
    expect(findingsRepository.replaceActiveFindings).not.toHaveBeenCalled();
  });

  it('returns disabled local state without calling adapters when drift detection is off', async () => {
    capabilityResolver.deployment.mockReturnValueOnce(new Set());

    await expect(
      createService().runDetection(projectReference),
    ).resolves.toEqual({
      enabled: false,
      mode: 'local_snapshot',
      findings: [],
    });
    expect(
      deploymentTargetsRepository.listDeploymentTargets,
    ).not.toHaveBeenCalled();
    expect(findingsRepository.replaceActiveFindings).not.toHaveBeenCalled();
  });

  describe('branch protection probe', () => {
    const compliant = {
      protected: true,
      pullRequestRequired: true,
      allowForcePushes: false,
      allowDeletions: false,
    };
    const unprotected = {
      protected: false,
      pullRequestRequired: false,
      allowForcePushes: true,
      allowDeletions: true,
    };
    const github = { getBranchProtectionSummary: jest.fn() };

    function serviceWithGithub() {
      return new ProjectDriftService(
        findingsRepository as never,
        deploymentTargetsRepository as never,
        envVarsRepository as never,
        ciTokensRepository,
        capabilityResolver as never,
        github as never,
      );
    }
    function protection(byBranch: Record<string, unknown>) {
      github.getBranchProtectionSummary.mockImplementation(
        (_t: string, _o: string, _r: string, branch: string) =>
          Promise.resolve(byBranch[branch]),
      );
    }
    async function branchCodes(token: string | null = 'gh-token') {
      const response = await serviceWithGithub().runDetection(
        projectReference,
        { githubAccessToken: token },
      );
      return response.findings
        .filter((finding) => finding.source === 'github_live')
        .map(
          (finding) => `${finding.code}:${String(finding.details['branch'])}`,
        );
    }

    it('reports nothing when dev, uat and main all require pull requests', async () => {
      protection({ dev: compliant, uat: compliant, main: compliant });

      await expect(branchCodes()).resolves.toEqual([]);
    });

    it('flags a dev branch that accepts direct pushes', async () => {
      protection({ dev: unprotected, uat: compliant, main: compliant });

      await expect(branchCodes()).resolves.toEqual([
        'branch_protection_missing:dev',
        'branch_force_push_allowed:dev',
        'branch_deletion_allowed:dev',
      ]);
    });

    it('flags uat and main that are unprotected', async () => {
      protection({ dev: compliant, uat: unprotected, main: unprotected });

      await expect(branchCodes()).resolves.toEqual([
        'branch_protection_missing:uat',
        'branch_force_push_allowed:uat',
        'branch_deletion_allowed:uat',
        'branch_protection_missing:main',
        'branch_force_push_allowed:main',
        'branch_deletion_allowed:main',
      ]);
    });

    it('flags force push and deletion allowed on an otherwise protected branch', async () => {
      protection({
        dev: compliant,
        uat: compliant,
        main: { ...compliant, allowForcePushes: true, allowDeletions: true },
      });

      await expect(branchCodes()).resolves.toEqual([
        'branch_force_push_allowed:main',
        'branch_deletion_allowed:main',
      ]);
    });

    it('reports nothing for a branch whose protection could not be read', async () => {
      protection({ dev: null, uat: null, main: null });

      await expect(branchCodes()).resolves.toEqual([]);
    });

    it('skips the live probe without a token, and never writes protection', async () => {
      protection({ dev: unprotected, uat: unprotected, main: unprotected });

      await expect(branchCodes(null)).resolves.toEqual([]);
      expect(github.getBranchProtectionSummary).not.toHaveBeenCalled();
    });

    it('marks these findings as live GitHub reads', async () => {
      protection({ dev: compliant, uat: unprotected, main: compliant });
      const response = await serviceWithGithub().runDetection(
        projectReference,
        { githubAccessToken: 'gh-token' },
      );

      expect(response.findings).toContainEqual(
        expect.objectContaining({
          code: 'branch_protection_missing',
          source: 'github_live',
          severity: 'error',
          details: { branch: 'uat', repoFullName: 'tone/orders-api' },
        }),
      );
    });
  });

  it('produces stable local findings without live provider calls', async () => {
    ciTokensRepository.findProjectTokenStatus.mockResolvedValueOnce(null);
    deploymentTargetsRepository.listDeploymentTargets.mockResolvedValueOnce([
      {
        id: 'target-1',
        provider: 'render',
        ownershipMode: 'byo',
        providerConnectionId: null,
        providerProjectId: '',
        providerProjectName: '',
        branchName: '',
      },
    ]);
    envVarsRepository.listEnvMetadata.mockResolvedValueOnce([
      {
        deploymentTargetId: 'target-1',
        key: 'DATABASE_URL',
        environment: 'test',
        status: 'failed',
      },
    ]);

    const response = await createService().runDetection(
      incompleteProjectReference,
    );
    const codes = response.findings.map((finding) => finding.code);

    expect(codes).toEqual(
      expect.arrayContaining([
        'project_repo_metadata_missing',
        'workflow_files_missing',
        'ci_token_missing',
        'branch_metadata_missing',
        'deployment_target_metadata_missing',
        'provider_connection_metadata_unavailable',
        'provider_env_key_failed',
      ]),
    );
    expect(findingsRepository.replaceActiveFindings).toHaveBeenCalledWith(
      'project-1',
      expect.arrayContaining([
        expect.objectContaining({ code: 'deployment_target_metadata_missing' }),
      ]),
    );
  });
});
