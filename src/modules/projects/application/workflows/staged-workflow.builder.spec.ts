import yaml from 'js-yaml';
import { WorkflowFragmentRegistry } from '#kernel/ports/workflow-fragment.port';
import { renderWorkflowFragment } from '#modules/runtime/infrastructure/providers/render/render-workflow.fragment';
import { vercelWorkflowFragment } from '#modules/runtime/infrastructure/providers/vercel/vercel-workflow.fragment';

import type { WorkflowTemplate } from '../catalog/catalog.service';
import {
  buildStagedWorkflowBundle,
  resolveDefaultCentralWorkflowRef,
  resolvePlatformBaseUrl,
} from './staged-workflow.builder';

const makeTemplate = (
  stack: WorkflowTemplate['stack'] = 'nestjs',
): WorkflowTemplate => ({
  id: 'be-nestjs',
  name: 'Backend API',
  description: 'NestJS service pipeline',
  iconName: 'server',
  categories: ['backend'],
  filePatterns: ['**/*.ts'],
  stack,
  propertiesPath: '/properties.json',
  workflowPath: '/template.yml',
});

interface ParsedWorkflow {
  name: string;
  on: {
    workflow_run?: { workflows: string[] };
  };
  jobs: Record<
    string,
    | {
        if?: string;
        needs?: string[];
        uses?: string;
        with?: Record<string, unknown>;
        secrets?: Record<string, string> | string;
        steps?: Array<{
          run?: string;
          env?: Record<string, string>;
        }>;
      }
    | undefined
  >;
}

