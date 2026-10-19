import { generateKeyPairSync } from 'node:crypto';

import { Logger } from '@nestjs/common';
import yaml from 'js-yaml';

import { WorkflowFragmentRegistry } from '#kernel/ports/workflow-fragment.port';
import { onpremComposeWorkflowFragment } from '#modules/runtime/infrastructure/providers/onprem/onprem-compose-workflow.fragment';
import { renderWorkflowFragment } from '#modules/runtime/infrastructure/providers/render/render-workflow.fragment';
import { vercelWorkflowFragment } from '#modules/runtime/infrastructure/providers/vercel/vercel-workflow.fragment';

import type { WorkflowTemplate } from '../catalog/catalog.service';
import {
  PROMOTE_WORKFLOW_FILE,
  buildStagedWorkflowBundle,
  type StagedWorkflowOptions,
} from '../workflows/staged-workflow.builder';
import type { StagedWorkflowFile } from '../workflows/index';
import { MultiRepositoryProjectProvisioner } from './multi-repository-project.provisioner';

/*
 * A two-repository project created with its own environments: each repository
 * is its own project row with its own environments, deploys one slot, and
 * gets the environment pipeline a single-repository project gets. Failure
 * modes guarded here:
 * - a row is provisioned the other half's targets (a frontend image on the
 *   backend's host, or both slots twice);
 * - a repository keeps the branch-based hosted pipeline (promote-to-uat and
 *   promote-to-main) instead of the release pipeline;
 * - only one repository gets release signing;
 * - a frontend failure deletes the backend, or leaves a half-made frontend.
 */

const KEY_VERSION =
  'projects/alphaci-prod/locations/europe-west1/keyRings/release/cryptoKeys/release-signing/cryptoKeyVersions/3';

