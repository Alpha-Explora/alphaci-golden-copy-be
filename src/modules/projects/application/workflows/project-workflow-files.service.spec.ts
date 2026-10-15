import type { ConfigService } from '@nestjs/config';
import yaml from 'js-yaml';

import { WorkflowFragmentRegistry } from '#kernel/ports/workflow-fragment.port';
import { onpremComposeWorkflowFragment } from '#modules/runtime/infrastructure/providers/onprem/onprem-compose-workflow.fragment';

import type {
  CatalogService,
  WorkflowTemplate,
} from '../catalog/catalog.service';
import { ProjectWorkflowFilesService } from './project-workflow-files.service';

const template: WorkflowTemplate = {
  id: 'be-nestjs',
  name: 'Backend API',
  description: 'NestJS service pipeline',
  iconName: 'server',
  categories: ['backend'],
  filePatterns: ['**/*.ts'],
  stack: 'nestjs',
  propertiesPath: '/properties.json',
  workflowPath: '/template.yml',
};

const KEY_VERSION =
  'projects/alphaci-prod/locations/europe-west1/keyRings/release/cryptoKeys/release-signing/cryptoKeyVersions/3';
const SIGNER_PROVIDER =
  'projects/123456789/locations/global/workloadIdentityPools/alphaci-release/providers/github';
const SIGNER_ACCOUNT = 'release-signer@alphaci-prod.iam.gserviceaccount.com';

const environments = [
  {
    id: 'env-dev',
    slug: 'dev',
    sourceBranch: 'dev',
    position: 0,
    role: 'non_production' as const,
  },
  {
    id: 'env-main',
    slug: 'main',
    sourceBranch: 'main',
    position: 1,
    role: 'production' as const,
  },
];

const environmentTargets = [
  {
    environmentId: 'env-dev',
    slot: 'backend' as const,
    targetId: 'target-dev',
    provider: 'onprem-compose',
  },
  {
    environmentId: 'env-main',
    slot: 'backend' as const,
    targetId: 'target-main',
    provider: 'onprem-compose',
  },
];

function service(env: Record<string, string | undefined>) {
  return new ProjectWorkflowFilesService(
    { getTemplateById: async () => template } as unknown as CatalogService,
    new WorkflowFragmentRegistry([onpremComposeWorkflowFragment]),
    { get: (key: string) => env[key] } as unknown as ConfigService,
  );
}

async function signJobWith(env: Record<string, string | undefined>) {
  const bundle = await service(env).buildWorkflowBundle({
    templateId: 'be-nestjs',
    serviceName: 'orders-api',
    centralWorkflowRef: 'v1',
    environments,
    environmentTargets,
  });
  const packageFile = bundle.workflowFiles.find((file) =>
    file.path.endsWith('20-alphaci-package.yml'),
  );
  const jobs = (
    yaml.load(packageFile!.yaml) as {
      jobs: Record<string, { with?: Record<string, unknown> }>;
    }
  ).jobs;
  return jobs['sign-release']?.with ?? {};
}

describe('ProjectWorkflowFilesService release signer', () => {
  it('writes the complete Cloud KMS signer into the sign-release inputs of an environment pipeline', async () => {
    await expect(
      signJobWith({
        ALPHACI_RELEASE_KMS_KEY_VERSION: KEY_VERSION,
        ALPHACI_RELEASE_SIGNER_WORKLOAD_IDENTITY_PROVIDER: SIGNER_PROVIDER,
        ALPHACI_RELEASE_SIGNER_SERVICE_ACCOUNT: SIGNER_ACCOUNT,
      }),
    ).resolves.toMatchObject({
      'workload-identity-provider': SIGNER_PROVIDER,
      'service-account': SIGNER_ACCOUNT,
    });
  });

  it('leaves the signer inputs out when Cloud KMS is incomplete, so no identity is guessed', async () => {
    const inputs = await signJobWith({
      ALPHACI_RELEASE_KMS_KEY_VERSION: KEY_VERSION,
      ALPHACI_RELEASE_SIGNER_SERVICE_ACCOUNT: SIGNER_ACCOUNT,
    });

    expect(Object.keys(inputs)).toEqual(['release-id', 'api-url']);
  });
});
