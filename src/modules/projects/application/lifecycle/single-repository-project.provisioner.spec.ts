import { generateKeyPairSync } from 'node:crypto';

import { Logger } from '@nestjs/common';

import { SingleRepositoryProjectProvisioner } from './single-repository-project.provisioner';

const KEY_VERSION =
  'projects/alphaci-prod/locations/europe-west1/keyRings/release/cryptoKeys/release-signing/cryptoKeyVersions/3';

const environments = [
  {
    id: 'env-dev',
    slug: 'dev',
    sourceBranch: 'dev',
    position: 0,
    role: 'non_production',
  },
  {
    id: 'env-main',
    slug: 'main',
    sourceBranch: 'main',
    position: 1,
    role: 'production',
  },
];

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

function fakeSupport(env: Record<string, string | undefined> = {}) {
  return {
    deploymentProvisioningDefaults: undefined,
    workflowFragmentRegistry: {
      deliveredByHost: (provider: string) => provider === 'onprem-compose',
      expandTargets: () => [],
    },
    configService: { get: (key: string) => env[key] },
    resolveTemplateId: jest.fn().mockReturnValue('tpl'),
    buildWorkflowBundle: jest.fn().mockResolvedValue({
      workflowFiles: [{ path: '.github/workflows/ci.yml', yaml: '' }],
      outputFileName: 'ci.yml',
    }),
    githubService: {
      createRepo: jest.fn().mockResolvedValue({
        repoUrl: 'https://github.com/org/orders',
        cloneUrl: 'https://github.com/org/orders.git',
        ownerLogin: 'org',
        repoName: 'orders',
      }),
      setActionsSecretStrict: jest.fn().mockResolvedValue(undefined),
      setActionsVariableStrict: jest.fn().mockResolvedValue(undefined),
      createBranch: jest.fn().mockResolvedValue(undefined),
      deleteRepo: jest.fn().mockResolvedValue(undefined),
    },
    pushStarterFiles: jest.fn().mockResolvedValue(undefined),
    createProjectRow: jest.fn().mockResolvedValue({
      row: { id: 'proj-1', workspace_id: 'ws-1' },
      deliveryProjectId: null,
    }),
    workspaceGate: {
      resolveWorkspaceIdForCreate: jest.fn().mockResolvedValue('ws-1'),
    },
    repositoryOwnershipMetadata: jest.fn().mockReturnValue({}),
    ciService: {
      issueProjectToken: jest.fn().mockResolvedValue({ token: 'ci-token' }),
    },
    sonar: { installSecrets: jest.fn().mockResolvedValue(undefined) },
    pushWorkflowFiles: jest.fn().mockResolvedValue({
      commitSha: 'sha',
      commitUrl: 'https://github.com/org/orders/commit/sha',
    }),
    projectsRepository: {
      updateStatus: jest.fn().mockResolvedValue(undefined),
      listProjectEnvironments: jest.fn().mockResolvedValue(environments),
    },
    protectPipelineBranches: jest.fn().mockResolvedValue(undefined),
    provisionDeploymentTargets: jest.fn().mockResolvedValue({
      status: 'skipped',
      targets: [],
    }),
    recordProductEvent: jest.fn().mockResolvedValue(undefined),
    compensateFailedProvision: jest.fn().mockResolvedValue(undefined),
    notifyProjectCreated: jest.fn().mockResolvedValue(undefined),
  };
}

const environmentDto = {
  repoName: 'orders',
  visibility: 'private',
  repoShape: 'standalone',
  projectTypeId: 'nestjs-api',
  workflowRecipeId: 'backend-api-ci',
  serviceName: 'orders-api',
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
};

function createWith(
  support: ReturnType<typeof fakeSupport>,
  targets: Array<Record<string, unknown>>,
) {
  const provisioner = new SingleRepositoryProjectProvisioner(support as never);
  return provisioner.createStandaloneProject(
    'user-1',
    'tone',
    'token',
    'prov-token',
    'org',
    {
      ...environmentDto,
      deploymentProvisioning: { enabled: true, targets },
    } as never,
  );
}

const onpremFirstEnvironment = [
  {
    slot: 'backend',
    provider: 'onprem-compose',
    ownershipMode: 'byo',
    environmentSlug: 'dev',
  },
];

describe('SingleRepositoryProjectProvisioner.createStandaloneProject (environments)', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('sets the Cloud KMS key version as a repository variable when an environment is on-prem and KMS is trusted', async () => {
    const support = fakeSupport(trustedKmsEnv());

    const result = await createWith(support, onpremFirstEnvironment);

    expect(support.githubService.setActionsVariableStrict).toHaveBeenCalledWith(
      'prov-token',
      'org',
      'orders',
      'ALPHACI_RELEASE_KMS_KEY_VERSION',
      KEY_VERSION,
    );
    expect(
      support.githubService.setActionsSecretStrict,
    ).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      'ALPHACI_RELEASE_SIGNING_KEY',
      expect.anything(),
    );
    expect(result).not.toHaveProperty('releaseSigningWarning');
    expect(result.id).toBe('proj-1');
  });

  it('returns a releaseSigningWarning on the create response when no signing is configured', async () => {
    const support = fakeSupport();

    const result = await createWith(support, onpremFirstEnvironment);

    expect(
      support.githubService.setActionsVariableStrict,
    ).not.toHaveBeenCalled();
    expect(result.releaseSigningWarning).toContain(
      'Releases cannot be signed yet',
    );
  });

  it('configures signing when only a later environment is on-prem, because the release it signs is the one that environment consumes', async () => {
    const support = fakeSupport(trustedKmsEnv());

    const result = await createWith(support, [
      {
        slot: 'backend',
        provider: 'render',
        ownershipMode: 'flowci_managed',
        environmentSlug: 'dev',
      },
      {
        slot: 'backend',
        provider: 'onprem-compose',
        ownershipMode: 'byo',
        environmentSlug: 'main',
      },
    ]);

    expect(support.githubService.setActionsVariableStrict).toHaveBeenCalledWith(
      'prov-token',
      'org',
      'orders',
      'ALPHACI_RELEASE_KMS_KEY_VERSION',
      KEY_VERSION,
    );
    expect(result).not.toHaveProperty('releaseSigningWarning');
  });
});
