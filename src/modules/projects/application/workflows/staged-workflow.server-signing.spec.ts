import yaml from 'js-yaml';

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
 * With ALPHACI_RELEASE_SIGNER=file the backend signs every release, so the
 * generated pipeline must carry no signing job, no signing secret, and nothing
 * that waits on one. Runner mode keeps the sign-release job.
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
  {
    id: ids.main,
    slug: 'main',
    sourceBranch: 'main',
    position: 2,
    role: 'production',
  },
];
const targets = (firstProvider: string): StagedEnvironmentTarget[] => [
  {
    environmentId: ids.dev,
    slot: 'backend',
    targetId: 'target-dev',
    provider: firstProvider,
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

const base = (firstProvider: string): StagedWorkflowOptions => ({
  templateId: 'be-nestjs',
  serviceName: 'orders-api',
  centralWorkflowRef: 'v1',
  environments,
  environmentTargets: targets(firstProvider),
});

function packageStage(options: StagedWorkflowOptions) {
  const bundle = buildStagedWorkflowBundle(
    template,
    options,
    new WorkflowFragmentRegistry([
      renderWorkflowFragment,
      vercelWorkflowFragment,
      onpremComposeWorkflowFragment,
    ]),
  );
  const file = bundle.workflowFiles.find((item) => item.stage === 'package');
  return {
    text: file?.yaml ?? '',
    workflow: yaml.load(file?.yaml ?? '') as {
      jobs: Record<string, { needs?: string[] }>;
    },
  };
}

describe('server-signed release pipelines', () => {
  it('generates no signing job or secret when the backend signs an on-prem first environment', () => {
    const { text, workflow } = packageStage({
      ...base('onprem-compose'),
      releaseSigning: 'server',
    });
    expect(text).not.toContain('sign-release');
    expect(text).not.toContain('report-signing-failure');
    expect(text).not.toContain('ALPHACI_RELEASE_SIGNING_KEY');
    expect(workflow.jobs['report-results']?.needs).not.toContain(
      'sign-release',
    );
    expect(workflow.jobs['register-release']).toBeDefined();
  });

  it('generates no sign job when the backend signs a hosted first environment, and keeps the deploy report', () => {
    const { text, workflow } = packageStage({
      ...base('render'),
      releaseSigning: 'server',
    });
    expect(text).not.toContain('sign-release');
    expect(workflow.jobs['report-deployment']?.needs).toEqual(
      expect.arrayContaining(['register-release']),
    );
    expect(workflow.jobs['report-results']?.needs).not.toContain(
      'sign-release',
    );
  });

  it('keeps the runner sign job by default and when the mode is named runner', () => {
    const defaulted = packageStage(base('onprem-compose'));
    const named = packageStage({
      ...base('onprem-compose'),
      releaseSigning: 'runner',
    });
    expect(defaulted.text).toContain('sign-release');
    expect(defaulted.text).toContain('report-signing-failure');
    expect(defaulted.workflow.jobs['report-results']?.needs).toContain(
      'sign-release',
    );
    expect(named.text).toBe(defaulted.text);
  });
});