describe('buildStagedWorkflowBundle', () => {
  const workflowFragmentRegistry = new WorkflowFragmentRegistry([
    renderWorkflowFragment,
    vercelWorkflowFragment,
  ]);
  it('resolves platform callback URLs from deployment configuration', () => {
    expect(
      resolvePlatformBaseUrl({
        PLATFORM_PUBLIC_URL: 'https://alphaci-api.example.com/api/v1/',
      }),
    ).toBe('https://alphaci-api.example.com');

    expect(
      resolvePlatformBaseUrl({
        GITHUB_CALLBACK_URL:
          'https://alphaci-api.example.com/api/v1/auth/github/callback',
      }),
    ).toBe('https://alphaci-api.example.com');

    expect(resolvePlatformBaseUrl({})).toBe('http://localhost:4000');
  });

  it('defaults the central workflow ref to v1 but honors CENTRAL_WORKFLOW_REF', () => {
    expect(resolveDefaultCentralWorkflowRef({})).toBe('v1');
    expect(
      resolveDefaultCentralWorkflowRef({ CENTRAL_WORKFLOW_REF: 'internal-v1' }),
    ).toBe('internal-v1');
    // Blank/whitespace falls back to v1.
    expect(
      resolveDefaultCentralWorkflowRef({ CENTRAL_WORKFLOW_REF: '  ' }),
    ).toBe('v1');
  });

  it('pins internal pipelines to internal-v1 when the ref is provided', () => {
    const bundle = buildStagedWorkflowBundle(makeTemplate(), {
      templateId: 'be-nestjs',
      serviceName: 'payments',
      centralWorkflowRef: 'internal-v1',
    });
    const allYaml = bundle.workflowFiles.map((f) => f.yaml).join('\n');
    expect(allYaml).toContain('@internal-v1');
    expect(allYaml).not.toContain('lint-check.yml@v1');
  });

  it('emits the staged bundle plus env guard with unsuffixed names and paths by default', () => {
    const bundle = buildStagedWorkflowBundle(makeTemplate(), {
      templateId: 'be-nestjs',
      serviceName: 'orders-api',
    });

    expect(bundle.workflowFiles.map((file) => file.path)).toEqual([
      '.github/workflows/00-alphaci-access.yml',
      '.github/workflows/10-alphaci-quality.yml',
      '.github/workflows/20-alphaci-package.yml',
      '.github/workflows/05-alphaci-env-guard.yml',
    ]);
    expect(bundle.workflowFiles.map((file) => file.name)).toEqual([
      'ALPHACI 1 Access',
      'ALPHACI 2 Quality',
      'ALPHACI 3 Build and Deploy',
      'ALPHACI Env Guard',
    ]);
  });

  it('triggers generated workflows for the dev, uat and main promotion flow', () => {
    const bundle = buildStagedWorkflowBundle(makeTemplate(), {
      templateId: 'be-nestjs',
      serviceName: 'orders-api',
    });
    const access = yaml.load(bundle.workflowFiles[0]!.yaml) as Record<
      string,
      unknown
    >;

    expect(access['on']).toEqual({
      push: { branches: ['dev', 'uat', 'main'] },
      pull_request: { branches: ['dev', 'uat', 'main'] },
      workflow_dispatch: {},
    });
  });

  it('includes a best-effort report-results job in every stage', () => {
    const bundle = buildStagedWorkflowBundle(makeTemplate(), {
      templateId: 'be-nestjs',
      serviceName: 'orders-api',
    });

    // the standalone env guard never reports to the platform
    for (const file of bundle.workflowFiles.filter(
      (item) => item.stage !== 'guard',
    )) {
      const wf = yaml.load(file.yaml) as ParsedWorkflow;
      const reportJob = wf.jobs['report-results'];

      expect(reportJob).toBeDefined();
      // must always run, even on failure or cancellation
      expect(reportJob?.if).toBe('${{ always() }}');
    }

    // access: only needs validate-access
    const access = yaml.load(bundle.workflowFiles[0]!.yaml) as ParsedWorkflow;
    expect(access.jobs['report-results']?.needs).toEqual(['validate-access']);

    // quality: needs every substantive quality job
    const quality = yaml.load(bundle.workflowFiles[1]!.yaml) as ParsedWorkflow;
    expect(quality.jobs['report-results']?.needs).toContain('backend-tests');
    expect(quality.jobs['report-results']?.needs).toContain('sonar');
    expect(quality.jobs['report-results']?.needs).toContain('typecheck');

    // package: needs validate-access + build
    const pkg = yaml.load(bundle.workflowFiles[2]!.yaml) as ParsedWorkflow;
    expect(pkg.jobs['report-results']?.needs).toEqual([
      'pipeline-context',
      'validate-access',
      'build',
    ]);
  });

  it('quality report step reads coverage from upstream job outputs, not local files', () => {
    const bundle = buildStagedWorkflowBundle(makeTemplate(), {
      templateId: 'be-nestjs',
      serviceName: 'orders-api',
    });

    const qualityYaml = bundle.workflowFiles[1]!.yaml;
    // test job must still emit a JSON summary (consumed by the test runner itself)
    expect(qualityYaml).toContain('--json');
    expect(qualityYaml).toContain('--outputFile=test-results.json');
    // report step must read coverage from the upstream test job output and branch-policy output,
    // not parse local coverage-summary.json (which does not exist on the fresh report runner)
    expect(qualityYaml).toContain(
      'needs.backend-tests.outputs.coverage-percent',
    );
    expect(qualityYaml).toContain(
      'needs.branch-policy.outputs.coverage-threshold',
    );
    // must NOT reference the dead local file path
    expect(qualityYaml).not.toContain('coverage/coverage-summary.json');
    // payload must be built with jq, not a heredoc interpolating context values
    expect(qualityYaml).toContain('jq -n');
    // curl must POST to ALPHACI_REPORT_URL with ALPHACI_TOKEN
    expect(qualityYaml).toContain('ALPHACI_REPORT_URL');
    expect(qualityYaml).toContain('ALPHACI_TOKEN');
  });

  it('all three stages expose ALPHACI_REPORT_URL in env and curl uses it', () => {
    const bundle = buildStagedWorkflowBundle(makeTemplate(), {
      templateId: 'be-nestjs',
      serviceName: 'orders-api',
    });

    for (const file of bundle.workflowFiles.filter(
      (item) => item.stage !== 'guard',
    )) {
      expect(file.yaml).toContain('ALPHACI_REPORT_URL');
      expect(file.yaml).toContain('FAILED_JOBS');
      expect(file.yaml).toContain('rawLogs');
      // graceful degradation: curl failure must not fail the pipeline
      expect(file.yaml).toContain(
        '|| echo "::warning::Failed to report pipeline results to ALPHACI"',
      );
    }
  });

  it('suffixes paths and workflow names for a variant so slots do not collide', () => {
    const bundle = buildStagedWorkflowBundle(makeTemplate(), {
      templateId: 'be-nestjs',
      serviceName: 'orders-api',
      servicePath: 'backend',
      workflowVariant: 'backend',
    });

    expect(bundle.workflowFiles.map((file) => file.path)).toEqual([
      '.github/workflows/00-alphaci-access-backend.yml',
      '.github/workflows/10-alphaci-quality-backend.yml',
      '.github/workflows/20-alphaci-package-backend.yml',
      // repo-wide env guard rides with the backend bundle, unsuffixed
      '.github/workflows/05-alphaci-env-guard.yml',
    ]);

    const quality = yaml.load(bundle.workflowFiles[1]!.yaml) as ParsedWorkflow;
    const pkg = yaml.load(bundle.workflowFiles[2]!.yaml) as ParsedWorkflow;

    expect(quality.name).toBe('ALPHACI 2 Quality (backend)');
    expect(quality.on.workflow_run?.workflows).toEqual([
      'ALPHACI 1 Access (backend)',
    ]);
    expect(pkg.name).toBe('ALPHACI 3 Build and Deploy (backend)');
    expect(pkg.on.workflow_run?.workflows).toEqual([
      'ALPHACI 2 Quality (backend)',
    ]);
  });

  it('produces disjoint file sets for backend and frontend variants', () => {
    const backend = buildStagedWorkflowBundle(makeTemplate('nestjs'), {
      templateId: 'be-nestjs',
      serviceName: 'orders-api',
      workflowVariant: 'backend',
    });
    const frontend = buildStagedWorkflowBundle(makeTemplate('nextjs'), {
      templateId: 'fe-nextjs',
      serviceName: 'orders-web',
      workflowVariant: 'frontend',
    });

    const backendPaths = new Set(backend.workflowFiles.map((f) => f.path));
    for (const file of frontend.workflowFiles) {
      expect(backendPaths.has(file.path)).toBe(false);
    }
  });

  it('normalizes trailing slashes in servicePath for working-directory inputs', () => {
    const bundle = buildStagedWorkflowBundle(makeTemplate(), {
      templateId: 'be-nestjs',
      serviceName: 'orders-api',
      servicePath: 'backend/',
    });

    const quality = yaml.load(bundle.workflowFiles[1]!.yaml) as ParsedWorkflow;
    expect(quality.jobs['backend-tests']?.with?.['working-directory']).toBe(
      'backend',
    );
    expect(quality.jobs['lint']?.with?.['working-directory']).toBe('backend');
    expect(quality.jobs['typecheck']).toBeDefined();
  });

  it('selects the backend or frontend test workflow based on the template stack', () => {
    const backend = buildStagedWorkflowBundle(makeTemplate('nodejs'), {
      templateId: 'be-nodejs',
      serviceName: 'orders-api',
    });
    const frontend = buildStagedWorkflowBundle(makeTemplate('react'), {
      templateId: 'fe-react',
      serviceName: 'orders-web',
    });

    expect(backend.workflowFiles[1]!.yaml).toContain('backend-tests.yml@v1');
    expect(frontend.workflowFiles[1]!.yaml).toContain('frontend-tests.yml@v1');
  });

  it('enforces tests/unit for scaffolded repos and falls back to src for BYO', () => {
    const scaffolded = buildStagedWorkflowBundle(makeTemplate('react'), {
      templateId: 'fe-react',
      serviceName: 'orders-web',
      hasTestsDirectory: true,
    });
    const byo = buildStagedWorkflowBundle(makeTemplate('react'), {
      templateId: 'fe-react',
      serviceName: 'orders-web',
    });

    const scaffoldedQuality = yaml.load(
      scaffolded.workflowFiles[1]!.yaml,
    ) as ParsedWorkflow;
    const byoQuality = yaml.load(byo.workflowFiles[1]!.yaml) as ParsedWorkflow;

    expect(
      scaffoldedQuality.jobs['frontend-tests']?.with?.['unit-tests-directory'],
    ).toBe('tests/unit');
    expect(scaffoldedQuality.jobs['sonar']?.with?.['tests-path']).toBe(
      'src,tests',
    );

    expect(
      byoQuality.jobs['frontend-tests']?.with?.['unit-tests-directory'],
    ).toBe('src');
    expect(byoQuality.jobs['sonar']?.with?.['tests-path']).toBe('src');
  });

  it('resolves per-branch governance through the branch-policy job', () => {
    const bundle = buildStagedWorkflowBundle(makeTemplate(), {
      templateId: 'be-nestjs',
      serviceName: 'orders-api',
      coverageThreshold: 80,
    });

    const quality = yaml.load(bundle.workflowFiles[1]!.yaml) as ParsedWorkflow;
    const policy = bundle.workflowFiles[1]!.yaml;

    // strict profile (uat/main) bumps coverage by 10; baseline stays at 80
    expect(policy).toContain('COVERAGE_THRESHOLD=90');
    expect(policy).toContain('COVERAGE_THRESHOLD=80');
    // branch resolution must use the originating branch, not ref_name alone
    expect(policy).toContain(
      'github.event.workflow_run.head_branch || github.ref_name',
    );

    expect(quality.jobs['backend-tests']?.with?.['coverage-threshold']).toBe(
      '${{ fromJson(needs.branch-policy.outputs.coverage-threshold) }}',
    );
    expect(quality.jobs['lint']?.with?.['fail-on-warning']).toBe(
      '${{ fromJson(needs.branch-policy.outputs.fail-on-warning) }}',
    );
  });

  it('adds a dedicated typecheck job to the quality stage', () => {
    const bundle = buildStagedWorkflowBundle(makeTemplate('nextjs'), {
      templateId: 'fe-nextjs',
      serviceName: 'orders-web',
      servicePath: 'frontend',
      nodeVersion: '24',
    });

    const quality = yaml.load(bundle.workflowFiles[1]!.yaml) as ParsedWorkflow;
    const typecheck = quality.jobs['typecheck'];
    const qualityYaml = bundle.workflowFiles[1]!.yaml;

    expect(typecheck?.needs).toEqual(['pipeline-context', 'branch-policy']);
    expect(qualityYaml).toContain('working-directory: ./frontend');
    expect(qualityYaml).toContain('npm run typecheck');
    expect(qualityYaml).toContain('npx tsc --noEmit');
    expect(qualityYaml).toContain(
      'github.event.workflow_run.head_sha || github.sha',
    );
  });

  it('caps the strict coverage threshold at 95', () => {
    const bundle = buildStagedWorkflowBundle(makeTemplate(), {
      templateId: 'be-nestjs',
      serviceName: 'orders-api',
      coverageThreshold: 92,
    });

    expect(bundle.workflowFiles[1]!.yaml).toContain('COVERAGE_THRESHOLD=95');
  });

  it('adds a secret-gated SonarCloud job that consumes the coverage artifact', () => {
    const bundle = buildStagedWorkflowBundle(makeTemplate(), {
      templateId: 'be-nestjs',
      serviceName: 'orders-api',
    });

    const quality = yaml.load(bundle.workflowFiles[1]!.yaml) as ParsedWorkflow;
    const sonar = quality.jobs['sonar'];

    expect(sonar?.uses).toBe(
      'Alpha-Explora/alphaci-workflow/.github/workflows/sonarcloud-scan.yml@v1',
    );
    expect(sonar?.if).toBe(
      "${{ needs.branch-policy.outputs.sonar-enabled == 'true' }}",
    );
    expect(sonar?.needs).toEqual([
      'pipeline-context',
      'branch-policy',
      'backend-tests',
    ]);
    expect(sonar?.with?.['coverage-artifact-name']).toBe('orders-api-coverage');
    expect(sonar?.secrets).toEqual({
      SONAR_TOKEN: '${{ secrets.SONAR_TOKEN }}',
      SONAR_PROJECT_KEY: '${{ secrets.SONAR_PROJECT_KEY }}',
      SONAR_ORGANIZATION: '${{ secrets.SONAR_ORGANIZATION }}',
    });
    // sonar needs lcov in the coverage artifact
    expect(quality.jobs['backend-tests']?.with?.['test-command']).toContain(
      '--coverageReporters=lcov',
    );
  });

  it('gates main behind the production-gate job in the package stage', () => {
    const bundle = buildStagedWorkflowBundle(makeTemplate(), {
      templateId: 'be-nestjs',
      serviceName: 'orders-api',
      enhancements: ['strictProductionApproval'],
    });

    const pkg = yaml.load(bundle.workflowFiles[2]!.yaml) as ParsedWorkflow;
    const gate = pkg.jobs['production-gate'];

    expect(gate?.uses).toBe(
      'Alpha-Explora/alphaci-workflow/.github/workflows/production-gate.yml@v1',
    );
    expect(gate?.if).toBe(
      "${{ (needs.pipeline-context.outputs.branch) == 'main' }}",
    );
    expect(gate?.with?.['app-type']).toBe('api');
    expect(gate?.with?.['require-approval']).toBe(true);
  });

  it('emits branch-scoped Vercel deploy jobs when deployment targets are present', () => {
    const bundle = buildStagedWorkflowBundle(
      makeTemplate('nextjs'),
      {
        templateId: 'fe-nextjs',
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
      },
      workflowFragmentRegistry,
    );

    const pkg = yaml.load(bundle.workflowFiles[2]!.yaml) as ParsedWorkflow;
    const packageYaml = bundle.workflowFiles[2]!.yaml;

    expect(pkg.jobs['deploy-vercel-standalone-uat']?.uses).toBe(
      'Alpha-Explora/alphaci-workflow/.github/workflows/vercel-deploy.yml@v1',
    );
    expect(pkg.jobs['deploy-vercel-standalone-uat']?.with?.environment).toBe(
      'preview',
    );
    expect(pkg.jobs['deploy-vercel-standalone-main']?.with?.environment).toBe(
      'production',
    );
    expect(packageYaml).toContain('VERCEL_TOKEN_STANDALONE');
  });

  it('does not emit Render deploy jobs without deployment target details', () => {
    const bundle = buildStagedWorkflowBundle(makeTemplate(), {
      templateId: 'be-nestjs',
      serviceName: 'orders-api',
      deploymentProvider: 'render',
    });

    const pkg = yaml.load(bundle.workflowFiles[2]!.yaml) as ParsedWorkflow;
    const packageYaml = bundle.workflowFiles[2]!.yaml;

    expect(pkg.jobs['deploy-render']).toBeUndefined();
    expect(packageYaml).not.toContain('render-deploy.yml');
  });

  it('emits Render docker and deploy jobs per branch when targets are present', () => {
    const bundle = buildStagedWorkflowBundle(
      makeTemplate(),
      {
        templateId: 'be-nestjs',
        serviceName: 'orders-api',
        deploymentTargets: [
          {
            slot: 'backend',
            provider: 'render',
            branchName: 'uat',
            deploymentStrategy: 'render_image_pushed',
            dockerContext: 'backend',
            dockerfilePath: 'Dockerfile',
            imageName: 'alphaci-backend-uat-orders-api',
          },
        ],
      },
      workflowFragmentRegistry,
    );

    const pkg = yaml.load(bundle.workflowFiles[2]!.yaml) as ParsedWorkflow;

    expect(pkg.jobs['docker-backend-uat']?.uses).toBe(
      'Alpha-Explora/alphaci-workflow/.github/workflows/docker-build.yml@v1',
    );
    // Host-neutral: the pipeline asks the platform to release what it built,
    // so the job names no host and carries no hosting credential.
    expect(pkg.jobs['deploy-render-backend-uat']?.uses).toBe(
      'Alpha-Explora/alphaci-workflow/.github/workflows/release.yml@v1',
    );
    expect(
      Object.keys(pkg.jobs['deploy-render-backend-uat']?.secrets ?? {}),
    ).toEqual(['ALPHACI_TOKEN', 'ALPHACI_API_URL']);
    expect(pkg.jobs['deploy-render-backend-uat']?.needs).toEqual([
      'pipeline-context',
      'docker-backend-uat',
    ]);
  });

  it('creates one promotion PR job per hop, each gated to its source branch', () => {
    const bundle = buildStagedWorkflowBundle(makeTemplate(), {
      templateId: 'be-nestjs',
      serviceName: 'orders-api',
    });

    const pkg = yaml.load(bundle.workflowFiles[2]!.yaml) as ParsedWorkflow;
    const toUat = pkg.jobs['promote-to-uat'];
    const toMain = pkg.jobs['promote-to-main'];

    for (const job of [toUat, toMain]) {
      expect(job?.uses).toBe(
        'Alpha-Explora/alphaci-workflow/.github/workflows/promotion.yml@v1',
      );
      expect(job?.with?.['system1-name']).toBe('orders-api');
      expect(job?.secrets).toEqual({
        PR_TOKEN:
          "${{ secrets.GH_PR_TOKEN != '' && secrets.GH_PR_TOKEN || github.token }}",
      });
    }

    // Both jobs exist in every generated pipeline; the branch gate is what
    // decides which one acts, so a run on dev cannot open the production PR.
    expect(toUat?.with?.['direction']).toBe('dev-to-uat');
    expect(toUat?.if).toContain("== 'dev'");
    expect(toUat?.if).not.toContain("== 'uat'");

    expect(toMain?.with?.['direction']).toBe('uat-to-main');
    expect(toMain?.if).toContain("== 'uat'");
    expect(toMain?.if).not.toContain("== 'dev'");
  });

  it('keeps promotion independent when no deployment targets are present', () => {
    const bundle = buildStagedWorkflowBundle(makeTemplate(), {
      templateId: 'be-nestjs',
      serviceName: 'orders-api',
      deploymentProvider: 'render',
    });

    const pkg = yaml.load(bundle.workflowFiles[2]!.yaml) as ParsedWorkflow;
    const toMain = pkg.jobs['promote-to-main'];

    expect(toMain?.needs).toEqual(['pipeline-context', 'build']);
    expect(toMain?.if).not.toContain('deploy-render');
  });

  describe('env guard workflow', () => {
    const guardOf = (variant?: 'backend' | 'frontend') => {
      const bundle = buildStagedWorkflowBundle(makeTemplate(), {
        templateId: 'be-nestjs',
        serviceName: 'orders-api',
        ...(variant !== undefined && { workflowVariant: variant }),
      });
      return bundle.workflowFiles.find((file) => file.stage === 'guard');
    };

    it('is included once per repo: default and backend variants only', () => {
      expect(guardOf()).toBeDefined();
      expect(guardOf('backend')).toBeDefined();
      expect(guardOf('frontend')).toBeUndefined();
    });

    it('watches every promotion-flow branch on push and pull request', () => {
      const guard = guardOf()!;
      const wf = yaml.load(guard.yaml) as Record<string, unknown>;

      expect(wf['on']).toEqual({
        push: { branches: ['dev', 'uat', 'main'] },
        pull_request: { branches: ['dev', 'uat', 'main'] },
      });
      expect(wf['permissions']).toEqual({
        contents: 'write',
        issues: 'write',
      });
      // job id must match the branch-protection required context
      const jobs = wf['jobs'] as Record<string, unknown>;
      expect(Object.keys(jobs)).toEqual(['env-guard']);
    });

    it('detects dotenv files but allows committable placeholders', () => {
      const guard = guardOf()!;
      expect(guard.yaml).toContain('git ls-files');
      // .env, .env.local, nested backend/.env.production are all matched
      expect(guard.yaml).toContain('(^|/)\\.env(\\.[^/]*)?$');
      // the scaffold ships .env.example and must never trip the guard
      expect(guard.yaml).toContain('(^|/)\\.env\\.(example|sample|template)$');
    });

    it('rolls back on push, skips CI on the rollback commit, and fails the run', () => {
      const guard = guardOf()!;
      expect(guard.yaml).toContain('git rm --quiet --ignore-unmatch');
      expect(guard.yaml).toContain('[skip ci]');
      expect(guard.yaml).toContain('rotate any exposed secrets');
      expect(guard.yaml).toContain('gh issue create');
      expect(guard.yaml).toContain('exit 1');
      // write steps must never run for pull_request events (fork tokens are read-only)
      expect(guard.yaml).toContain("github.event_name == 'push'");
    });
  });
});

