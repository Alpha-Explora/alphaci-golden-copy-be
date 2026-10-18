import { createHash } from 'node:crypto';

import { WorkflowFragmentRegistry } from '#kernel/ports/workflow-fragment.port';
import { onpremComposeWorkflowFragment } from '#modules/runtime/infrastructure/providers/onprem/onprem-compose-workflow.fragment';
import { renderWorkflowFragment } from '#modules/runtime/infrastructure/providers/render/render-workflow.fragment';
import { vercelWorkflowFragment } from '#modules/runtime/infrastructure/providers/vercel/vercel-workflow.fragment';

import type { WorkflowTemplate } from '../catalog/catalog.service';
import {
  buildStagedWorkflowBundle,
  type StagedEnvironmentTarget,
  type StagedWorkflowEnvironment,
  type StagedWorkflowOptions,
} from './staged-workflow.builder';

/*
 * SaaS golden. Runner signing is the default, so every pipeline this builder
 * produces without the server signer must stay byte-identical: the digest of
 * every generated file is pinned, and the environment package stage is pinned
 * in full so a reviewer can read the diff. Change these only with an intended,
 * reviewed change to the generated pipeline.
 */

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

const ids = { dev: 'env-dev', qa: 'env-qa', main: 'env-main' };
const environments: StagedWorkflowEnvironment[] = [
  {
    id: ids.main,
    slug: 'main',
    sourceBranch: 'main',
    position: 2,
    role: 'production',
  },
  {
    id: ids.dev,
    slug: 'dev',
    sourceBranch: 'dev',
    position: 0,
    role: 'non_production',
  },
  {
    id: ids.qa,
    slug: 'qa',
    sourceBranch: 'dev',
    position: 1,
    role: 'non_production',
  },
];
const renderTargets: StagedEnvironmentTarget[] = [
  {
    environmentId: ids.dev,
    slot: 'backend',
    targetId: 'target-dev',
    provider: 'render',
  },
  {
    environmentId: ids.qa,
    slot: 'backend',
    targetId: 'target-qa',
    provider: 'render',
  },
  {
    environmentId: ids.main,
    slot: 'backend',
    targetId: 'target-main',
    provider: 'render',
  },
];
const onpremFirstTargets = renderTargets.map((target) =>
  target.environmentId === ids.dev
    ? { ...target, provider: 'onprem-compose' }
    : target,
);
const kmsSigner = {
  workloadIdentityProvider:
    'projects/123456789/locations/global/workloadIdentityPools/alphaci-release/providers/github',
  serviceAccount: 'release-signer@alphaci-prod.iam.gserviceaccount.com',
};

const scenarios: Record<string, StagedWorkflowOptions> = {
  legacy: {
    templateId: 'be-nestjs',
    serviceName: 'orders-api',
    centralWorkflowRef: 'v1',
  },
  'environments with a hosted first environment': {
    templateId: 'be-nestjs',
    serviceName: 'orders-api',
    centralWorkflowRef: 'v1',
    environments,
    environmentTargets: renderTargets,
  },
  'environments with an on-prem first environment and the Cloud KMS signer': {
    templateId: 'be-nestjs',
    serviceName: 'orders-api',
    centralWorkflowRef: 'v1',
    environments,
    environmentTargets: onpremFirstTargets,
    releaseSigner: kmsSigner,
  },
  'environments with an on-prem first environment and no signer identity': {
    templateId: 'be-nestjs',
    serviceName: 'orders-api',
    centralWorkflowRef: 'v1',
    environments,
    environmentTargets: onpremFirstTargets,
  },
};

const registry = () =>
  new WorkflowFragmentRegistry([
    renderWorkflowFragment,
    vercelWorkflowFragment,
    onpremComposeWorkflowFragment,
  ]);

function generated(options: StagedWorkflowOptions) {
  const bundle = buildStagedWorkflowBundle(template, options, registry());
  const files = Object.fromEntries(
    bundle.workflowFiles.map((file) => [
      file.path,
      {
        sha256: createHash('sha256').update(file.yaml, 'utf8').digest('hex'),
        bytes: Buffer.byteLength(file.yaml, 'utf8'),
      },
    ]),
  );
  const packageStage = bundle.workflowFiles.find(
    (file) => file.stage === 'package',
  );
  return { files, packageStage: packageStage?.yaml ?? '' };
}

describe('runner-mode pipelines (SaaS golden)', () => {
  for (const [name, options] of Object.entries(scenarios)) {
    it(`keeps the generated files byte-identical: ${name}`, () => {
      expect(generated(options)).toMatchSnapshot();
    });
  }
});