function trustedKmsEnv(): Record<string, string> {
  const { publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  return {
    ALPHACI_RELEASE_KMS_KEY_VERSION: KEY_VERSION,
    ALPHACI_RELEASE_SIGNER_WORKLOAD_IDENTITY_PROVIDER:
      'projects/123456789/locations/global/workloadIdentityPools/alphaci-release/providers/github',
    ALPHACI_RELEASE_SIGNER_SERVICE_ACCOUNT:
      'release-signer@alphaci-prod.iam.gserviceaccount.com',
    ALPHACI_RELEASE_TRUST_KEYS_JSON: JSON.stringify({
      [KEY_VERSION]: publicKey,
    }),
  };
}

const template: WorkflowTemplate = {
  id: 'tpl',
  name: 'Service',
  description: 'Service pipeline',
  iconName: 'server',
  categories: ['backend'],
  filePatterns: ['**/*.ts'],
  stack: 'nestjs',
  propertiesPath: '/properties.json',
  workflowPath: '/template.yml',
};

const registry = new WorkflowFragmentRegistry([
  renderWorkflowFragment,
  vercelWorkflowFragment,
  onpremComposeWorkflowFragment,
]);

const environmentsByProject: Record<
  string,
  Array<{
    id: string;
    slug: string;
    sourceBranch: string;
    position: number;
    role: 'production' | 'non_production';
  }>
> = {
  'proj-be': [
    {
      id: 'be-dev',
      slug: 'dev',
      sourceBranch: 'dev',
      position: 0,
      role: 'non_production',
    },
    {
      id: 'be-main',
      slug: 'main',
      sourceBranch: 'main',
      position: 1,
      role: 'production',
    },
  ],
  'proj-fe': [
    {
      id: 'fe-dev',
      slug: 'dev',
      sourceBranch: 'dev',
      position: 0,
      role: 'non_production',
    },
    {
      id: 'fe-main',
      slug: 'main',
      sourceBranch: 'main',
      position: 1,
      role: 'production',
    },
  ],
};

type TargetRequest = {
  slot: string;
  provider: string;
  environmentId?: string;
};

function fakeSupport(env: Record<string, string | undefined> = {}) {
  const pushed: Array<{
    repo: string;
    branch: string;
    files: StagedWorkflowFile[];
  }> = [];
  const support = {
    deploymentProvisioningDefaults: undefined,
    workflowFragmentRegistry: registry,
    configService: { get: (key: string) => env[key] },
    resolveTemplateId: jest.fn().mockReturnValue('tpl'),
    buildWorkflowBundle: jest.fn((options: StagedWorkflowOptions) =>
      Promise.resolve({
        workflowFiles: buildStagedWorkflowBundle(template, options, registry)
          .workflowFiles,
        outputFileName: '00-alphaci-access.yml',
      }),
    ),
    githubService: {
      createRepo: jest
        .fn()
        .mockResolvedValueOnce({
          repoUrl: 'https://github.com/org/orders-be',
          ownerLogin: 'org',
          repoName: 'orders-be',
        })
        .mockResolvedValueOnce({
          repoUrl: 'https://github.com/org/orders-fe',
          ownerLogin: 'org',
          repoName: 'orders-fe',
        }),
      setActionsSecretStrict: jest.fn().mockResolvedValue(undefined),
      setActionsVariableStrict: jest.fn().mockResolvedValue(undefined),
      createBranch: jest.fn().mockResolvedValue(undefined),
    },
    protectPipelineBranches: jest.fn().mockResolvedValue(undefined),
    pushStarterFiles: jest.fn().mockResolvedValue(undefined),
    createProjectRow: jest
      .fn()
      .mockResolvedValueOnce({
        row: { id: 'proj-be', workspace_id: 'ws-1' },
        deliveryProjectId: 'dp-1',
      })
      .mockResolvedValueOnce({
        row: { id: 'proj-fe', workspace_id: 'ws-1' },
        deliveryProjectId: 'dp-1',
      }),
    workspaceGate: {
      resolveWorkspaceIdForCreate: jest.fn().mockResolvedValue('ws-1'),
    },
    repositoryOwnershipMetadata: jest.fn().mockReturnValue({}),
    ciService: {
      issueProjectToken: jest.fn().mockResolvedValue({ token: 'ci-token' }),
    },
    sonar: { installSecrets: jest.fn().mockResolvedValue(undefined) },
    pushWorkflowFiles: jest.fn(
      (
        _token: string,
        _owner: string,
        repo: string,
        files: StagedWorkflowFile[],
        branch = 'main',
      ) => {
        pushed.push({ repo, branch, files });
        return Promise.resolve({
          commitSha: `${repo}-${branch}-sha`,
          commitUrl: `https://github.com/org/${repo}/commit/${branch}`,
        });
      },
    ),
    projectsRepository: {
      updateStatus: jest.fn().mockResolvedValue(undefined),
      listProjectEnvironments: jest.fn((projectId: string) =>
        Promise.resolve(environmentsByProject[projectId] ?? []),
      ),
    },
    compensateFailedProvision: jest.fn().mockResolvedValue(undefined),
    provisionDeploymentTargets: jest.fn(
      (input: {
        projectId: string;
        request: { targets: TargetRequest[] } | undefined;
      }) =>
        Promise.resolve({
          status: 'completed',
          targets: (input.request?.targets ?? []).map((target) => ({
            slot: target.slot,
            provider: target.provider,
            status: 'created',
            deploymentTargetId: `${input.projectId}:${target.environmentId}:${target.slot}`,
          })),
        }),
    ),
    projectDeploymentProvisioningService: {
      crossLinkServiceUrls: jest.fn().mockResolvedValue(undefined),
    },
    notifyProjectCreated: jest.fn().mockResolvedValue(undefined),
  };
  return { support, pushed };
}

const onpremTargets = ['dev', 'main'].flatMap((environmentSlug) =>
  ['backend', 'frontend'].map((slot) => ({
    slot,
    provider: 'onprem-compose',
    ownershipMode: 'byo',
    environmentSlug,
  })),
);

const dto = {
  repoName: 'orders',
  visibility: 'private',
  repoShape: 'multi-repo',
  projectTypeId: 'nestjs-api',
  serviceName: 'orders-be',
  multiRepoConfig: {
    backend: { projectTypeId: 'nestjs-api', serviceName: 'orders-be' },
    frontend: { projectTypeId: 'react-app', serviceName: 'orders-fe' },
  },
  environments: [
    {
      slug: 'dev',
      displayName: 'Test',
      sourceBranch: 'dev',
      role: 'non_production',
    },
    {
      slug: 'main',
      displayName: 'Production',
      sourceBranch: 'main',
      role: 'production',
    },
  ],
  deploymentProvisioning: { enabled: true, targets: onpremTargets },
};

function create(support: ReturnType<typeof fakeSupport>['support']) {
  return new MultiRepositoryProjectProvisioner(
    support as never,
  ).createMultiRepoProject(
    'user-1',
    'tone',
    'token',
    'prov-token',
    'org',
    dto as never,
  );
}

type Workflow = { jobs: Record<string, unknown> };
const jobsOf = (file: StagedWorkflowFile | undefined) =>
  Object.keys(
    (yaml.load(file?.yaml ?? '') as Workflow | undefined)?.jobs ?? {},
  );

describe('MultiRepositoryProjectProvisioner with project environments', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  it("provisions each row only its own slot's targets, environment by environment", async () => {
    const { support } = fakeSupport();

    const result = await create(support);

    const calls = support.provisionDeploymentTargets.mock.calls.map(
      ([input]) => ({
        projectId: input.projectId,
        slots: (input as unknown as { slots: string[] }).slots,
        targets: input.request?.targets.map(
          ({ slot, environmentId }: TargetRequest) => [slot, environmentId],
        ),
      }),
    );
    expect(calls).toEqual([
      {
        projectId: 'proj-be',
        slots: ['backend'],
        targets: [['backend', 'be-dev']],
      },
      {
        projectId: 'proj-be',
        slots: ['backend'],
        targets: [['backend', 'be-main']],
      },
      {
        projectId: 'proj-fe',
        slots: ['frontend'],
        targets: [['frontend', 'fe-dev']],
      },
      {
        projectId: 'proj-fe',
        slots: ['frontend'],
        targets: [['frontend', 'fe-main']],
      },
    ]);
    expect(
      result.deploymentProvisioning.targets.map(({ slot }) => slot),
    ).toEqual(['backend', 'backend', 'frontend', 'frontend']);
    expect(result).toMatchObject({
      id: 'proj-be',
      secondaryProjectId: 'proj-fe',
      secondaryRepoFullName: 'org/orders-fe',
      branchesCreated: ['main', 'dev'],
    });
  });

  it('gives both repositories the release pipeline, never the branch-based hosted one', async () => {
    const { support, pushed } = fakeSupport();

    await create(support);

    for (const repo of ['orders-be', 'orders-fe']) {
      const pushes = pushed.filter((push) => push.repo === repo);
      // Pushed to every environment's source branch, once each.
      expect(pushes.map(({ branch }) => branch).sort()).toEqual([
        'dev',
        'main',
      ]);
      const files = pushes[0]!.files;
      const packageJobs = jobsOf(
        files.find(({ path }) => path.includes('20-alphaci-package')),
      );
      expect(packageJobs).toEqual(
        expect.arrayContaining(['build', 'register-release']),
      );
      expect(packageJobs).not.toContain('promote-to-uat');
      expect(packageJobs).not.toContain('promote-to-main');
      expect(files.map(({ path }) => path)).toContain(
        '.github/workflows/' + PROMOTE_WORKFLOW_FILE,
      );
    }
    // Each image is built for its own slot only.
    const imageJobs = (repo: string) =>
      jobsOf(
        pushed
          .find((push) => push.repo === repo)!
          .files.find(({ path }) => path.includes('20-alphaci-package')),
      ).filter((job) => job.startsWith('image-'));
    expect(imageJobs('orders-be')).toEqual(['image-backend']);
    expect(imageJobs('orders-fe')).toEqual(['image-frontend']);
    // Only the environment branches exist: no uat branch is created.
    expect(
      support.githubService.createBranch.mock.calls.map(
        ([, , repo, branch]) => `${String(repo)}:${String(branch)}`,
      ),
    ).toEqual(['orders-be:dev', 'orders-fe:dev']);
    expect(support.projectsRepository.updateStatus).toHaveBeenCalledWith(
      'proj-fe',
      'provisioned',
      'orders-fe-dev-sha',
      'https://github.com/org/orders-fe/commit/dev',
    );
  });

  it('configures release signing on both repositories', async () => {
    const { support } = fakeSupport(trustedKmsEnv());

    const result = await create(support);

    expect(
      support.githubService.setActionsVariableStrict.mock.calls.map(
        ([, , repo, name]) => `${String(repo)}:${String(name)}`,
      ),
    ).toEqual([
      'orders-be:ALPHACI_RELEASE_KMS_KEY_VERSION',
      'orders-fe:ALPHACI_RELEASE_KMS_KEY_VERSION',
    ]);
    expect(result).not.toHaveProperty('releaseSigningWarning');
  });

  it('writes no signing setting to either repository when the backend signs releases', async () => {
    const { support } = fakeSupport({
      ...trustedKmsEnv(),
      ALPHACI_RELEASE_SIGNER: 'file',
    });

    const result = await create(support);

    expect(
      support.githubService.setActionsVariableStrict,
    ).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty('releaseSigningWarning');
  });

  it('reports one signing warning for the pair when nothing can sign', async () => {
    const { support } = fakeSupport();

    const result = await create(support);

    expect(result.releaseSigningWarning).toContain(
      'Releases cannot be signed yet',
    );
    expect(
      result.releaseSigningWarning?.match(/cannot be signed/g),
    ).toHaveLength(1);
  });

  it('cross-links the two halves one environment at a time', async () => {
    const { support } = fakeSupport();

    await create(support);

    const groups =
      support.projectDeploymentProvisioningService.crossLinkServiceUrls.mock.calls.map(
        ([input]) =>
          (
            input as {
              groups: Array<{
                projectId: string;
                result: { targets: Array<{ deploymentTargetId: string }> };
              }>;
            }
          ).groups.map(({ result }) =>
            result.targets.map(({ deploymentTargetId }) => deploymentTargetId),
          ),
      );
    expect(groups).toEqual([
      [['proj-be:be-dev:backend'], ['proj-fe:fe-dev:frontend']],
      [['proj-be:be-main:backend'], ['proj-fe:fe-main:frontend']],
    ]);
  });

  it('keeps the backend and removes a half-made frontend when the frontend fails', async () => {
    const { support } = fakeSupport();
    support.pushWorkflowFiles.mockImplementation((_t, _o, repo: string) =>
      repo === 'orders-fe'
        ? Promise.reject(new Error('GitHub 500'))
        : Promise.resolve({
            commitSha: 'sha',
            commitUrl: 'https://github.com/org/orders-be/commit/sha',
          }),
    );

    const result = await create(support);

    expect(support.compensateFailedProvision).toHaveBeenCalledTimes(1);
    expect(support.compensateFailedProvision).toHaveBeenCalledWith(
      'prov-token',
      'org',
      'orders-fe',
      'proj-fe',
      'user-1',
    );
    expect(result.id).toBe('proj-be');
    expect(result).not.toHaveProperty('secondaryProjectId');
    expect(result).not.toHaveProperty('secondaryRepoFullName');
    expect(result.secondaryRepoError).toMatch(/backend repository only/);
    expect(
      result.deploymentProvisioning.targets.map(({ slot }) => slot),
    ).toEqual(['backend', 'backend']);
    expect(
      support.projectDeploymentProvisioningService.crossLinkServiceUrls,
    ).not.toHaveBeenCalled();
  });
});
