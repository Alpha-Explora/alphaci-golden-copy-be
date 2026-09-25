import type {
  DeploymentHistoryQuery,
  DeploymentHistoryResponse,
  DeploymentProjectReference,
} from '#kernel/ports/deployment-runtime.port';
import type { GithubProjectPort } from '#kernel/ports/github.port';
import { QaCommitResolutionService } from './qa-commit-resolution.service';

const project: DeploymentProjectReference = {
  projectId: 'project-1',
  userId: 'user-1',
  repoFullName: 'org/repo',
};

const historyResponse = (
  overrides: Partial<DeploymentHistoryResponse> = {},
): DeploymentHistoryResponse => ({
  enabled: true,
  mode: 'live',
  liveProvidersEnabled: true,
  deployments: [],
  providerError: null,
  ...overrides,
});

const makeDeploymentHistory = (
  overrides: Partial<jest.Mocked<DeploymentHistoryQuery>> = {},
) =>
  ({
    listDeployments: jest.fn().mockResolvedValue(historyResponse()),
    ...overrides,
  }) as unknown as jest.Mocked<DeploymentHistoryQuery>;

const makeGithub = (overrides: Partial<jest.Mocked<GithubProjectPort>> = {}) =>
  ({
    getEnforcedOrg: jest.fn().mockReturnValue(''),
    getInstallationAccessTokenForUserRepo: jest.fn().mockResolvedValue(null),
    getOrganizationProvisioningContextByLogin: jest.fn(),
    listBranches: jest.fn().mockResolvedValue([]),
    ...overrides,
  }) as unknown as jest.Mocked<GithubProjectPort>;