describe('failure capture in the reporting job', () => {
  const reportScript = (): string => {
    const bundle = buildStagedWorkflowBundle(makeTemplate(), {
      templateId: 'be-nestjs',
      serviceName: 'orders-api',
    });
    const quality = bundle.workflowFiles.find((file) =>
      file.path.includes('10-alphaci-quality'),
    );
    const parsed = yaml.load(quality!.yaml) as {
      jobs: Record<
        string,
        { permissions?: Record<string, string>; steps?: { run?: string }[] }
      >;
    };
    return parsed.jobs['report-results']!.steps![0]!.run!;
  };

  /*
   * The bug this exists to prevent: the capture worked on every public test
   * repo and on none of the private ones, because `permissions:` sets every
   * unlisted scope to none and the jobs API needs `actions: read` unless the
   * repository is public. `|| true` swallowed the 401, so the product recorded
   * a failure with nothing said about it — on private repos, which is what
   * real customers use.
   */
  it('grants the reporting job the scopes its API calls need', () => {
    const bundle = buildStagedWorkflowBundle(makeTemplate(), {
      templateId: 'be-nestjs',
      serviceName: 'orders-api',
    });
    const quality = bundle.workflowFiles.find((file) =>
      file.path.includes('10-alphaci-quality'),
    );
    const parsed = yaml.load(quality!.yaml) as {
      jobs: Record<string, { permissions?: Record<string, string> }>;
    };

    expect(parsed.jobs['report-results']!.permissions).toEqual({
      contents: 'read',
      actions: 'read',
      statuses: 'write',
      checks: 'read',
    });
  });

  it('keeps jq string interpolation intact through the JS string literal', () => {
    // A single backslash would be eaten by JS, leaving jq to emit the literal
    // text "($job.name)" instead of the job's name. Only the emitted script
    // shows whether the escaping survived.
    const script = reportScript();

    expect(script).toContain('\\($job.name)');
    expect(script).not.toContain('"Failed GitHub Actions job: ($job.name)"');
  });

  it('names the step that failed, not just the job', () => {
    expect(reportScript()).toContain('$job.steps[]?');
  });

  it('collects annotations and sends them with the report', () => {
    const script = reportScript();

    expect(script).toContain('/check-runs/$JOB_ID/annotations');
    expect(script).toContain('annotations:$annotations');
    expect(script).toContain('--argjson annotations "$ANNOTATIONS"');
  });

  it('keeps the shell line continuations that build the payload', () => {
    // One trailing backslash continues the jq command onto the next line.
    // Two would end it, and jq would be handed a truncated argument list.
    const line = reportScript()
      .split('\n')
      .find((l) => l.includes('--argjson annotations'));

    expect(line).toBeDefined();
    expect(line!.endsWith('\\')).toBe(true);
    expect(line!.endsWith('\\\\')).toBe(false);
  });
});

