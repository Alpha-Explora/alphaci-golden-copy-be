import yaml from 'js-yaml';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  HOSTED_BRANCHES,
  PIPELINE_BRANCHES,
  stageRunsOnBranch,
} from '#kernel/config/pipeline-branches';
import { WorkflowFragmentRegistry } from '#kernel/ports/workflow-fragment.port';
import { renderWorkflowFragment } from '#modules/runtime/infrastructure/providers/render/render-workflow.fragment';
import { vercelWorkflowFragment } from '#modules/runtime/infrastructure/providers/vercel/vercel-workflow.fragment';

import type { WorkflowTemplate } from '../catalog/catalog.service';
import {
  buildStagedWorkflowBundle,
  type StagedWorkflowFile,
} from './staged-workflow.builder';

/*
 * Pipeline run reports that tell the truth: what the GENERATED workflow does
 * when a promotion fails, when the deployment was never provisioned, and which
 * branches each stage runs on. Assertions are on the emitted YAML and, where a
 * shell script decides, on the script actually run - the generator builds shell
 * out of JS string literals, so a source-level check can pass on text that
 * emits something else.
 */

interface Job {
  if?: string;
  needs?: string[];
  outputs?: Record<string, string>;
  steps?: { run?: string; env?: Record<string, string> }[];
}
interface Parsed {
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

const vercelTarget = {
  slot: 'standalone',
  provider: 'vercel',
  deploymentStrategy: 'vercel_ci_pushed',
  secretNames: {
    token: 'VERCEL_TOKEN_STANDALONE',
    orgId: 'VERCEL_ORG_ID_STANDALONE',
    projectId: 'VERCEL_PROJECT_ID_STANDALONE',
  },
};

/** A dotnet API repository hosted on Render: the verify stage has API suites. */
const apiBundle = () =>
  buildStagedWorkflowBundle(
    makeTemplate('dotnet'),
    {
      templateId: 'be-dotnet',
      serviceName: 'orders-api',
      deploymentTargets: [renderTarget('uat'), renderTarget('main')],
    } as never,
    registry,
  );

/** A React frontend on Vercel: the verify stage has a browser suite. */
const uiBundle = () =>
  buildStagedWorkflowBundle(
    makeTemplate('react'),
    {
      templateId: 'fe-react',
      serviceName: 'orders-web',
      deploymentTargets: [vercelTarget],
    } as never,
    registry,
  );

const fileOf = (
  bundle: ReturnType<typeof apiBundle>,
  stage: StagedWorkflowFile['stage'],
) => bundle.workflowFiles.find((file) => file.stage === stage)!;

const parse = (file: StagedWorkflowFile) => yaml.load(file.yaml) as Parsed;

const reportStep = (file: StagedWorkflowFile) =>
  parse(file).jobs['report-results']!.steps![0]!;

const hasJq = (() => {
  try {
    execFileSync('jq', ['--version']);
    return true;
  } catch {
    return false;
  }
})();
const withJq = hasJq ? it : it.skip;

/** Run a generated `resolve-targets` script; returns what it wrote to GITHUB_OUTPUT. */
function runResolveTargets(
  file: StagedWorkflowFile,
  env: Record<string, string>,
): Record<string, string> {
  const step = parse(file).jobs['resolve-targets']!.steps![0]!;
  const dir = mkdtempSync(join(tmpdir(), 'resolve-targets-'));
  try {
    const output = join(dir, 'output');
    writeFileSync(output, '');
    const script = join(dir, 'run.sh');
    writeFileSync(script, step.run!);
    execFileSync('bash', [script], {
      env: {
        PATH: process.env['PATH'] ?? '',
        GITHUB_OUTPUT: output,
        // GitHub always defines a mapped variable, as '' when it is unset.
        RENDER_HEALTHCHECK_URL_UAT: '',
        RENDER_HEALTHCHECK_URL_MAIN: '',
        VERCEL_ALIAS: '',
        ...env,
      },
    });
    return Object.fromEntries(
      readFileSync(output, 'utf8')
        .split('\n')
        .filter((line) => line.includes('='))
        .map((line) => [
          line.slice(0, line.indexOf('=')),
          line.slice(line.indexOf('=') + 1),
        ]),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('package stage: the report waits for the promotion', () => {
  it('needs both promotion jobs, and the gate, so their result is in the verdict', () => {
    const report = parse(fileOf(apiBundle(), 'package')).jobs['report-results'];

    expect(report?.needs).toEqual(
      expect.arrayContaining([
        'build',
        'production-gate',
        'promote-to-uat',
        'promote-to-main',
      ]),
    );
    // Still reports after a failed or skipped promotion rather than waiting on it.
    expect(report?.if).toBe('${{ always() }}');
  });

  it('derives the failed verdict from every needed job, promotion included', () => {
    const env = reportStep(fileOf(apiBundle(), 'package')).env!;

    expect(env['STAGE_FAILED']).toBe(
      "${{ contains(needs.*.result, 'failure') }}",
    );
    // The promotion is not "work": a skipped one must not make the stage look
    // like it did something, so only `build` decides whether the stage ran.
    expect(env['STAGE_WORK_RAN']).toBe(
      "${{ needs.build.result != 'skipped' }}",
    );
  });

  it('keeps the promotion jobs ordered after the deploy jobs they gate on', () => {
    const jobs = parse(fileOf(apiBundle(), 'package')).jobs;

    expect(jobs['promote-to-uat']?.needs).toEqual(
      expect.arrayContaining(['build']),
    );
    expect(jobs['report-results']?.needs).toEqual(
      expect.arrayContaining(
        Object.keys(jobs).filter((id) => id.startsWith('deploy-')),
      ),
    );
  });
});

describe('verify stage: a resolve-targets failure is reported', () => {
  it.each([
    ['API', apiBundle],
    ['UI', uiBundle],
  ])('%s: the resolver is in report-results needs', (_name, bundle) => {
    const report = parse(fileOf(bundle(), 'verify')).jobs['report-results'];

    expect(report?.needs).toContain('resolve-targets');
    expect(report?.if).toBe('${{ always() }}');
  });

  it('counts a resolver failure but not a resolver success as work', () => {
    const env = reportStep(fileOf(apiBundle(), 'verify')).env!;

    expect(env['STAGE_FAILED']).toBe(
      "${{ contains(needs.*.result, 'failure') }}",
    );
    // dev: every test job is branch-scoped out and the resolver succeeds, so
    // the stage must still report nothing rather than a success it did not earn.
    expect(env['STAGE_WORK_RAN']).not.toContain('resolve-targets');
    expect(env['STAGE_WORK_RAN']).toContain('api-tests-uat');
  });
});

describe('verify stage: nothing deployed is reported as skipped, not failed', () => {
  const apiVerify = () => fileOf(apiBundle(), 'verify');
  const uiVerify = () => fileOf(uiBundle(), 'verify');

  it('does not fail the resolver for a missing address', () => {
    const run = parse(apiVerify()).jobs['resolve-targets']!.steps![0]!.run!;

    expect(run).not.toContain('exit 1');
    expect(run).not.toContain('::error::');
  });

  it('skips the suite whose address is missing, per kind', () => {
    const api = parse(apiVerify()).jobs;
    const ui = parse(uiVerify()).jobs;

    for (const id of [
      'api-tests-uat',
      'api-tests-main',
      'contract-tests-uat',
    ]) {
      expect(api[id]?.if).toContain(
        "needs.resolve-targets.outputs.api-skipped != 'true'",
      );
    }
    for (const id of ['ui-tests-uat', 'ui-tests-main']) {
      expect(ui[id]?.if).toContain(
        "needs.resolve-targets.outputs.ui-skipped != 'true'",
      );
    }
  });

  it('publishes the skip flags and the reason as job outputs', () => {
    expect(parse(apiVerify()).jobs['resolve-targets']?.outputs).toMatchObject({
      'api-skipped': '${{ steps.resolve.outputs.api-skipped }}',
      'skip-reason': '${{ steps.resolve.outputs.skip-reason }}',
    });
    expect(parse(uiVerify()).jobs['resolve-targets']?.outputs).toMatchObject({
      'ui-skipped': '${{ steps.resolve.outputs.ui-skipped }}',
    });
  });

  it('names the branch and the variable, and says what to do (script run)', () => {
    const out = runResolveTargets(apiVerify(), { BRANCH: 'uat' });

    expect(out['api-skipped']).toBe('true');
    expect(out['skip-reason']).toBe(
      'Nothing was deployed for uat: RENDER_HEALTHCHECK_URL_UAT is not set - provision hosting in ALPHACI.',
    );
  });

  it('names the Vercel alias for a UI suite (script run)', () => {
    const out = runResolveTargets(uiVerify(), { BRANCH: 'main' });

    expect(out['ui-skipped']).toBe('true');
    expect(out['skip-reason']).toBe(
      'Nothing was deployed for main: VERCEL_ALIAS is not set - provision hosting in ALPHACI.',
    );
  });

  it('is silent when the address is configured (script run)', () => {
    const out = runResolveTargets(apiVerify(), {
      BRANCH: 'uat',
      RENDER_HEALTHCHECK_URL_UAT: 'https://orders-uat.example.com/health',
      RENDER_HEALTHCHECK_URL_MAIN: 'https://orders.example.com/health',
    });

    expect(out['skip-reason']).toBeUndefined();
    expect(out['api-skipped']).toBeUndefined();
    expect(out['api-uat']).toBe('https://orders-uat.example.com/health');
  });

  it('does not demand an address on dev, which tests no deployment (script run)', () => {
    const out = runResolveTargets(apiVerify(), { BRANCH: 'dev' });

    expect(out['skip-reason']).toBeUndefined();
    expect(out['api-skipped']).toBeUndefined();
  });

  it('reports the skip from report-results, as a success carrying the reason', () => {
    const step = reportStep(apiVerify());

    expect(step.env!['SKIP_REASON']).toBe(
      '${{ needs.resolve-targets.outputs.skip-reason }}',
    );
    expect(step.run).toContain(
      'elif [ "$STAGE_WORK_RAN" != "true" ] && [ -n "${SKIP_REASON:-}" ]; then',
    );
    expect(step.run).toContain('SKIPPED="true"');
    expect(step.run).toContain("'{skipped:{reason:$reason}}'");
  });

  it('puts no status on the commit for a skipped stage', () => {
    const run = reportStep(apiVerify()).run!;
    const skipArm = run.slice(
      run.indexOf('elif [ "$STAGE_WORK_RAN" != "true" ] && [ -n'),
      run.indexOf('elif [ "$STAGE_WORK_RAN" != "true" ]; then'),
    );

    expect(skipArm).toContain('CONCLUSION="success"');
    expect(skipArm).not.toContain('post_commit_status');
  });

  it('adds none of this to the other stages', () => {
    for (const stage of ['access', 'quality', 'package'] as const) {
      const step = reportStep(fileOf(apiBundle(), stage));

      expect(step.env!['SKIP_REASON']).toBeUndefined();
      expect(step.run).not.toContain('SKIP_REASON');
    }
  });
});

describe('annotation capture keeps the reason a workflow step printed', () => {
  const program = () => {
    const run = reportStep(fileOf(apiBundle(), 'quality')).run!;
    const line = run
      .split('\n')
      .find((candidate) => candidate.includes('unique_by'))!;
    const start = line.indexOf("jq -s -c '") + "jq -s -c '".length;
    return line.slice(start, line.indexOf("' ||", start));
  };

  const filter = (annotations: unknown[]) =>
    JSON.parse(
      execFileSync('jq', ['-s', '-c', program()], {
        input: `${JSON.stringify([])} ${JSON.stringify(annotations)}`,
      }).toString(),
    ) as { path: string; message: string; level: string }[];

  const ann = (path: string, level: string, message: string) => ({
    path,
    annotation_level: level,
    message,
    start_line: 1,
    title: null,
  });

  withJq('keeps a failure-level ::error:: on .github', () => {
    const out = filter([
      ann(
        '.github',
        'failure',
        'AlphaCI refused the release (HTTP 502): Render could not pull the image.',
      ),
    ]);

    expect(out.map((item) => item.message)).toEqual([
      'AlphaCI refused the release (HTTP 502): Render could not pull the image.',
    ]);
  });

  withJq('still drops the runner exit-code notice on .github', () => {
    expect(
      filter([
        ann('.github', 'failure', 'Process completed with exit code 1.'),
      ]),
    ).toEqual([]);
  });

  withJq('still drops warning and notice annotations on .github', () => {
    expect(
      filter([
        ann('.github', 'warning', 'Node.js 20 actions are deprecated'),
        ann('.github', 'notice', 'something'),
      ]),
    ).toEqual([]);
  });

  withJq('keeps code annotations at every level', () => {
    const out = filter([
      ann('Program.cs', 'warning', 'Await RunAsync'),
      ann('src/a.ts', 'failure', 'no-unused-vars'),
    ]);

    expect(out).toHaveLength(2);
  });
});

describe('the branch rule the generator and the reader share', () => {
  const branchesIn = (expression: string | undefined) =>
    [...(expression ?? '').matchAll(/== '([^']+)'/g)].map((match) => match[1]!);

  it('scopes every verify test job to branches where verify runs', () => {
    const jobs = parse(fileOf(apiBundle(), 'verify')).jobs;
    const scoped = Object.entries(jobs).filter(([id]) => /-tests-/.test(id));

    expect(scoped.length).toBeGreaterThan(0);
    for (const [, job] of scoped) {
      const branches = branchesIn(job?.if);
      expect(branches.length).toBeGreaterThan(0);
      for (const branch of branches) {
        expect(stageRunsOnBranch('verify', branch)).toBe(true);
      }
    }
    // ...and never dev, which is hosted nowhere.
    expect(stageRunsOnBranch('verify', 'dev')).toBe(false);
  });

  it('agrees with the generator on where quality and package run', () => {
    for (const branch of PIPELINE_BRANCHES) {
      expect(stageRunsOnBranch('quality', branch)).toBe(true);
      expect(stageRunsOnBranch('package', branch)).toBe(true);
    }
    for (const branch of HOSTED_BRANCHES) {
      expect(stageRunsOnBranch('verify', branch)).toBe(true);
    }
    expect(stageRunsOnBranch('quality', 'feature/x')).toBe(false);
    expect(stageRunsOnBranch('access', 'feature/x')).toBe(true);
    expect(stageRunsOnBranch('verify', '7/merge')).toBe(false);
  });

  it('runs the package build job on exactly the pipeline branches', () => {
    const build = parse(fileOf(apiBundle(), 'package')).jobs['build'];

    expect(branchesIn(build?.if).sort()).toEqual([...PIPELINE_BRANCHES].sort());
  });
});

describe('generated expressions stay far below the 21,000 character limit', () => {
  const longestExpression = (file: StagedWorkflowFile) =>
    Math.max(
      ...[...file.yaml.matchAll(/\$\{\{[\s\S]*?\}\}/g)].map(
        (match) => match[0].length,
      ),
    );

  it.each([
    ['api', apiBundle],
    ['ui', uiBundle],
  ])('%s: every ${{ }} is short, in every file', (_name, bundle) => {
    for (const file of bundle().workflowFiles) {
      expect(longestExpression(file)).toBeLessThan(2_000);
    }
  });
});

describe('every generated script is valid shell', () => {
  it.each([
    ['api', apiBundle],
    ['ui', uiBundle],
  ])('%s: bash -n accepts every run block', (_name, bundle) => {
    const dir = mkdtempSync(join(tmpdir(), 'bash-n-'));
    try {
      for (const file of bundle().workflowFiles) {
        for (const [jobId, job] of Object.entries(parse(file).jobs)) {
          for (const [index, step] of (job?.steps ?? []).entries()) {
            if (step.run === undefined) continue;
            const script = join(
              dir,
              `${file.stage}-${jobId}-${String(index)}.sh`,
            );
            writeFileSync(script, step.run);
            // Throws on a syntax error, naming the script that has it.
            execFileSync('bash', ['-n', script]);
          }
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
