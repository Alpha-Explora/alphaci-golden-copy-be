import yaml from 'js-yaml';

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

  it('triggers generated workflows only for uat and main', () => {
    const bundle = buildStagedWorkflowBundle(makeTemplate(), {
      templateId: 'be-nestjs',
      serviceName: 'orders-api',
    });
    const access = yaml.load(bundle.workflowFiles[0]!.yaml) as Record<
      string,
      unknown
    >;

    expect(access['on']).toEqual({
      push: { branches: ['uat', 'main'] },
      pull_request: { branches: ['uat', 'main'] },
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
      'cicd-external-project/cicd-workflow/.github/workflows/sonarcloud-scan.yml@v1',
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
      'cicd-external-project/cicd-workflow/.github/workflows/production-gate.yml@v1',
    );
    expect(gate?.if).toBe(
      "${{ (github.event.workflow_run.head_branch || github.ref_name) == 'main' }}",
    );
    expect(gate?.with?.['app-type']).toBe('api');
    expect(gate?.with?.['require-approval']).toBe(true);
  });

  it('emits branch-scoped Vercel deploy jobs when deployment targets are present', () => {
    const bundle = buildStagedWorkflowBundle(makeTemplate('nextjs'), {
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
    });

    const pkg = yaml.load(bundle.workflowFiles[2]!.yaml) as ParsedWorkflow;
    const packageYaml = bundle.workflowFiles[2]!.yaml;

    expect(pkg.jobs['deploy-vercel-standalone-uat']?.uses).toBe(
      'cicd-external-project/cicd-workflow/.github/workflows/vercel-deploy.yml@v1',
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
    const bundle = buildStagedWorkflowBundle(makeTemplate(), {
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
    });

    const pkg = yaml.load(bundle.workflowFiles[2]!.yaml) as ParsedWorkflow;

    expect(pkg.jobs['docker-backend-uat']?.uses).toBe(
      'cicd-external-project/cicd-workflow/.github/workflows/docker-build.yml@v1',
    );
    expect(pkg.jobs['deploy-render-backend-uat']?.uses).toBe(
      'cicd-external-project/cicd-workflow/.github/workflows/render-deploy.yml@v1',
    );
    expect(pkg.jobs['deploy-render-backend-uat']?.needs).toEqual([
      'docker-backend-uat',
    ]);
  });

  it('creates only the uat→main promotion PR job', () => {
    const bundle = buildStagedWorkflowBundle(makeTemplate(), {
      templateId: 'be-nestjs',
      serviceName: 'orders-api',
    });

    const pkg = yaml.load(bundle.workflowFiles[2]!.yaml) as ParsedWorkflow;
    const toMain = pkg.jobs['promote-to-main'];

    expect(pkg.jobs['promote-to-uat']).toBeUndefined();
    expect(toMain?.uses).toBe(
      'cicd-external-project/cicd-workflow/.github/workflows/promotion.yml@v1',
    );
    expect(toMain?.with?.['system1-name']).toBe('orders-api');
    expect(toMain?.secrets).toEqual({
      PR_TOKEN:
        "${{ secrets.GH_PR_TOKEN != '' && secrets.GH_PR_TOKEN || github.token }}",
    });

    expect(toMain?.if).toContain("== 'uat'");
    expect(toMain?.with?.['direction']).toBe('uat-to-main');
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

    it('watches only protected branch pushes and pull requests', () => {
      const guard = guardOf()!;
      const wf = yaml.load(guard.yaml) as Record<string, unknown>;

      expect(wf['on']).toEqual({
        push: { branches: ['uat', 'main'] },
        pull_request: { branches: ['uat', 'main'] },
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