describe('test results in the reporting payload', () => {
  const qualityStep = (): { run: string; env: Record<string, string> } => {
    const bundle = buildStagedWorkflowBundle(makeTemplate('dotnet'), {
      templateId: 'dotnet-service-pipeline',
      serviceName: 'orders-api',
    });
    const quality = bundle.workflowFiles.find((file) =>
      file.path.includes('10-alphaci-quality'),
    );
    const parsed = yaml.load(quality!.yaml) as {
      jobs: Record<
        string,
        { steps?: { run?: string; env?: Record<string, string> }[] }
      >;
    };
    const step = parsed.jobs['report-results']!.steps![0]!;
    return { run: step.run!, env: step.env ?? {} };
  };

  /*
   * translate-results.ts could already turn counts into "2 test(s) failed"
   * with the failing names listed, and had been able to since it was written.
   * The pipeline never sent them: RESULTS only ever carried coverage, so that
   * whole path was unreachable and every failing test showed up as a job name.
   */
  it('reads the test outputs the central workflow publishes', () => {
    const { env } = qualityStep();

    expect(env['TESTS_TOTAL']).toContain('outputs.tests-total');
    expect(env['TESTS_FAILED']).toContain('outputs.tests-failed');
    expect(env['TESTS_FAILURES']).toContain('outputs.tests-failures');
  });

  /*
   * The same story as the tests: both audit workflows already had the findings
   * and published only a count, or only echoed them. `security` was as
   * unreachable in the translator as `tests` was.
   */
  it('reads the vulnerability outputs the security job publishes', () => {
    const { env } = qualityStep();

    expect(env['VULN_CRITICAL']).toContain(
      'needs.security.outputs.vulnerabilities-critical',
    );
    expect(env['VULN_HIGH']).toContain(
      'needs.security.outputs.vulnerabilities-high',
    );
    expect(env['VULN_ITEMS']).toContain(
      'needs.security.outputs.vulnerabilities-items',
    );
  });

  it('builds a security object with the fields CiResults declares', () => {
    const { run } = qualityStep();

    expect(run).toContain('--argjson critical "${VULN_CRITICAL:-0}"');
    expect(run).toContain('--argjson items "${VULN_ITEMS:-[]}"');
    expect(run).toContain('{critical:$critical,high:$high,items:$items}');
    expect(run).toContain('. + {security:$security}');
  });

  it('omits security when the security job published nothing', () => {
    const { run } = qualityStep();

    expect(run).toContain('if echo "$VULN_CRITICAL$VULN_HIGH" | grep -qE');
  });

  it('builds a tests object with the fields CiResults declares', () => {
    const { run } = qualityStep();

    expect(run).toContain('--argjson total "$TESTS_TOTAL"');
    expect(run).toContain('--argjson failures "${TESTS_FAILURES:-[]}"');
    expect(run).toContain(
      '{total:$total,passed:$passed,failed:$failed,failures:$failures}',
    );
    expect(run).toContain('. + {tests:$tests}');
  });

  it('omits tests when the central workflow published nothing', () => {
    // An older centralWorkflowRef has no such outputs, so the variables arrive
    // empty. Guarding on a numeric, non-zero total keeps that pipeline
    // reporting exactly as it did rather than posting a malformed payload.
    const { run } = qualityStep();

    expect(run).toContain('if echo "$TESTS_TOTAL" | grep -qE');
    expect(run).toContain('[ "$TESTS_TOTAL" -gt 0 ]');
  });

  it('still sends coverage alongside, not instead', () => {
    const { run } = qualityStep();

    expect(run).toContain('"coverage":{"pct":$pct,"threshold":$threshold}');
  });
});

describe('annotation capture keeps the real diagnostics', () => {
  const captureLine = (): string => {
    const bundle = buildStagedWorkflowBundle(makeTemplate('dotnet'), {
      templateId: 'dotnet-service-pipeline',
      serviceName: 'orders-api',
    });
    const quality = bundle.workflowFiles.find((file) =>
      file.path.includes('10-alphaci-quality'),
    );
    const parsed = yaml.load(quality!.yaml) as {
      jobs: Record<string, { steps?: { run?: string }[] }>;
    };
    const run = parsed.jobs['report-results']!.steps![0]!.run!;
    // The jq program itself, not the surrounding comments — which mention the
    // old filter by name in explaining why it was wrong.
    return run.split('\n').find((line) => line.includes('unique_by'))!;
  };

  /*
   * Verified against the live annotations of the failing SonarCloud job on
   * Alphaexplora-Sandbox/testapp1234 (check run 102388067502): nine raw
   * annotations reduce to the four real diagnostics.
   *
   * The previous filter kept `annotation_level == "failure"` only, which is
   * the one annotation that says nothing — the runner's own "Process completed
   * with exit code 1", whose path is the workflow file. Every diagnostic
   * naming a real problem arrives at WARNING level, because that is how Roslyn
   * analyzers and formatters report.
   */
  it('does not filter on annotation_level, which dropped every real one', () => {
    expect(captureLine()).not.toContain('annotation_level == "failure"');
  });

  it('drops annotations pointing at the workflow file rather than the code', () => {
    expect(captureLine()).toContain('startswith(".github")');
  });

  it("drops the runner's own exit-code notice", () => {
    expect(captureLine()).toContain('Process completed with exit code');
  });

  it('deduplicates, since a second build pass repeats every diagnostic', () => {
    expect(captureLine()).toContain('unique_by([.path, .line, .message])');
  });

  it('keeps the location, which is the point of an annotation', () => {
    const line = captureLine();

    expect(line).toContain('path: .path');
    expect(line).toContain('line: .start_line');
    expect(line).toContain('message: .message');
  });
});

/*
 * A stage that did no work must report nothing at all.
 *
 * These exist because of 24 rows. Every `package` report the platform had ever
 * stored said `success` with an empty payload, and the quality stage that gates
 * it had never once passed — so the package stage had never legitimately run,
 * and every one of those successes was invented. Two skips produced them:
 * the access gate skipping when the previous stage failed, and `build` skipping
 * on a pull request, whose head branch is the PR branch rather than dev.
 *
 * `skipped` is neither `failure` nor `cancelled`, so both fell through to the
 * final `else` and were graded a success. Reporting nothing is the honest
 * answer and also the useful one: a stage with no report resolves to `blocked`.
 */
