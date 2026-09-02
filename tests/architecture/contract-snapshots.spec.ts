import yaml from 'js-yaml';

import type { DeploymentProvider } from '../../src/modules/runtime/core/deployment-provider.contract';
import { DeploymentProviderRegistry } from '../../src/modules/runtime/core/deployment-provider.registry';
import { DeploymentProvidersController } from '../../src/modules/runtime/api/deployment-providers.controller';
import { WorkflowFragmentRegistry } from '../../src/modules/runtime/core/workflow-fragment.contract';
import { renderWorkflowFragment } from '../../src/modules/runtime/infrastructure/providers/render/render-workflow.fragment';
import { vercelWorkflowFragment } from '../../src/modules/runtime/infrastructure/providers/vercel/vercel-workflow.fragment';
import type { WorkflowTemplate } from '../../src/modules/projects/application/catalog/catalog.service';
import {
  buildStagedWorkflowBundle,
  type StagedWorkflowOptions,
} from '../../src/modules/projects/application/workflows/staged-workflow.builder';

const template: WorkflowTemplate = {
  id: 'snapshot-template',
  name: 'Snapshot template',
  description: 'Stable architecture contract fixture',
  iconName: 'server',
  categories: ['backend'],
  filePatterns: ['**/*.ts'],
  stack: 'nestjs',
  propertiesPath: '/properties.json',
  workflowPath: '/workflow.yml',
};

const workflowOptions: StagedWorkflowOptions = {
  templateId: template.id,
  serviceName: 'orders-api',
  servicePath: 'backend',
  centralWorkflowRef: 'v1',
  deploymentTargets: [
    {
      provider: 'render',
      slot: 'backend',
      branchName: 'uat',
      deploymentStrategy: 'render_image_pushed',
      dockerContext: 'backend',
      dockerfilePath: 'Dockerfile',
      imageName: 'alphaci-backend-uat-orders-api',
      secretNames: {
        deployHookUrl: 'RENDER_DEPLOY_HOOK_URL_UAT',
        healthcheckUrl: 'RENDER_HEALTHCHECK_URL_UAT',
      },
    },
    {
      provider: 'vercel',
      slot: 'frontend',
      deploymentStrategy: 'vercel_ci_pushed',
      rootDirectory: 'frontend',
      secretNames: {
        token: 'VERCEL_FRONTEND_TOKEN',
        orgId: 'VERCEL_FRONTEND_ORG_ID',
        projectId: 'VERCEL_FRONTEND_PROJECT_ID',
      },
    },
  ],
};

function providerFixture(id: string): DeploymentProvider {
  return {
    id,
    label: id === 'render' ? 'Render' : 'Vercel',
    supportedSlots: id === 'render' ? ['backend'] : ['frontend'],
    capabilities: {
      envVars: true,
      logs: true,
      deployHistory: true,
      teardown: true,
      managedMode: true,
      liveStatus: true,
      connectivity: 'direct',
      enumerable: true,
      credentialCustody: 'platform',
      envProvisioning: true,
      previewDeployments: id === 'vercel',
    },
    configSchema: { fields: [] },
    credentialSchema: { fields: [] },
    isEnabled: () => ({ enabled: true }),
    validateConfig: () => undefined,
  };
}

describe('post-consolidation public contract snapshots', () => {
  it('records the staged workflow file contract and provider job shape', () => {
    const registry = new WorkflowFragmentRegistry([
      renderWorkflowFragment,
      vercelWorkflowFragment,
    ]);
    const bundle = buildStagedWorkflowBundle(
      template,
      workflowOptions,
      registry,
    );
    const packageFile = bundle.workflowFiles.find(
      (file) => file.stage === 'package',
    );
    const packageWorkflow = yaml.load(packageFile?.yaml ?? '') as {
      jobs: Record<string, unknown>;
    };

    const providerJobs = Object.fromEntries(
      Object.entries(packageWorkflow.jobs).filter(
        ([id]) => id.startsWith('docker-') || id.startsWith('deploy-'),
      ),
    );

    expect({
      files: bundle.metadata,
      providerJobs,
    }).toMatchSnapshot();
  });

  it('records the provider discovery contract independently of implementation classes', () => {
    const registry = new DeploymentProviderRegistry<DeploymentProvider>();
    registry.register(providerFixture('render'));
    registry.register(providerFixture('vercel'));

    expect(
      new DeploymentProvidersController(registry).list(),
    ).toMatchSnapshot();
  });
});
