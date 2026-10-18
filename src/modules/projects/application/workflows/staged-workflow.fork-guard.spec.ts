import yaml from 'js-yaml';

import { WorkflowFragmentRegistry } from '#kernel/ports/workflow-fragment.port';
import { renderWorkflowFragment } from '#modules/runtime/infrastructure/providers/render/render-workflow.fragment';
import { vercelWorkflowFragment } from '#modules/runtime/infrastructure/providers/vercel/vercel-workflow.fragment';

import type { WorkflowTemplate } from '../catalog/catalog.service';
import {
  buildStagedWorkflowBundle,
  type StagedWorkflowFile,
  type StagedWorkflowOptions,
} from './staged-workflow.builder';

/*
 * A pull request from a fork runs the fork's own access workflow, and
 * `workflow_run` then starts the next stage in THIS repository, with its
 * secrets. Failure modes:
 * - the stage trusts the fork run's pipeline context or head_branch / head_sha
 *   and builds, pushes or deploys the fork's code;
 * - the always() reporter still runs with ALPHACI_TOKEN after the stage skipped;
 * - a write scope granted to the whole workflow reaches a job that only reads
 *   (SonarCloud githubactions:S8233).
 */

interface Job {
  if?: string;
  needs?: string[];
  uses?: string;
  permissions?: Record<string, string>;
}
interface Parsed {
  on: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs: Record<string, Job | undefined>;
}

const SAME_REPOSITORY_RUN =
  "github.event_name != 'workflow_run' || github.event.workflow_run.head_repository.full_name == github.repository";

/** The pull_request chain of a pipeline branch duplicates its push chain. */
const NOT_DUPLICATE_PULL_REQUEST_RUN =
  "github.event_name != 'workflow_run' || github.event.workflow_run.event != 'pull_request' || " +
  '!contains(fromJSON(\'["dev","uat","main"]\'), github.event.workflow_run.pull_requests[0].head.ref)';

const CHAIN_RUN_ALLOWED = `(${SAME_REPOSITORY_RUN}) && (${NOT_DUPLICATE_PULL_REQUEST_RUN})`;

const template = (stack: WorkflowTemplate['stack']): WorkflowTemplate => ({
  id: `tpl-${String(stack)}`,
  name: 'pipeline',
  description: 'pipeline',
  iconName: 'server',
  categories: ['x'],
  filePatterns: ['**/*.ts'],
  stack,
  propertiesPath: '/properties.json',
  workflowPath: '/template.yml',
});

const registry = new WorkflowFragmentRegistry([
  renderWorkflowFragment,
  vercelWorkflowFragment,
]);

const renderTarget = (branchName: 'uat' | 'main') => ({
  slot: 'backend',
  provider: 'render',
  branchName,
  deploymentStrategy: 'render_image_pushed',
  dockerContext: '.',
  dockerfilePath: 'Dockerfile',
  imageName: `alphaci-backend-${branchName}-orders-api`,
  secretNames: {
    deployHookUrl: `RENDER_DEPLOY_HOOK_URL_${branchName.toUpperCase()}`,
    healthcheckUrl: `RENDER_HEALTHCHECK_URL_${branchName.toUpperCase()}`,
  },
});

/** Branch-based pipeline: a Render API (image builds) and a Vercel frontend. */
const branchBundles = () => [
  buildStagedWorkflowBundle(
    template('dotnet'),
    {
      templateId: 'be-dotnet',
      serviceName: 'orders-api',
      deploymentTargets: [renderTarget('uat'), renderTarget('main')],
    } as never,
    registry,
  ),
  buildStagedWorkflowBundle(
    template('react'),
    {
      templateId: 'fe-react',
      serviceName: 'orders-web',
      deploymentTargets: [
        {
          slot: 'standalone',
          provider: 'vercel',
          deploymentStrategy: 'vercel_ci_pushed',
          secretNames: {
            token: 'VERCEL_TOKEN_STANDALONE',
            orgId: 'VERCEL_ORG_ID_STANDALONE',
            projectId: 'VERCEL_PROJECT_ID_STANDALONE',
          },
        },
      ],
    } as never,
    registry,
  ),
];

