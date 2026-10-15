import yaml from 'js-yaml';
import { execFileSync } from 'node:child_process';
import type { ProjectsRepository } from '../../infrastructure/projects.repository';
import type { GithubProjectPort } from '#kernel/ports/github.port';
import type { CapabilityResolverPort } from '#kernel/composition/capability-resolver.port';
import type { DeploymentTargetsQuery } from '#kernel/ports/deployment-runtime.port';
import { WorkflowFragmentRegistry } from '#kernel/ports/workflow-fragment.port';
import { onpremComposeWorkflowFragment } from '#modules/runtime/infrastructure/providers/onprem/onprem-compose-workflow.fragment';
import type { CatalogService } from '../catalog/catalog.service';
import { ProjectWorkflowsService } from './project-workflows.service';

it('regenerates persisted environment targets instead of dropping host delivery', async () => {
  const environments = [
    {
      id: 'dev-id',
      slug: 'dev',
      sourceBranch: 'dev',
      position: 0,
      role: 'non_production',
    },
    {
      id: 'uat-id',
      slug: 'uat',
      sourceBranch: 'uat',
      position: 1,
      role: 'non_production',
    },
    {
      id: 'main-id',
      slug: 'main',
      sourceBranch: 'main',
      position: 2,
      role: 'production',
    },
  ];
  const repository = {
    findByIdAndUser: jest.fn().mockResolvedValue({
      id: 'project',
      template_id: 'fe-nextjs',
      service_name: 'eatta',
      project_options: {},
    }),
    listProjectEnvironments: jest.fn().mockResolvedValue(environments),
  };
  const targets = {
    listDeploymentTargets: jest.fn().mockResolvedValue(
      environments.map((env) => ({
        id: env.id + '-target',
        environmentId: env.id,
        slot: 'frontend',
        provider: 'onprem-compose',
      })),
    ),
  };
  const service = new ProjectWorkflowsService(
    repository as unknown as ProjectsRepository,
    {} as GithubProjectPort,
    {
      getTemplateById: jest
        .fn()
        .mockResolvedValue({ id: 'fe-nextjs', stack: 'nextjs' }),
    } as unknown as CatalogService,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    new WorkflowFragmentRegistry([onpremComposeWorkflowFragment]),
    {
      deployment: () => new Set(['projects.workflow-settings-preview']),
    } as unknown as CapabilityResolverPort,
    targets as unknown as DeploymentTargetsQuery,
  );
  const preview = await service.previewWorkflowSettings(
    'project',
    'viewer',
    {},
  );
  expect(preview.validationWarnings).toEqual([]);
  for (const file of preview.workflowFiles) {
    const workflow = yaml.load(file.yaml) as {
      env?: Record<string, string>;
      jobs: Record<string, { steps?: Array<{ name?: string; run?: string }> }>;
    };
    for (const job of Object.values(workflow.jobs)) {
      const preflight = job.steps?.find((step) =>
        step.name?.includes('connectivity configuration'),
      );
      if (!preflight?.run) continue;
      // GitHub exposes workflow-level env to every step, including Node.
      const script = preflight.run.split('\n').slice(1, -1).join('\n');
      expect(workflow.env?.ALPHACI_VALIDATE_URL).toBeDefined();
      expect(() =>
        execFileSync(process.execPath, ['-e', script], {
          env: {
            ...process.env,
            ...workflow.env,
            ALPHACI_VALIDATE_URL: 'https://ci.example.com/api/v1/ci/validate',
          },
          stdio: 'pipe',
        }),
      ).not.toThrow();
    }
  }
  expect(repository.listProjectEnvironments).toHaveBeenCalledWith('project');
  expect(targets.listDeploymentTargets).toHaveBeenCalledWith('project');
  const packageFile = preview.workflowFiles.find(
    (file) => file.stage === 'package',
  );
  const packageJobs = (
    yaml.load(packageFile!.yaml) as { jobs: Record<string, unknown> }
  ).jobs;
  expect(packageJobs['image-frontend']).toBeDefined();
  expect(packageJobs['sign-release']).toBeDefined();
  expect(packageJobs['report-signing-failure']).toBeDefined();
  expect(packageJobs['deploy-dev-frontend']).toBeUndefined();
  expect(packageFile?.yaml).toContain('dev-id');
  const promote = preview.workflowFiles.find((file) =>
    file.path.endsWith('30-alphaci-promote.yml'),
  );
  expect(promote).toBeDefined();
  const parsed = yaml.load(promote!.yaml) as { jobs: Record<string, unknown> };
  expect(
    Object.keys(parsed.jobs).filter((key) => key.startsWith('deploy-')),
  ).toEqual([]);
});
