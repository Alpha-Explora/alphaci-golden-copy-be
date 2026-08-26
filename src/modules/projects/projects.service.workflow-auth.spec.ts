import { ProjectsService } from './projects.service';
import type { CatalogService } from './application/catalog/catalog.service';
import type { CiService } from '#modules/pipelines/ci/ci.service';
import type { GithubService } from '#modules/pipelines/github/github.service';
import type { ProjectsRepository } from './projects.repository';

const stagedWorkflowFiles = [
  {
    stage: 'access' as const,
    name: 'ALPHACI Access Gate',
    path: '.github/workflows/00-alphaci-access.yml',
    gated: true,
    yaml: 'name: ALPHACI Access Gate\n',
  },
  {
    stage: 'quality' as const,
    name: 'ALPHACI Quality',
    path: '.github/workflows/10-alphaci-quality.yml',
    gated: true,
    yaml: 'name: ALPHACI Quality\n',
  },
  {
    stage: 'package' as const,
    name: 'ALPHACI Package',
    path: '.github/workflows/20-alphaci-package.yml',
    gated: true,
    yaml: 'name: ALPHACI Package\n',
  },
];

const makeCatalogService = () =>
  ({
    getProjectOptions: jest.fn().mockReturnValue({
      recipes: [
        {
          id: 'backend-api-ci',
          templateByProjectType: { 'nestjs-api': 'be-nestjs' },
        },
      ],
    }),
    getTemplateById: jest.fn().mockResolvedValue({
      id: 'be-nestjs',
      name: 'NestJS Backend',
      stack: 'nestjs',
      workflowPath: '/template.yml',
    }),
    getResolvedStarterPath: jest.fn().mockReturnValue(null),
  }) as unknown as CatalogService;

const makeGithubService = () =>
  ({
    on: jest.fn(),
    getInstallationAccessTokenForUser: jest.fn().mockResolvedValue(null),
    getInstallationOwnerLogin: jest.fn().mockResolvedValue(undefined),
    // This suite exercises workflow-file push + secret install, not org
    // enforcement; an empty enforced org keeps the OAuth token as the
    // provisioning token the assertions below expect.
    getEnforcedOrg: jest.fn().mockReturnValue(''),
    createRepo: jest.fn().mockResolvedValue({
      repoUrl: 'https://github.com/owner/repo',
      ownerLogin: 'owner',
      repoName: 'repo',
    }),
    createBranch: jest.fn().mockResolvedValue(undefined),
    applyBranchProtection: jest.fn().mockResolvedValue(undefined),
    setActionsSecret: jest.fn().mockResolvedValue(undefined),
    setActionsSecretStrict: jest.fn().mockResolvedValue(undefined),
    deleteRepo: jest.fn().mockResolvedValue(true),
  }) as unknown as GithubService;

const makeProjectsRepository = () =>
  ({
    create: jest.fn().mockResolvedValue({
      id: 'project-1',
    }),
    updateStatus: jest.fn().mockResolvedValue(undefined),
    deleteByIdAndUser: jest.fn().mockResolvedValue(true),
    isGlobalProjectCreator: jest.fn().mockResolvedValue(true),
  }) as unknown as ProjectsRepository;

const makeCiService = () =>
  ({
    issueProjectToken: jest.fn().mockResolvedValue({
      token: 'aci_test-token',
      tokenPrefix: 'aci_test-tok',
    }),
  }) as unknown as CiService;

const makeProjectDeploymentProvisioningService = () => ({
  provisionForProject: jest.fn().mockResolvedValue({
    status: 'skipped',
    targets: [],
  }),
});

const stagedWorkflowMetadata = stagedWorkflowFiles.map((file) => ({
  stage: file.stage,
  name: file.name,
  path: file.path,
  gated: file.gated,
}));

describe('ProjectsService workflow authorization', () => {
  let service: ProjectsService;
  let githubService: GithubService;
  let projectsRepository: ProjectsRepository;
  let ciService: CiService;

  beforeEach(() => {
    githubService = makeGithubService();
    projectsRepository = makeProjectsRepository();
    ciService = makeCiService();

    service = new ProjectsService(
      makeCatalogService(),
      githubService,
      projectsRepository,
      ciService,
      makeProjectDeploymentProvisioningService() as never,
    );

    jest
      .spyOn(
        service as unknown as { buildWorkflowBundle: jest.Mock },
        'buildWorkflowBundle',
      )
      .mockResolvedValue({
        workflowFiles: stagedWorkflowFiles,
        outputFileName: '00-alphaci-access.yml',
      });
    jest
      .spyOn(
        service as unknown as { pushStarterFiles: jest.Mock },
        'pushStarterFiles',
      )
      .mockResolvedValue(undefined);
    jest
      .spyOn(
        service as unknown as { pushWorkflowFile: jest.Mock },
        'pushWorkflowFile',
      )
      .mockResolvedValue({
        commitSha: 'commit-1',
        commitUrl: 'https://commit',
      });
  });

  it('pushes every staged workflow file and installs the project CI token as a GitHub Actions secret', async () => {
    const result = await service.createProject(
      'user-1',
      'octocat',
      'gh-token',
      {
        repoName: 'repo',
        visibility: 'private',
        repoShape: 'standalone',
        projectTypeId: 'nestjs-api',
        workflowRecipeId: 'backend-api-ci',
        serviceName: 'api',
      },
    );

    expect(
      (service as unknown as { pushWorkflowFile: jest.Mock }).pushWorkflowFile,
    ).toHaveBeenCalledTimes(3);
    const setActionsSecretStrict = (
      githubService as unknown as { setActionsSecretStrict: jest.Mock }
    ).setActionsSecretStrict;
    const issueProjectToken = (
      ciService as unknown as { issueProjectToken: jest.Mock }
    ).issueProjectToken;
    const createProjectRow = (
      projectsRepository as unknown as { create: jest.Mock }
    ).create;

    expect(setActionsSecretStrict).toHaveBeenCalledWith(
      'gh-token',
      'owner',
      'repo',
      'ALPHACI_TOKEN',
      'aci_test-token',
    );
    expect(issueProjectToken).toHaveBeenCalledWith('project-1');
    expect(createProjectRow).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowPath: '.github/workflows/00-alphaci-access.yml',
        /* eslint-disable-next-line @typescript-eslint/no-unsafe-assignment */
        projectOptions: expect.objectContaining({
          workflowFiles: stagedWorkflowMetadata,
        }),
      }),
    );
    expect(result.workflowFiles).toEqual(stagedWorkflowMetadata);
  });
});
