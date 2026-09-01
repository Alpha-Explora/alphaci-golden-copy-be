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
  const configService = {
    getOrThrow: jest.fn(),
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
    configService.getOrThrow.mockReturnValue({
      driftDetection: { enabled: true },
    });
  });

  function createService() {
    return new ProjectDriftService(
      findingsRepository as never,
      deploymentTargetsRepository as never,
      envVarsRepository as never,
      ciTokensRepository,
      configService as never,
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
    configService.getOrThrow.mockReturnValueOnce({
      driftDetection: { enabled: false },
    });

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