describe('a stage that never ran reports nothing', () => {
  const stageStep = (
    pathFragment: string,
  ): { run: string; env: Record<string, string> } => {
    const bundle = buildStagedWorkflowBundle(makeTemplate('dotnet'), {
      templateId: 'dotnet-service-pipeline',
      serviceName: 'orders-api',
    });
    const file = bundle.workflowFiles.find((candidate) =>
      candidate.path.includes(pathFragment),
    );
    const parsed = yaml.load(file!.yaml) as {
      jobs: Record<
        string,
        { steps?: { run?: string; env?: Record<string, string> }[] }
      >;
    };
    const step = parsed.jobs['report-results']!.steps![0]!;
    return { run: step.run!, env: step.env ?? {} };
  };

  /*
   * The precise fix. `contains(needs.*.result, 'success')` spans every job in
   * `needs`, and `validate-access` is in every stage's needs — so the signal
   * went true the moment the gate passed, which says nothing about whether the
   * stage built anything. Reading `build` alone is the whole difference.
   */
  it('asks whether the package stage built, not whether its gate passed', () => {
    const { env } = stageStep('20-alphaci-package');

    expect(env['STAGE_WORK_RAN']).toBe(
      "${{ needs.build.result != 'skipped' }}",
    );
  });

  it('ignores the gate, the policy job and Sonar in the quality stage', () => {
    const { env } = stageStep('10-alphaci-quality');

    // Sonar is secret-gated and skips wherever it is unconfigured; the policy
    // job and the access gate run regardless of whether any check does. None
    // of the three can stand in for "the quality stage ran".
    expect(env['STAGE_WORK_RAN']).not.toContain('validate-access');
    expect(env['STAGE_WORK_RAN']).not.toContain('branch-policy');
    expect(env['STAGE_WORK_RAN']).not.toContain('sonar');
    expect(env['STAGE_WORK_RAN']).toContain(
      "needs.dotnet-tests.result != 'skipped'",
    );
  });

  it('gives every stage the guard, so none can report a phantom', () => {
    for (const fragment of [
      '00-alphaci-access',
      '10-alphaci-quality',
      '20-alphaci-package',
    ]) {
      const { run, env } = stageStep(fragment);

      expect(env['STAGE_WORK_RAN']).toBeDefined();
      expect(run).toContain('"$STAGE_WORK_RAN" != "true"');
      // The old signal graded a skip as a success. It must be gone, not
      // merely unread — an unused env var invites a future reader to key on it.
      expect(env['STAGE_SUCCEEDED']).toBeUndefined();
      expect(run).not.toContain('STAGE_SUCCEEDED');
    }
  });

  /*
   * Order is the correctness condition, not a style choice.
   *
   * A failure has to be tested before the guard: when the access gate FAILS,
   * the work skips too, so a guard placed first would swallow a real failure
   * and report nothing. Testing failure and cancellation first means the guard
   * only ever catches the case where nothing went wrong because nothing ran.
   */
  it('lets a real failure outrank the guard', () => {
    const lines = stageStep('20-alphaci-package')
      .run.split('\n')
      .map((line) => line.trim());

    const failed = lines.findIndex((line) =>
      line.startsWith('if [ "$STAGE_FAILED"'),
    );
    const cancelled = lines.findIndex((line) =>
      line.startsWith('elif [ "$STAGE_CANCELLED"'),
    );
    const workRan = lines.findIndex((line) =>
      line.startsWith('elif [ "$STAGE_WORK_RAN"'),
    );

    expect(failed).toBeGreaterThanOrEqual(0);
    expect(cancelled).toBeGreaterThan(failed);
    expect(workRan).toBeGreaterThan(cancelled);
  });

  it('leaves before it can send anything', () => {
    const run = stageStep('20-alphaci-package').run;

    const guard = run.indexOf('"$STAGE_WORK_RAN" != "true"');
    const exit = run.indexOf('exit 0', guard);

    expect(guard).toBeGreaterThan(-1);
    expect(exit).toBeGreaterThan(guard);

    /*
     * Nothing reaches the network between the guard and its exit.
     *
     * Checked over the branch itself rather than by asking where the first
     * `curl` in the script appears. The status helper is a function DEFINITION
     * containing a curl, and it has to be defined up front so every path that
     * reaches a verdict can call it — a definition is not a request, and the
     * cruder test read it as one.
     */
    const branch = run.slice(guard, exit);

    expect(branch).not.toContain('curl');
    expect(branch).not.toContain('post_commit_status ');
  });

  /*
   * A stage that did no work must not put a green status on the commit.
   *
   * It would claim the commit cleared a stage that never examined it — the
   * same false claim as a package row recording a build of nothing as a
   * successful deploy, moved to the one place that decides whether code
   * reaches uat and main.
   */
  /*
   * A chained stage runs via `workflow_run`, and GitHub does not attach those
   * runs to a pull request as checks. So the stage that runs the tests was
   * invisible to branch protection, which could only require `env-guard` - five
   * seconds, environment variables - and a pull request into uat could be
   * merged with every test failing. A commit status is the one verdict from a
   * workflow_run chain that protection can see.
   */
  describe('the commit status a stage puts on its commit', () => {
    const reportRun = (file: string) => stageStep(file).run;

    it('posts to the statuses API for the sha pipeline-context resolved', () => {
      const run = reportRun('10-alphaci-quality');

      expect(run).toContain(
        'https://api.github.com/repos/${GH_REPO}/statuses/${GH_SHA}',
      );
    });

    it('names a context per stage, so each can be required separately', () => {
      const bundle = buildStagedWorkflowBundle(makeTemplate(), {
        templateId: 'be-nestjs',
        serviceName: 'orders-api',
      });

      const contextFor = (path: string) => {
        const parsed = yaml.load(
          bundle.workflowFiles.find((f) => f.path.includes(path))!.yaml,
        ) as {
          jobs: Record<string, { steps?: { env?: Record<string, string> }[] }>;
        };
        return parsed.jobs['report-results']!.steps!.map(
          (step) => step.env?.['STATUS_CONTEXT'],
        ).find(Boolean);
      };

      expect(contextFor('10-alphaci-quality')).toBe('alphaci/quality');
      expect(contextFor('20-alphaci-package')).toBe('alphaci/package');
      expect(contextFor('00-alphaci-access')).toBe('alphaci/access');
    });

    it('reports a verdict on every path that reaches one', () => {
      const run = reportRun('10-alphaci-quality');

      expect(run).toContain('post_commit_status "failure"');
      expect(run).toContain('post_commit_status "error"');
      expect(run).toContain('post_commit_status "success"');
    });

    /*
     * Defined before the branch that exits, because a REQUIRED status that
     * never arrives leaves a pull request pending for ever. Blocking every
     * merge would be a worse failure than the one this prevents.
     */
    it('defines the helper before anything can exit', () => {
      const run = reportRun('10-alphaci-quality');

      expect(run.indexOf('post_commit_status() {')).toBeLessThan(
        run.indexOf('exit 0'),
      );
    });

    /*
     * A green pipeline must not turn red because GitHub would not take a
     * status - but a silently broken status path is how a gate stops gating
     * without anyone noticing, so it warns rather than passing in silence.
     */
    it('never fails the stage, and never fails it quietly', () => {
      const run = reportRun('10-alphaci-quality');

      expect(run).toContain('|| echo "::warning::Could not post the');
      expect(run).toContain('Branch protection requiring it');
    });

    it('says so rather than posting against an empty sha', () => {
      const run = reportRun('10-alphaci-quality');

      expect(run).toContain('if [ -z "${GH_SHA}" ]; then');
      expect(run).toContain('No commit sha resolved');
    });
  });

  it('posts no commit status for a stage that did no work', () => {
    const run = stageStep('20-alphaci-package').run;

    const guard = run.indexOf('"$STAGE_WORK_RAN" != "true"');
    const exit = run.indexOf('exit 0', guard);

    expect(run.slice(guard, exit)).not.toContain('post_commit_status');
  });
});

/*
 * Per-tool visibility, on the branch where it matters most.
 *
 * The capture used to sit behind `if [ "$CONCLUSION" = "failure" ]`. On dev the
 * gates are advisory — `fail-on-warning` is false — so a stage carrying real
 * diagnostics concludes SUCCESS, skipped the capture entirely, and the
 * developer saw a green tick and a coverage number. The warnings that would
 * block them at uat were recorded on no branch where there was time to fix
 * them.
 */
describe('the reporting job captures on success, not only on failure', () => {
  const qualityStep = (
    stack: WorkflowTemplate['stack'] = 'dotnet',
  ): { run: string; env: Record<string, string> } => {
    const bundle = buildStagedWorkflowBundle(makeTemplate(stack), {
      templateId: 'svc',
      serviceName: 'orders-api',
    });
    const file = bundle.workflowFiles.find((candidate) =>
      candidate.path.includes('10-alphaci-quality'),
    );
    const parsed = yaml.load(file!.yaml) as {
      jobs: Record<
        string,
        { steps?: { run?: string; env?: Record<string, string> }[] }
      >;
    };
    const step = parsed.jobs['report-results']!.steps![0]!;
    return { run: step.run!, env: step.env ?? {} };
  };

  /** Lines of the emitted script, trimmed, with blank lines and comments gone. */
  const codeLines = (run: string): string[] =>
    run
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'));

  it('fetches the job list outside any failure conditional', () => {
    const lines = codeLines(qualityStep().run);

    const fetchAt = lines.findIndex((line) => line.startsWith('JOBS_JSON='));
    const firstFailureGuard = lines.findIndex((line) =>
      line.includes('"$CONCLUSION" = "failure"'),
    );

    expect(fetchAt).toBeGreaterThanOrEqual(0);
    expect(firstFailureGuard).toBeGreaterThanOrEqual(0);
    // The fetch has to come FIRST. Behind the guard it never runs on dev.
    expect(fetchAt).toBeLessThan(firstFailureGuard);
  });

  it('collects annotations for every job, not only the failed ones', () => {
    const lines = codeLines(qualityStep().run);

    const idsAt = lines.findIndex((line) => line.startsWith('ANNOTATION_IDS='));
    const firstFailureGuard = lines.findIndex((line) =>
      line.includes('"$CONCLUSION" = "failure"'),
    );

    expect(idsAt).toBeGreaterThan(firstFailureGuard);
    // Sorted so failures come first, then capped — a cap that dropped the
    // failing job's diagnostics would defeat the point.
    const ids = lines[idsAt]!;
    expect(ids).toContain('sort_by(.conclusion != "failure")');
    expect(ids).not.toContain('select(.conclusion == "failure")');
  });

  it('sends a row per tool so one bar does not cover seven checks', () => {
    const { run } = qualityStep();

    expect(run).toContain('CHECKS=$(');
    expect(run).toContain('--argjson checks "$CHECKS"');
    expect(run).toContain('checks:$checks');
    // The reporting job is still running while it reports, so its own
    // conclusion is null and it is not a check anyone asked for.
    expect(run).toContain('select(.name != "report-results")');
  });

  it('keeps the annotation level, which is what separates advice from a block', () => {
    // The same formatter diagnostic is a warning on dev and the thing that
    // fails the build on uat. Without the level they are indistinguishable.
    expect(qualityStep().run).toContain('level: .annotation_level');
  });

  /*
   * `forbidNonWhitelisted` is on, so an undeclared property does not get
   * stripped — it rejects the whole report with a 400. A count read for a job
   * the toolchain never declared would arrive as an empty string and post a
   * count of nothing as though it were a count of zero.
   */
  it('reads the advisory counts only for a stack that declares those jobs', () => {
    const dotnet = qualityStep('dotnet').env;

    expect(dotnet['SECRETS_FINDINGS']).toBe(
      '${{ needs.secrets.outputs.findings-count }}',
    );
    expect(dotnet['LICENSE_FORBIDDEN']).toBe(
      '${{ needs.licenses.outputs.forbidden-count }}',
    );
    expect(dotnet['SBOM_COMPONENTS']).toBe(
      '${{ needs.sbom.outputs.component-count }}',
    );

    const node = qualityStep('nestjs').env;

    // Node fills four quality slots and has no licence inventory to take.
    expect(node['SECRETS_FINDINGS']).toBeUndefined();
    expect(node['LICENSE_FORBIDDEN']).toBeUndefined();
    expect(node['SBOM_COMPONENTS']).toBeUndefined();
  });

  it('omits a count that arrived empty rather than posting it as zero', () => {
    const { run } = qualityStep();

    // Guarded on a digit, so an absent output leaves the key out. Zero is a
    // real answer — "the scan ran and found nothing" — and an empty string
    // must never be allowed to impersonate it.
    expect(run).toContain(
      'if echo "$SECRETS_FINDINGS" | grep -qE \'^[0-9]+$\'; then',
    );
    expect(run).toContain('if [ "$FINDINGS" != "{}" ]; then');
  });
});

