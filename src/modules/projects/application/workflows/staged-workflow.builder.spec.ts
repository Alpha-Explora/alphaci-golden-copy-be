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
      'ALPHACI Access Gate',
      'ALPHACI Quality',
      'ALPHACI Package',
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

    expect(quality.name).toBe('ALPHACI Quality (backend)');
    expect(quality.on.workflow_run?.workflows).toEqual([
      'ALPHACI Access Gate (backend)',
    ]);
    expect(pkg.name).toBe('ALPHACI Package (backend)');
    expect(pkg.on.workflow_run?.workflows).toEqual([
      'ALPHACI Quality (backend)',
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

    expect(typecheck?.needs).toEqual(['branch-policy']);
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
    expect(sonar?.needs).toEqual(['branch-policy', 'backend-tests']);
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
      "${{ (github.event.workflow_run.head_branch || github.ref_name) == 'main' }}",
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
            secretNames: {
              deployHookUrl: 'RENDER_DEPLOY_HOOK_URL_UAT',
              healthcheckUrl: 'RENDER_HEALTHCHECK_URL_UAT',
            },
          },
        ],
      },
      workflowFragmentRegistry,
    );

    const pkg = yaml.load(bundle.workflowFiles[2]!.yaml) as ParsedWorkflow;

    expect(pkg.jobs['docker-backend-uat']?.uses).toBe(
      'Alpha-Explora/alphaci-workflow/.github/workflows/docker-build.yml@v1',
    );
    expect(pkg.jobs['deploy-render-backend-uat']?.uses).toBe(
      'Alpha-Explora/alphaci-workflow/.github/workflows/render-deploy.yml@v1',
    );
    expect(pkg.jobs['deploy-render-backend-uat']?.needs).toEqual([
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

    expect(toMain?.needs).toEqual(['build']);
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
