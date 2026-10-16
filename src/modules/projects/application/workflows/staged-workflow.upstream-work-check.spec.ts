import yaml from 'js-yaml';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WorkflowFragmentRegistry } from '#kernel/ports/workflow-fragment.port';
import { renderWorkflowFragment } from '#modules/runtime/infrastructure/providers/render/render-workflow.fragment';
import { vercelWorkflowFragment } from '#modules/runtime/infrastructure/providers/vercel/vercel-workflow.fragment';

import type { WorkflowTemplate } from '../catalog/catalog.service';
import {
  buildStagedWorkflowBundle,
  type StagedWorkflowFile,
} from './staged-workflow.builder';

/*
 * The check that lets a chained stage skip when the stage before it did no
 * work. It used to count the previous run's non-skipped jobs, and two jobs
 * that always run kept that count above zero, so a stage after a skipped
 * deploy tested a hostname that did not exist. These tests run the emitted
 * script against the job lists GitHub actually returned.
 */

interface Job {
  name?: string;
  steps?: { run?: string; env?: Record<string, string> }[];
}
interface Parsed {
  on: { workflow_run?: { workflows: string[] } };
  jobs: Record<string, Job | undefined>;
}

const makeTemplate = (stack: WorkflowTemplate['stack']): WorkflowTemplate => ({
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

const bundles = () => [
  buildStagedWorkflowBundle(
    makeTemplate('dotnet'),
    {
      templateId: 'be-dotnet',
      serviceName: 'orders-api',
      deploymentTargets: [renderTarget('uat'), renderTarget('main')],
    } as never,
    registry,
  ),
  buildStagedWorkflowBundle(
    makeTemplate('react'),
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

const parse = (file: StagedWorkflowFile) => yaml.load(file.yaml) as Parsed;

const chainedFiles = (files: StagedWorkflowFile[]) =>
  files.filter((file) => parse(file).jobs['upstream-work-check']);

const hasJq = (() => {
  try {
    execFileSync('jq', ['--version']);
    return true;
  } catch {
    return false;
  }
})();
const withJq = hasJq ? it : it.skip;

/**
 * Run a generated `upstream-work-check` script with `curl` answering `jobs`
 * (or failing, for null). Returns its GITHUB_OUTPUT and stdout.
 */
function runWorkCheck(
  file: StagedWorkflowFile,
  jobs: { name: string; conclusion: string | null }[] | null,
): { output: Record<string, string>; stdout: string } {
  const step = parse(file).jobs['upstream-work-check']!.steps![0]!;
  const dir = mkdtempSync(join(tmpdir(), 'upstream-work-check-'));
  try {
    const output = join(dir, 'output');
    writeFileSync(output, '');
    const fixture = join(dir, 'jobs.json');
    writeFileSync(fixture, JSON.stringify({ jobs: jobs ?? [] }));
    // A shell function shadows the binary, so the real API is never called.
    const curl =
      jobs === null
        ? 'curl() { return 22; }'
        : `curl() { cat ${JSON.stringify(fixture.replace(/\\/g, '/'))}; }`;
    const script = join(dir, 'run.sh');
    writeFileSync(script, `${curl}\n${step.run!}`);
    const stdout = execFileSync('bash', [script], {
      encoding: 'utf8',
      env: {
        PATH: process.env['PATH'] ?? '',
        GITHUB_OUTPUT: output,
        ...step.env,
        GH_TOKEN: 'token',
        GH_REPO: 'org/repo',
        PREVIOUS_RUN_ID: '1',
        PREVIOUS_NAME: 'ALPHACI 3 Build and Deploy',
        EVENT_NAME: 'workflow_run',
      },
    });
    return {
      stdout,
      output: Object.fromEntries(
        readFileSync(output, 'utf8')
          .split('\n')
          .filter((line) => line.includes('='))
          .map((line) => [
            line.slice(0, line.indexOf('=')),
            line.slice(line.indexOf('=') + 1),
          ]),
      ),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/*
 * What GitHub returned for check-app-fe's Build and Deploy run after quality
 * failed on uat: the bookkeeping jobs ran, every job that does work skipped.
 */
const skippedBuildStage = [
  { name: 'pipeline-context', conclusion: 'success' },
  { name: 'upstream-work-check', conclusion: 'success' },
  { name: 'validate-access', conclusion: 'skipped' },
  { name: 'build', conclusion: 'skipped' },
  { name: 'production-gate', conclusion: 'skipped' },
  { name: 'deploy-vercel-frontend-uat', conclusion: 'skipped' },
  { name: 'report-results', conclusion: 'success' },
];

const workedBuildStage = skippedBuildStage.map((job) => ({
  ...job,
  conclusion: 'success',
}));

describe('upstream-work-check: the gate it reads exists', () => {
  it('names the gate job by the id every predecessor uses', () => {
    for (const { workflowFiles } of bundles()) {
      for (const file of chainedFiles(workflowFiles)) {
        const env = parse(file).jobs['upstream-work-check']!.steps![0]!.env;
        expect(env?.['GATE_JOB']).toBe('validate-access');
      }
    }
  });

  it('follows only stages that have that gate, under its id as its name', () => {
    for (const { workflowFiles } of bundles()) {
      const chained = chainedFiles(workflowFiles);
      expect(chained.length).toBeGreaterThan(0);

      for (const file of chained) {
        const [previousName] = parse(file).on.workflow_run!.workflows;
        const previous = workflowFiles.find((f) => f.name === previousName);
        expect(previous).toBeDefined();

        // The jobs API reports a job's `name` when it has one, so a display
        // name on the gate would make it look missing and wave every stage on.
        const gate = parse(previous!).jobs['validate-access'];
        expect(gate).toBeDefined();
        expect(gate!.name ?? 'validate-access').toBe('validate-access');
      }
    }
  });
});

describe('upstream-work-check: the emitted script', () => {
  const verify = () =>
    bundles()[1]!.workflowFiles.find((file) => file.stage === 'verify')!;

  withJq('skips after a build stage whose gate was closed', () => {
    const { output } = runWorkCheck(verify(), skippedBuildStage);

    // The regression: pipeline-context and the check itself always run, and
    // counting them reported "ran 2 job(s)" here.
    expect(output['ran']).toBe('false');
  });

  withJq('proceeds after a build stage that passed its gate', () => {
    const { output } = runWorkCheck(verify(), workedBuildStage);

    expect(output['ran']).toBe('true');
  });

  withJq('skips when the gate failed rather than skipped', () => {
    const failedGate = skippedBuildStage.map((job) =>
      job.name === 'validate-access' ? { ...job, conclusion: 'failure' } : job,
    );

    expect(runWorkCheck(verify(), failedGate).output['ran']).toBe('false');
  });

  withJq('proceeds, with a warning, when the API cannot be read', () => {
    const { output, stdout } = runWorkCheck(verify(), null);

    expect(output['ran']).toBe('true');
    expect(stdout).toContain('::warning::Could not read the jobs');
  });

  withJq(
    'proceeds, with a warning, when the previous stage has no gate job',
    () => {
      const { output, stdout } = runWorkCheck(verify(), [
        { name: 'build', conclusion: 'success' },
      ]);

      expect(output['ran']).toBe('true');
      expect(stdout).toContain('has no validate-access job');
    },
  );
});