/*
 * The verify stage: exercise the service that was just deployed.
 *
 * Every earlier stage reads source. None of them can answer whether the thing
 * now running actually behaves, which is why this needs a stage rather than a
 * job inside package — its subject is a deployment, not a commit.
 */
describe('the verify stage', () => {
  // Scoped here: the registry in the first describe is not in scope, and the
  // verify stage only exists when a deployment fragment produced jobs.
  const workflowFragmentRegistry = new WorkflowFragmentRegistry([
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

  const bundleWith = (deploymentTargets: unknown[]) =>
    buildStagedWorkflowBundle(
      makeTemplate('dotnet'),
      {
        templateId: 'be-dotnet',
        serviceName: 'orders-api',
        ...(deploymentTargets.length > 0 && { deploymentTargets }),
      } as never,
      workflowFragmentRegistry,
    );

  const verifyOf = (deploymentTargets: unknown[]) => {
    const file = bundleWith(deploymentTargets).workflowFiles.find(
      (candidate) => candidate.stage === 'verify',
    );
    return file ? (yaml.load(file.yaml) as ParsedWorkflow) : null;
  };

  /*
   * Its subject is a running service. A repository with no deployment targets
   * has no URL to point a suite at, and emitting the stage anyway would report
   * the absence of an environment as a failure of the code.
   */
  it('is not emitted when nothing is deployed', () => {
    expect(verifyOf([])).toBeNull();
  });

  /*
   * The browser suite reported the way every other test job is.
   *
   * A Playwright run that executed forty tests and failed three used to leave
   * the verify stage posting `results: {}` — the counts and the failing names
   * existed only inside an uploaded artifact nothing reads, so the product
   * could say the stage was red and nothing else.
   */
  describe('browser-suite results', () => {
    const uiVerify = () => {
      const bundle = buildStagedWorkflowBundle(
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
        workflowFragmentRegistry,
      );
      return yaml.load(
        bundle.workflowFiles.find((file) => file.stage === 'verify')!.yaml,
      ) as ParsedWorkflow;
    };

    const reportStep = (parsed: ParsedWorkflow) =>
      (parsed.jobs['report-results']?.steps ?? []).find(
        (step) => step.env?.['E2E_TOTAL_0'] !== undefined,
      );

    it('reads the counts from both branch jobs', () => {
      const env = reportStep(uiVerify())?.env ?? {};

      // One slot per branch job, because only the branch's own job runs and
      // the other is skipped.
      expect(env['E2E_TOTAL_0']).toBe(
        '${{ needs.ui-tests-uat.outputs.tests-total }}',
      );
      expect(env['E2E_FAILURES_0']).toBe(
        '${{ needs.ui-tests-uat.outputs.tests-failures }}',
      );
      expect(env['E2E_TOTAL_1']).toBe(
        '${{ needs.ui-tests-main.outputs.tests-total }}',
      );
    });

    it('puts the browser counts on results.tests, where every other tool reports', () => {
      const run = reportStep(uiVerify())?.run ?? '';

      expect(run).toContain('{tests:$tests}');
      expect(run).toContain('E2E_FAILURES_');
    });

    /*
     * "No tests failed" and "we could not tell" must not look the same: a
     * suite whose project has not enabled the json reporter publishes an
     * empty string, and `tests` is left out rather than posted as zeros.
     */
    it('omits the counts rather than posting zeros when none were published', () => {
      const run = reportStep(uiVerify())?.run ?? '';

      expect(run).toContain("grep -qE '^[0-9]+$'");
      expect(run).toContain('-eq 0 ]; then continue');
    });

    /*
     * A backend has no browser suite, and reading outputs off a job that is
     * not in `needs` evaluates to empty — which would post a count of nothing
     * as though it were a count of zero.
     */
    it('reads nothing for a stack with no browser suite', () => {
      const parsed = verifyOf([renderTarget('uat')])!;

      expect(reportStep(parsed)).toBeUndefined();
    });
  });

  /*
   * The stack has to supply the suite, not just the provider a URL.
   *
   * A React bundle on a CDN has no /health to poll and no JSON to assert, and
   * its scaffold ships no collection — so emitting this stage for it pointed a
   * Bruno run at a Render secret a Vercel project does not have, at a
   * collection that was never generated. Every React pipeline would have gone
   * red at its last stage.
   */
  it('gives a browser stack UI jobs and no API jobs', () => {
    const bundle = buildStagedWorkflowBundle(
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
      workflowFragmentRegistry,
    );

    const file = bundle.workflowFiles.find(
      (candidate) => candidate.stage === 'verify',
    );
    expect(file).toBeDefined();

    const parsed = yaml.load(file!.yaml) as ParsedWorkflow;
    const jobs = Object.keys(parsed.jobs);

    // A browser suite, because a bundle on a CDN has no /health to poll and no
    // JSON to assert. Pointing Bruno at it would send a Vercel project to a
    // Render secret, for a collection its scaffold never generates.
    expect(jobs).toContain('ui-tests-uat');
    expect(jobs).toContain('ui-tests-main');
    expect(jobs.some((id) => id.startsWith('api-tests'))).toBe(false);
    expect(jobs.some((id) => id.startsWith('contract-tests'))).toBe(false);
  });

  /*
   * Vercel's Standard Protection answers every request against a uat/main
   * preview — Playwright's included — with a redirect to its own SSO page,
   * so the browser suite needs this to reach the deployment at all. Reusing
   * the same helper VercelCiSecretsService writes the secret under is what
   * keeps the name read here and the name written there from drifting apart.
   * `secrets:`, not `with:`: GitHub rejects a reusable-workflow call outright
   * if `secrets.*` is read inside `with:`.
   */
  it('hands the browser suite the Vercel automation bypass secret, for both branches', () => {
    const bundle = buildStagedWorkflowBundle(
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
      workflowFragmentRegistry,
    );

    const verify = yaml.load(
      bundle.workflowFiles.find((candidate) => candidate.stage === 'verify')!
        .yaml,
    ) as ParsedWorkflow;

    for (const jobId of ['ui-tests-uat', 'ui-tests-main']) {
      expect(verify.jobs[jobId]?.secrets).toEqual({
        VERCEL_AUTOMATION_BYPASS_SECRET:
          '${{ secrets.VERCEL_FRONTEND_AUTOMATION_BYPASS_SECRET }}',
        // Bearer for the visual-baseline calls (reusable-call secret, not with:).
        ALPHACI_TOKEN: '${{ secrets.ALPHACI_TOKEN }}',
      });
    }
  });

  /*
   * One variable for a Vercel project, because one project serves every
   * branch and the branch is a prefix on its hostname.
   *
   * A Render service is per-branch and so is its variable; asking for
   * VERCEL_ALIAS_DEV, _UAT and _MAIN was asking for three copies of one
   * hostname, none of which anything installed.
   */
  it('reads one alias variable and derives each branch hostname from it', () => {
    const bundle = buildStagedWorkflowBundle(
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
      workflowFragmentRegistry,
    );

    const parsed = yaml.load(
      bundle.workflowFiles.find((candidate) => candidate.stage === 'verify')!
        .yaml,
    ) as ParsedWorkflow;
    const step = parsed.jobs['resolve-targets']?.steps?.[0];

    expect(
      Object.keys(step?.env ?? {}).filter((key) => key.startsWith('VERCEL')),
    ).toEqual(['VERCEL_ALIAS']);
    expect(step?.env?.['VERCEL_ALIAS']).toBe('${{ vars.VERCEL_ALIAS }}');
    // main is the base host: a production deploy already lands there, so it
    // carries no prefix and needs no alias of its own.
    expect(step?.run).toContain('echo "ui-main=${VERCEL_ALIAS}"');
    expect(step?.run).toContain('echo "ui-uat=uat-${VERCEL_ALIAS}"');
    expect(step?.run).toContain('require "VERCEL_ALIAS"');
  });

  /*
   * Provisioning writes each preview branch's variables - the backend URL
   * among them - scoped to that branch, and `vercel pull` only includes a
   * branch-scoped variable when it is told the branch. Without this the uat
   * build pulled nothing and shipped with no API URL.
   */
  it('tells a preview deploy which branch to pull variables for', () => {
    const bundle = buildStagedWorkflowBundle(
      makeTemplate('react'),
      {
        templateId: 'fe-react',
        serviceName: 'orders-web',
        deploymentTargets: [
          {
            slot: 'frontend',
            provider: 'vercel',
            deploymentStrategy: 'vercel_ci_pushed',
            secretNames: {
              token: 'VERCEL_FRONTEND_TOKEN',
              orgId: 'VERCEL_FRONTEND_ORG_ID',
              projectId: 'VERCEL_FRONTEND_PROJECT_ID',
            },
          },
        ],
      } as never,
      workflowFragmentRegistry,
    );

    const parsed = yaml.load(
      bundle.workflowFiles.find((candidate) => candidate.stage === 'package')!
        .yaml,
    ) as ParsedWorkflow;

    expect(
      parsed.jobs['deploy-vercel-frontend-uat']?.with?.['git-branch'],
    ).toBe('uat');
    // Production variables are not branch-scoped, so main names none.
    expect(
      parsed.jobs['deploy-vercel-frontend-main']?.with?.['git-branch'],
    ).toBeUndefined();
  });

  /*
   * Every variable a branch needs, checked one per line.
   *
   * These used to be one `case` arm per variable, so a repository with both an
   * API and a UI suite got two `uat)` labels in one statement — and a `case`
   * stops at the first match, leaving the second variable unchecked.
   */
  it('checks each required variable in its own branch arm', () => {
    const verify = verifyOf([renderTarget('uat'), renderTarget('main')])!;
    const run = verify.jobs['resolve-targets']?.steps?.[0]?.run ?? '';

    expect(run).toContain('require() {');
    expect(run).toContain('require "RENDER_HEALTHCHECK_URL_UAT"');
    expect(run).toContain('require "RENDER_HEALTHCHECK_URL_MAIN"');
    // A dev run tests no deployed service, so it must not demand either.
    expect(run).toContain(
      'echo "Branch ${BRANCH} runs no tests against a deployed environment."',
    );
  });

  /*
   * playwright-e2e.yml carries a branch gate of its own, defaulting to `test`
   * and comparing against github.ref_name. A workflow_run stage always reports
   * the DEFAULT branch there, so that comparison was `main != test` on every
   * run: the suite reported `skipped`, which finalises as a pass. Playwright
   * had therefore never executed once on a generated pipeline.
   *
   * The branch is decided by this job's own `if:`, from the resolved
   * originating branch, so the inner gate is switched off rather than fed a
   * value it cannot read correctly.
   */
  it('disables the browser suite inner branch gate, having already scoped it', () => {
    const bundle = buildStagedWorkflowBundle(
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
      workflowFragmentRegistry,
    );

    const verify = yaml.load(
      bundle.workflowFiles.find((candidate) => candidate.stage === 'verify')!
        .yaml,
    ) as ParsedWorkflow;

    for (const jobId of ['ui-tests-uat', 'ui-tests-main']) {
      expect(verify.jobs[jobId]?.with?.['run-only-on-branch']).toBe('*');
    }
    // The scoping that does the work still lives here.
    expect(verify.jobs['ui-tests-uat']?.if).toContain("== 'uat'");
    expect(verify.jobs['ui-tests-main']?.if).toContain("== 'main'");
  });

  it('takes the collection path from the toolchain, not a hardcoded guess', () => {
    const verify = verifyOf([renderTarget('uat'), renderTarget('main')])!;

    expect(verify.jobs['api-tests-uat']?.with?.['collection-path']).toBe(
      'tests/api',
    );
  });

  it('is emitted once there is a deployment to verify', () => {
    const verify = verifyOf([renderTarget('uat')]);

    expect(verify).not.toBeNull();
    // Chained off package, so it runs after the artifact is live.
    expect(verify!.on.workflow_run?.workflows).toEqual([
      'ALPHACI 3 Build and Deploy',
    ]);
  });

  it('runs the whole collection on uat and only the read-only folder on main', () => {
    const verify = verifyOf([renderTarget('uat'), renderTarget('main')])!;

    // uat is the QA tier: everything, including requests that write.
    expect(verify.jobs['api-tests-uat']?.with?.['folder']).toBeUndefined();
    // A CRUD suite aimed at production is not a test, it is a write. main is
    // reached only by promotion from uat, so the destructive coverage has
    // already run against this same artifact.
    expect(verify.jobs['api-tests-main']?.with?.['folder']).toBe('smoke');
  });

  it('points each branch at its own deployment', () => {
    const verify = verifyOf([renderTarget('uat'), renderTarget('main')])!;

    expect(verify.jobs['api-tests-uat']?.with?.['base-url']).toBe(
      '${{ needs.resolve-targets.outputs.api-uat }}',
    );
    expect(verify.jobs['api-tests-main']?.with?.['base-url']).toBe(
      '${{ needs.resolve-targets.outputs.api-main }}',
    );
  });

  it('gates each API job to its own branch', () => {
    const verify = verifyOf([renderTarget('uat'), renderTarget('main')])!;

    expect(verify.jobs['api-tests-uat']?.if).toContain("== 'uat'");
    expect(verify.jobs['api-tests-main']?.if).toContain("== 'main'");
  });

  /*
   * Both API jobs are branch-scoped, so one always skips — and on dev both do.
   * Without naming them as the work, the access gate passing would be enough
   * to report the stage a success it did not earn, which is the bug this
   * whole guard exists for.
   */
  it('counts only the test jobs as the work of the stage', () => {
    const bundle = bundleWith([renderTarget('uat'), renderTarget('main')]);
    const file = bundle.workflowFiles.find(
      (candidate) => candidate.stage === 'verify',
    );
    const parsed = yaml.load(file!.yaml) as {
      jobs: Record<string, { steps?: { env?: Record<string, string> }[] }>;
    };
    const env = parsed.jobs['report-results']!.steps![0]!.env!;

    expect(env['STAGE_WORK_RAN']).toBe(
      "${{ needs.api-tests-uat.result != 'skipped' || " +
        "needs.api-tests-main.result != 'skipped' || " +
        "needs.contract-tests-uat.result != 'skipped' }}",
    );
    expect(env['STAGE_WORK_RAN']).not.toContain('validate-access');
  });
});

/*
 * The invariant that D-04 violated, asserted directly.
 *
 * GitHub does not allow the `secrets` context inside a reusable workflow
 * call's `with:` block, and it does not fail the one job - it refuses to parse
 * the FILE. The run lasts zero seconds, has no jobs, and is listed by filename
 * because the workflow's own name could not be read either. Three generated
 * expressions had this shape and the verify stage never executed once on a
 * real project as a result.
 *
 * Checked here rather than left to actionlint because this suite is what runs
 * on every change to the generator, and because the rule is narrow enough to
 * state exactly: a job with `uses:` is a reusable workflow call, and nothing
 * under its `with:` may mention `secrets.`. A job's `secrets:` block is a
 * different thing and remains the correct place for a credential.
 */
describe('generated workflows never put a secret in a reusable call input', () => {
  const registry = new WorkflowFragmentRegistry([
    renderWorkflowFragment,
    vercelWorkflowFragment,
  ]);

  const targetsFor = (stack: 'dotnet' | 'react') =>
    stack === 'dotnet'
      ? (['uat', 'main'] as const).map((branchName) => ({
          slot: 'backend',
          provider: 'render',
          branchName,
          deploymentStrategy: 'render_image_pushed',
          dockerContext: '.',
          dockerfilePath: 'Dockerfile',
          imageName: `alphaci-backend-${branchName}-svc`,
          secretNames: {
            deployHookUrl: `RENDER_DEPLOY_HOOK_URL_${branchName.toUpperCase()}`,
            healthcheckUrl: `RENDER_HEALTHCHECK_URL_${branchName.toUpperCase()}`,
          },
        }))
      : (['dev', 'uat', 'main'] as const).map((branchName) => ({
          slot: 'frontend',
          provider: 'vercel',
          branchName,
          deploymentStrategy: 'vercel_cli',
          secretNames: {
            token: 'VERCEL_FRONTEND_TOKEN',
            orgId: 'VERCEL_FRONTEND_ORG_ID',
            projectId: 'VERCEL_FRONTEND_PROJECT_ID',
          },
        }));

  it.each(['dotnet', 'react'] as const)(
    'holds for every %s workflow',
    (stack) => {
      const bundle = buildStagedWorkflowBundle(
        makeTemplate(stack),
        {
          templateId: stack === 'dotnet' ? 'be-dotnet' : 'fe-react',
          serviceName: 'orders-svc',
          deploymentTargets: targetsFor(stack),
        } as never,
        registry,
      );

      const offenders: string[] = [];
      for (const file of bundle.workflowFiles) {
        const parsed = yaml.load(file.yaml) as {
          jobs?: Record<
            string,
            { uses?: string; with?: Record<string, unknown> }
          >;
        };
        for (const [jobId, job] of Object.entries(parsed.jobs ?? {})) {
          if (!job?.uses || !job.with) continue;
          for (const [input, value] of Object.entries(job.with)) {
            if (typeof value === 'string' && value.includes('secrets.')) {
              offenders.push(`${file.path} → ${jobId}.with.${input}`);
            }
          }
        }
      }

      expect(offenders).toEqual([]);
    },
  );
});

/*
 * The branch a chained stage acts on must come from the context job, never the
 * event.
 *
 * A `workflow_run` stage executes in the DEFAULT branch context, so two hops
 * from the push every branch and sha field in the event says `main`. Reading
 * them made a push to dev run the production gate, build the main image and
 * attempt a PRODUCTION deploy - of main's code, not the pushed commit - while
 * promote-to-uat could never fire because the branch never read `dev`.
 *
 * Asserted on the emitted YAML rather than on the builder's constants, because
 * the deploy jobs come from provider fragments that construct their own
 * conditions and had to be fixed separately. A future fragment that reaches for
 * the event expression fails here.
 */
describe('chained stages read the branch from the context job', () => {
  const registry = new WorkflowFragmentRegistry([
    renderWorkflowFragment,
    vercelWorkflowFragment,
  ]);

  const vercelTargets = (['dev', 'uat', 'main'] as const).map((branchName) => ({
    slot: 'frontend',
    provider: 'vercel',
    branchName,
    deploymentStrategy: 'vercel_cli',
    secretNames: {
      token: 'VERCEL_FRONTEND_TOKEN',
      orgId: 'VERCEL_FRONTEND_ORG_ID',
      projectId: 'VERCEL_FRONTEND_PROJECT_ID',
    },
  }));

  const chainedFiles = () =>
    buildStagedWorkflowBundle(
      makeTemplate('react'),
      {
        templateId: 'fe-react',
        serviceName: 'orders-web',
        deploymentTargets: vercelTargets,
      } as never,
      registry,
    ).workflowFiles.filter((file) =>
      ['quality', 'package', 'verify'].includes(file.stage),
    );

  it('never branch-scopes a job on the event', () => {
    const offenders: string[] = [];

    for (const file of chainedFiles()) {
      const parsed = yaml.load(file.yaml) as {
        jobs?: Record<string, { if?: string }>;
      };
      for (const [jobId, job] of Object.entries(parsed.jobs ?? {})) {
        if (
          typeof job?.if === 'string' &&
          job.if.includes('github.event.workflow_run.head_branch')
        ) {
          offenders.push(`${file.path} → ${jobId}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('checks out the originating commit, not the default branch', () => {
    const offenders: string[] = [];

    for (const file of chainedFiles()) {
      const parsed = yaml.load(file.yaml) as {
        jobs?: Record<string, { with?: Record<string, unknown> }>;
      };
      for (const [jobId, job] of Object.entries(parsed.jobs ?? {})) {
        const ref = job?.with?.['checkout-ref'];
        if (
          typeof ref === 'string' &&
          ref.includes('github.event.workflow_run.head_sha')
        ) {
          offenders.push(`${file.path} → ${jobId}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('gives every chained stage a context job to read from', () => {
    for (const file of chainedFiles()) {
      const parsed = yaml.load(file.yaml) as { jobs?: Record<string, unknown> };
      expect(Object.keys(parsed.jobs ?? {})).toContain('pipeline-context');
    }
  });
});

/*
 * A concurrency group that spans branches DROPS pipelines.
 *
 * These stages had one. It keyed on the repository alone - the only thing
 * available, since `concurrency` is evaluated before any job runs and cannot
 * read `pipeline-context` - which put dev, uat and main in one group. GitHub
 * keeps a single pending run per group and cancels the one queued behind it,
 * so on testsandbox-fe, with every other fix in place, dev and uat recorded an
 * access report and nothing else: their quality runs were cancelled, five of
 * seven, while main's went through.
 *
 * A cancelled pipeline reports nothing at all. That is strictly worse than the
 * cache collision the group was guarding, which fails one run loudly with the
 * reason in the log.
 */
describe('no chained stage can cancel another branch', () => {
  const bundle = () =>
    buildStagedWorkflowBundle(
      makeTemplate('dotnet'),
      { templateId: 'be-dotnet', serviceName: 'orders-api' } as never,
      new WorkflowFragmentRegistry([
        renderWorkflowFragment,
        vercelWorkflowFragment,
      ]),
    );

  it('gives no chained stage a concurrency group at all', () => {
    const chained = bundle().workflowFiles.filter((file) =>
      ['quality', 'package', 'verify'].includes(file.stage),
    );

    expect(chained.length).toBeGreaterThan(0);
    for (const file of chained) {
      const parsed = yaml.load(file.yaml) as { concurrency?: unknown };
      expect(parsed.concurrency).toBeUndefined();
    }
  });

  it('leaves the push-triggered access stage alone', () => {
    // Access is cheap, has no cache and no deploy, and never had one.
    const access = bundle().workflowFiles.find(
      (file) => file.stage === 'access',
    );
    const parsed = yaml.load(access!.yaml) as { concurrency?: unknown };

    expect(parsed.concurrency).toBeUndefined();
  });

  /*
   * The env guard keeps its group, and should: it is push-triggered, so
   * `github.ref` is the real branch and the key separates them. It is the
   * counter-example that shows the problem was the KEY, not the mechanism.
   */
  it('keeps the env guard serialized per ref, where the branch is knowable', () => {
    const guard = bundle().workflowFiles.find((file) => file.stage === 'guard');
    const parsed = yaml.load(guard!.yaml) as {
      concurrency?: { group?: string; 'cancel-in-progress'?: boolean };
    };

    expect(parsed.concurrency?.group).toContain('github.ref');
    expect(parsed.concurrency?.['cancel-in-progress']).toBe(false);
  });
});

describe('promotion PR pairing input (sibling-repo)', () => {
  const promotionJobs = (options: { siblingRepoFullName?: string } = {}) => {
    const bundle = buildStagedWorkflowBundle(makeTemplate(), {
      templateId: 'be-nestjs',
      serviceName: 'orders-api',
      ...options,
    });
    const pkg = yaml.load(bundle.workflowFiles[2]!.yaml) as ParsedWorkflow;
    return {
      bundle,
      toUat: pkg.jobs['promote-to-uat'],
      toMain: pkg.jobs['promote-to-main'],
    };
  };

  it('passes the sibling repo to both promotion hops for a multi-repo pair', () => {
    const { toUat, toMain } = promotionJobs({
      siblingRepoFullName: 'org/orders-fe',
    });

    expect(toUat?.with?.['sibling-repo']).toBe('org/orders-fe');
    expect(toMain?.with?.['sibling-repo']).toBe('org/orders-fe');
  });

  it('omits the input entirely for single-repo pipelines', () => {
    const { toUat, toMain } = promotionJobs();

    expect(Object.keys(toUat?.with ?? {})).toEqual([
      'pipeline-kind',
      'direction',
      'system1-name',
      'pipeline-result',
    ]);
    expect(toMain?.with).not.toHaveProperty('sibling-repo');
  });

  it('leaves every generated file byte-for-byte identical when there is no sibling', () => {
    const plain = promotionJobs().bundle.workflowFiles.map((f) => f.yaml);
    const explicitUndefined = buildStagedWorkflowBundle(makeTemplate(), {
      templateId: 'be-nestjs',
      serviceName: 'orders-api',
    }).workflowFiles.map((f) => f.yaml);

    expect(explicitUndefined).toEqual(plain);
    expect(plain.join('\n')).not.toContain('sibling-repo');
  });

  it('changes nothing but the two sibling-repo lines when a sibling is set', () => {
    const before = promotionJobs().bundle.workflowFiles.map((f) => f.yaml);
    const after = promotionJobs({
      siblingRepoFullName: 'org/orders-fe',
    }).bundle.workflowFiles.map((f) => f.yaml);

    expect(
      after.map((y) => y.split('\n').length - before[0]!.split('\n').length),
    ).toBeDefined();
    const strip = (y: string) =>
      y
        .split('\n')
        .filter((line) => !line.includes('sibling-repo'))
        .join('\n');
    expect(after.map(strip)).toEqual(before);
    expect(
      after
        .join('\n')
        .split('\n')
        .filter((l) => l.includes('sibling-repo')),
    ).toHaveLength(2);
  });
});