/** Pipeline generated from project environments. */
const environmentBundle = () =>
  buildStagedWorkflowBundle(
    template('nestjs'),
    {
      templateId: 'be-nestjs',
      serviceName: 'orders-api',
      centralWorkflowRef: 'v1',
      environments: [
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
      ],
      environmentTargets: [
        {
          environmentId: 'env-dev',
          slot: 'backend',
          targetId: 'target-dev',
          provider: 'render',
        },
        {
          environmentId: 'env-main',
          slot: 'backend',
          targetId: 'target-main',
          provider: 'render',
        },
      ],
    } satisfies StagedWorkflowOptions,
    registry,
  );

const allFiles = (): StagedWorkflowFile[] =>
  [...branchBundles(), environmentBundle()].flatMap(
    (bundle) => bundle.workflowFiles,
  );

const parse = (file: StagedWorkflowFile) => yaml.load(file.yaml) as Parsed;

const chained = () =>
  allFiles().filter((file) => 'workflow_run' in parse(file).on);

describe('generated workflows refuse runs chained off a fork', () => {
  it('covers every chained stage, in both pipeline shapes', () => {
    const stages = chained().map((file) => file.stage);
    expect(stages).toEqual(
      expect.arrayContaining(['quality', 'package', 'verify']),
    );
    // The environment-shaped bundle contributes its own package stage.
    expect(stages.filter((stage) => stage === 'package').length).toBe(3);
  });

  it('skips the context job for a run of another repository, or a pipeline branch’s pull request chain', () => {
    for (const file of chained()) {
      expect({
        path: file.path,
        if: parse(file).jobs['pipeline-context']?.if,
      }).toEqual({ path: file.path, if: `\${{ ${CHAIN_RUN_ALLOWED} }}` });
    }
  });

  it('so every other job of the stage, which all need it, skips too', () => {
    for (const file of chained()) {
      for (const [jobId, job] of Object.entries(parse(file).jobs)) {
        if (jobId === 'pipeline-context') continue;
        expect({ jobId, needs: job?.needs }).toEqual({
          jobId,
          needs: expect.arrayContaining(['pipeline-context']),
        });
      }
    }
  });

  it('does not let the always() reporter run with secrets for it', () => {
    for (const file of allFiles()) {
      const report = parse(file).jobs['report-results'];
      if (!report) continue;
      expect(report.if).toBe(`\${{ always() && (${CHAIN_RUN_ALLOWED}) }}`);
    }
  });
});

describe('generated workflows grant write scopes per job', () => {
  it('keeps the workflow level read-only', () => {
    for (const file of allFiles()) {
      const writes = Object.entries(parse(file).permissions ?? {}).filter(
        ([, level]) => level === 'write',
      );
      expect({ path: file.path, writes }).toEqual({
        path: file.path,
        writes: [],
      });
    }
  });

  it('still lets the env guard roll back and open its warning issue', () => {
    const guard = allFiles().find((file) => file.stage === 'guard')!;
    const jobs = Object.values(parse(guard).jobs);

    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.permissions).toEqual({
      contents: 'write',
      issues: 'write',
    });
  });

  it('still grants the image builds what docker-build.yml asks for', () => {
    const imageJobs = allFiles()
      .flatMap((file) => Object.values(parse(file).jobs))
      .filter((job) => job?.uses?.includes('/docker-build.yml@'));

    expect(imageJobs.length).toBeGreaterThan(0);
    for (const job of imageJobs) {
      expect(job?.permissions).toEqual(
        expect.objectContaining({
          packages: 'write',
          'security-events': 'write',
        }),
      );
    }
  });
});