describe('QaCommitResolutionService — resolution order', () => {
  it('prefers the newest READY deployment of the branch that has a commitSha', async () => {
    const deploymentHistory = makeDeploymentHistory({
      listDeployments: jest.fn().mockResolvedValue(
        historyResponse({
          deployments: [
            {
              id: 'd-old',
              targetId: 't-1',
              targetName: 'backend',
              provider: 'render',
              slot: 'backend',
              environment: 'preview',
              branch: 'main',
              commitSha: 'a'.repeat(40),
              commitMessage: null,
              createdBy: null,
              status: 'ready',
              createdAt: '2026-09-20T00:00:00.000Z',
              readyAt: '2026-09-20T00:05:00.000Z',
              deploymentUrl: null,
              pullRequestNumber: null,
              inspectorUrl: null,
              dashboardUrl: '',
              consoleUrl: '',
            },
            {
              id: 'd-new',
              targetId: 't-1',
              targetName: 'backend',
              provider: 'render',
              slot: 'backend',
              environment: 'preview',
              branch: 'main',
              commitSha: 'b'.repeat(40),
              commitMessage: null,
              createdBy: null,
              status: 'ready',
              createdAt: '2026-09-24T00:00:00.000Z',
              readyAt: '2026-09-24T00:05:00.000Z',
              deploymentUrl: null,
              pullRequestNumber: null,
              inspectorUrl: null,
              dashboardUrl: '',
              consoleUrl: '',
            },
          ],
        }),
      ),
    });
    const github = makeGithub();
    const service = new QaCommitResolutionService(deploymentHistory, github);

    const result = await service.resolve(project, 'main', null);

    expect(result).toEqual({
      commitSha: 'b'.repeat(40),
      commitSource: 'deployment',
    });
    expect(github.listBranches).not.toHaveBeenCalled();
  });

  it('ignores a deployment that is not ready or has no commitSha', async () => {
    const deploymentHistory = makeDeploymentHistory({
      listDeployments: jest.fn().mockResolvedValue(
        historyResponse({
          deployments: [
            {
              id: 'd-building',
              targetId: 't-1',
              targetName: 'backend',
              provider: 'render',
              slot: 'backend',
              environment: 'preview',
              branch: 'main',
              commitSha: 'a'.repeat(40),
              commitMessage: null,
              createdBy: null,
              status: 'building',
              createdAt: '2026-09-24T00:00:00.000Z',
              readyAt: null,
              deploymentUrl: null,
              pullRequestNumber: null,
              inspectorUrl: null,
              dashboardUrl: '',
              consoleUrl: '',
            },
          ],
        }),
      ),
    });
    const github = makeGithub({
      listBranches: jest
        .fn()
        .mockResolvedValue([
          { name: 'main', protected: true, commitSha: 'c'.repeat(40) },
        ]),
      getInstallationAccessTokenForUserRepo: jest
        .fn()
        .mockResolvedValue('installation-token'),
    });
    const service = new QaCommitResolutionService(deploymentHistory, github);

    const result = await service.resolve(project, 'main', null);

    expect(result).toEqual({
      commitSha: 'c'.repeat(40),
      commitSource: 'branch_head',
    });
  });

  it('falls back to the GitHub branch head when no ready deployment exists', async () => {
    const deploymentHistory = makeDeploymentHistory();
    const github = makeGithub({
      getInstallationAccessTokenForUserRepo: jest
        .fn()
        .mockResolvedValue('installation-token'),
      listBranches: jest.fn().mockResolvedValue([
        { name: 'other', protected: false, commitSha: 'd'.repeat(40) },
        { name: 'main', protected: true, commitSha: 'e'.repeat(40) },
      ]),
    });
    const service = new QaCommitResolutionService(deploymentHistory, github);

    const result = await service.resolve(project, 'main', null);

    expect(result).toEqual({
      commitSha: 'e'.repeat(40),
      commitSource: 'branch_head',
    });
    expect(github.getInstallationAccessTokenForUserRepo).toHaveBeenCalledWith(
      'user-1',
      'org/repo',
    );
  });

  it('falls back to the caller OAuth token when no installation token is available', async () => {
    const deploymentHistory = makeDeploymentHistory();
    const github = makeGithub({
      listBranches: jest
        .fn()
        .mockResolvedValue([
          { name: 'main', protected: true, commitSha: 'f'.repeat(40) },
        ]),
    });
    const service = new QaCommitResolutionService(deploymentHistory, github);

    const result = await service.resolve(project, 'main', 'oauth-token');

    expect(result).toEqual({
      commitSha: 'f'.repeat(40),
      commitSource: 'branch_head',
    });
    expect(github.listBranches).toHaveBeenCalledWith('oauth-token', 'org/repo');
  });

  it('prefers the enforced-org installation token when the repo belongs to that org', async () => {
    const deploymentHistory = makeDeploymentHistory();
    const github = makeGithub({
      getEnforcedOrg: jest.fn().mockReturnValue('org'),
      getOrganizationProvisioningContextByLogin: jest.fn().mockResolvedValue({
        accessToken: 'enforced-token',
        ownerLogin: 'org',
      }),
      listBranches: jest
        .fn()
        .mockResolvedValue([
          { name: 'main', protected: true, commitSha: 'g'.repeat(40) },
        ]),
    });
    const service = new QaCommitResolutionService(deploymentHistory, github);

    await service.resolve(project, 'main', 'oauth-token');

    expect(github.listBranches).toHaveBeenCalledWith(
      'enforced-token',
      'org/repo',
    );
    expect(github.getInstallationAccessTokenForUserRepo).not.toHaveBeenCalled();
  });

  it('returns null (never throws) when neither a deployment nor a branch head can be found', async () => {
    const deploymentHistory = makeDeploymentHistory();
    const github = makeGithub({
      listBranches: jest.fn().mockResolvedValue([]),
    });
    const service = new QaCommitResolutionService(deploymentHistory, github);

    const result = await service.resolve(project, 'main', 'oauth-token');

    expect(result).toBeNull();
  });

  it('returns null when no token is resolvable at all (never calls listBranches)', async () => {
    const deploymentHistory = makeDeploymentHistory();
    const github = makeGithub();
    const service = new QaCommitResolutionService(deploymentHistory, github);

    const result = await service.resolve(project, 'main', null);

    expect(result).toBeNull();
    expect(github.listBranches).not.toHaveBeenCalled();
  });
});
