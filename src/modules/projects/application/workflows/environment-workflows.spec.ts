import yaml from 'js-yaml';
import { WorkflowFragmentRegistry } from '#kernel/ports/workflow-fragment.port';
import { renderWorkflowFragment } from '#modules/runtime/infrastructure/providers/render/render-workflow.fragment';
import { vercelWorkflowFragment } from '#modules/runtime/infrastructure/providers/vercel/vercel-workflow.fragment';
import { onpremComposeWorkflowFragment } from '#modules/runtime/infrastructure/providers/onprem/onprem-compose-workflow.fragment';

import type { WorkflowTemplate } from '../catalog/catalog.service';
import {
  PROMOTE_WORKFLOW_FILE,
  buildStagedWorkflowBundle,
  type StagedWorkflowOptions,
} from './staged-workflow.builder';

/*
 * Failure modes of a pipeline generated from project environments:
 * - a push to a later environment's branch deploys, or a shared branch is
 *   triggered twice or not at all;
 * - a deploy job resolves its destination from the branch instead of naming
 *   its environment, GitHub Environment, and target;
 * - the promotion workflow deploys an environment other than the one
 *   dispatched, rebuilds instead of using the release's digest, or can deploy
 *   the first environment;
 * - a branch name that is unsafe in a workflow expression is emitted;
 * - a project without environments gets a different pipeline.
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

type Job = {
  if?: string;
  needs?: string[];
  uses?: string;
  with?: Record<string, unknown>;
  steps?: Array<{ env?: Record<string, string>; run?: string }>;
};
type Workflow = {
  on: Record<string, { branches?: string[]; inputs?: Record<string, unknown> }>;
  jobs: Record<string, Job>;
};

const ids = { dev: 'env-dev', qa: 'env-qa', main: 'env-main' };
const options: StagedWorkflowOptions = {
  templateId: 'be-nestjs',
  serviceName: 'orders-api',
  centralWorkflowRef: 'v1',
  environments: [
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
  ],
  environmentTargets: [
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
  ],
};

function workflows(bundleOptions: StagedWorkflowOptions) {
  const bundle = buildStagedWorkflowBundle(
    template,
    bundleOptions,
    new WorkflowFragmentRegistry([
      renderWorkflowFragment,
      vercelWorkflowFragment,
      onpremComposeWorkflowFragment,
    ]),
  );
  return new Map(
    bundle.workflowFiles.map((file) => [
      file.path,
      yaml.load(file.yaml) as Workflow,
    ]),
  );
}

const deployJobs = (workflow: Workflow) =>
  Object.entries(workflow.jobs).filter(([, job]) =>
    /(render|vercel)-deploy\.yml@/.test(job.uses ?? ''),
  );

describe('pipeline generated from project environments', () => {
  const files = workflows(options);
  const access = files.get('.github/workflows/00-alphaci-access.yml')!;
  const packageStage = files.get('.github/workflows/20-alphaci-package.yml')!;
  const promote = files.get('.github/workflows/' + PROMOTE_WORKFLOW_FILE)!;

  it('runs the checks once on every source branch', () => {
    expect(access.on['push']?.branches).toEqual(['dev', 'main']);
    expect(access.on['pull_request']?.branches).toEqual(['dev', 'main']);
  });

  it('deploys only the first environment, only from its branch', () => {
    const jobs = deployJobs(packageStage);
    expect(jobs.map(([id]) => id)).toEqual(['deploy-dev-backend']);
    const [, job] = jobs[0]!;
    expect(job.if).toContain("== 'dev'");
    expect(job.if).not.toContain("'main'");
    expect(job.with).toMatchObject({
      'environment-id': ids.dev,
      'environment-name': 'dev',
      'target-id': 'target-dev',
      artifact: expect.stringContaining(
        'needs.image-backend.outputs.image-ref',
      ) as unknown,
    });
    expect(packageStage.jobs['register-release']?.if).toContain("== 'dev'");
    expect(packageStage.jobs['sign-release']?.uses).toMatch(
      /sign-release\.yml@v1$/,
    );
    expect(packageStage.jobs['sign-release']).toMatchObject({
      permissions: { 'id-token': 'write' },
      secrets: {
        ALPHACI_TOKEN: '${{ secrets.ALPHACI_TOKEN }}',
      },
    });
  });

  it('promotes only the dispatched later environment, from the release digest', () => {
    expect(Object.keys(promote.on['workflow_dispatch']?.inputs ?? {})).toEqual([
      'release-id',
      'deployment-id',
      'environment-id',
    ]);
    const jobs = Object.fromEntries(deployJobs(promote));
    expect(Object.keys(jobs)).toEqual([
      'deploy-qa-backend',
      'deploy-main-backend',
    ]);
    expect(jobs['deploy-qa-backend']).toMatchObject({
      if: "${{ inputs.environment-id == '" + ids.qa + "' }}",
      with: {
        'environment-id': ids.qa,
        'target-id': 'target-qa',
        'commit-sha': '${{ needs.release.outputs.commit-sha }}',
        artifact: '${{ needs.release.outputs.image-backend }}',
      },
    });
    expect(jobs['deploy-main-backend']?.with).toMatchObject({
      'environment-id': ids.main,
      'environment-name': 'main',
      'target-id': 'target-main',
    });
    expect(
      Object.values(promote.jobs).some((job) =>
        /docker-build/.test(job.uses ?? ''),
      ),
    ).toBe(false);
  });

  it('cleans up failed or cancelled signing for a host deployment and includes signing in the stage result', () => {
    const files = workflows({
      ...options,
      environmentTargets: (options.environmentTargets ?? []).map((target) => ({
        ...target,
        provider: 'onprem-compose',
      })),
    });
    const stage = files.get('.github/workflows/20-alphaci-package.yml')!;
    expect(deployJobs(stage)).toEqual([]);
    expect(stage.jobs['report-deployment']).toBeUndefined();
    expect(stage.jobs['report-signing-failure']).toMatchObject({
      needs: expect.arrayContaining(['register-release', 'sign-release']),
      if: "${{ always() && needs.register-release.result == 'success' && needs.sign-release.result != 'success' }}",
      steps: [
        expect.objectContaining({
          env: expect.objectContaining({
            RELEASE_ID: '${{ needs.register-release.outputs.release-id }}',
          }),
          run: expect.stringContaining('status:"failed"'),
        }),
      ],
    });
    expect(stage.jobs['report-results']?.needs).toContain('sign-release');
    expect(packageStage.jobs['report-signing-failure']).toBeUndefined();
  });

  it('checks the recorded deployment target set before starting promotion', () => {
    const read = promote.jobs.release?.steps?.[0];
    expect(JSON.parse(read?.env?.EXPECTED_TARGETS ?? '{}')).toEqual({
      [ids.qa]: ['target-qa'],
      [ids.main]: ['target-main'],
    });
    const script = read?.run ?? '';
    expect(script).toContain(
      '.environmentId == $environment and .delivery == "workflow"',
    );
    expect(script).toContain(
      '(.targetIds | sort) == ($expected[$environment] | sort)',
    );
    expect(script.indexOf('select(.id == $deployment')).toBeLessThan(
      script.indexOf('-X POST'),
    );
  });

  it('refuses a source branch that is unsafe in a workflow expression', () => {
    expect(() =>
      workflows({
        ...options,
        environments: [
          {
            id: ids.dev,
            slug: 'dev',
            sourceBranch: "dev' || true || '",
            position: 0,
            role: 'production',
          },
        ],
        environmentTargets: [],
      }),
    ).toThrow(/cannot be used in a workflow/);
  });

  it('refuses a target whose provider has no environment deploy job', () => {
    expect(() =>
      workflows({
        ...options,
        environmentTargets: [
          {
            environmentId: ids.dev,
            slot: 'backend',
            targetId: 'target-dev',
            provider: 'no-such-provider',
          },
        ],
      }),
    ).toThrow(/No environment deploy job is registered/);
  });

  it('leaves the pipeline of a project without environments unchanged', () => {
    const legacy = workflows({
      templateId: 'be-nestjs',
      serviceName: 'orders-api',
    });
    expect(legacy.has('.github/workflows/' + PROMOTE_WORKFLOW_FILE)).toBe(
      false,
    );
    const legacyAccess = legacy.get('.github/workflows/00-alphaci-access.yml')!;
    expect(legacyAccess.on['push']?.branches).toEqual(['dev', 'uat', 'main']);
    expect(
      Object.keys(legacy.get('.github/workflows/20-alphaci-package.yml')!.jobs),
    ).toContain('promote-to-uat');
  });
});

describe('release signer on the sign-release job', () => {
  const signer = {
    workloadIdentityProvider:
      'projects/123456789/locations/global/workloadIdentityPools/alphaci-release/providers/github',
    serviceAccount: 'release-signer@alphaci-prod.iam.gserviceaccount.com',
  };
  // The first environment deploys to a host, so its pipeline has the sign job.
  const onpremFirst: StagedWorkflowOptions = {
    ...options,
    environmentTargets: (options.environmentTargets ?? []).map((target) =>
      target.environmentId === ids.dev
        ? { ...target, provider: 'onprem-compose' }
        : target,
    ),
  };
  const signJob = (bundleOptions: StagedWorkflowOptions) =>
    workflows(bundleOptions).get('.github/workflows/20-alphaci-package.yml')!
      .jobs['sign-release'] as Job;

  it('passes the signer identity to the reusable sign-release workflow as inputs', () => {
    expect(
      signJob({ ...onpremFirst, releaseSigner: signer }).with,
    ).toMatchObject({
      'workload-identity-provider': signer.workloadIdentityProvider,
      'service-account': signer.serviceAccount,
    });
  });

  it('keeps the reusable workflow on its own variables when no signer is given', () => {
    expect(Object.keys(signJob(onpremFirst).with ?? {})).toEqual([
      'release-id',
      'api-url',
    ]);
  });
});
