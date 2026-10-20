import { resolveCentralWorkflowBase } from '#kernel/config/central-workflow';
import type {
  ToolchainFragment,
  ToolchainFragmentContext,
  ToolchainFragmentResult,
} from '#kernel/ports/toolchain-fragment.port';

/**
 * Quality jobs for modern, SDK-style .NET.
 *
 * This is the first fragment that is not Node, and it is the reason the
 * toolchain contract exists: none of the four jobs the Node fragment emits are
 * reusable here. The test workflow differs, the linter is `dotnet format`
 * rather than ESLint, the dependency audit reads NuGet advisories rather than
 * `npm audit`, and there is no separate type-check step at all.
 *
 * Only SDK-style projects are supported — `dotnet` CLI, `.csproj`, ubuntu
 * runners. .NET Framework needs MSBuild on Windows runners and is deliberately
 * out of scope, so nothing here is written to accommodate it.
 */

const CENTRAL_WORKFLOW_BASE = resolveCentralWorkflowBase();

/**
 * Job that produces coverage, and therefore the one Sonar waits on.
 *
 * Named for the stack rather than reusing 'backend-tests' so a pipeline's logs
 * say which toolchain ran, and so the two can never be confused when a
 * repository holds both a Node and a .NET service.
 */
const TEST_JOB_ID = 'dotnet-tests';

/**
 * `dotnet format` and `dotnet build` accept the same optional target, and both
 * discover the solution when it is absent. The generator does not model a
 * solution path yet, so every job lets the SDK discover it; passing an empty
 * string is the documented way to say "discover" to these workflows.
 */
const DISCOVER_SOLUTION = '';

/**
 * The package stage's build job.
 *
 * `dotnet publish` rather than `dotnet build`: the package stage exists to
 * produce something deployable, and publish is what emits a self-contained
 * output tree with its dependencies resolved. A plain build leaves the deploy
 * and container steps to guess where the artifacts are.
 */
function packageBuildJob(context: ToolchainFragmentContext) {
  return {
    needs: [context.accessJobId],
    if: context.buildBranchCondition,
    runs_on: 'ubuntu-latest',
    defaults: {
      run: {
        'working-directory': `./${context.servicePath}`,
      },
    },
    steps: [
      {
        uses: 'actions/checkout@v6',
        with: {
          ref: context.checkoutRef,
        },
      },
      {
        uses: 'actions/setup-dotnet@v6',
        with: {
          'dotnet-version': context.runtimeVersion,
        },
      },
      {
        name: 'Restore dependencies',
        run: 'dotnet restore',
      },
      {
        name: 'Publish',
        // --no-restore keeps this from silently re-resolving a different
        // package graph than the one the restore step above recorded.
        run: 'dotnet publish --configuration Release --no-restore --output ./publish',
      },
    ],
  };
}

function buildDotnetQualityJobs(
  context: ToolchainFragmentContext,
): ToolchainFragmentResult {
  const failOnWarningExpr = `\${{ fromJson(needs.${context.policyJobId}.outputs.fail-on-warning) }}`;

  /*
   * The branch policy publishes ONE strictness signal, and every gate that can
   * be loosened keys off it rather than inventing its own output.
   *
   * `fail-on-warning` is false on the working branch and true on the promoted
   * ones, which is exactly the question the secret, licence and SBOM gates
   * need answered: report on dev, block before uat and main. Reusing it means
   * "how strict is this branch" is decided in one place — adding a
   * per-gate policy output would let the answers drift apart, which is how a
   * pipeline ends up strict about licences and lax about secrets for no
   * reason anyone remembers.
   */
  const strictGateExpr = failOnWarningExpr;

  const shared = {
    'working-directory': context.servicePath,
    'system-name': context.serviceName,
    'dotnet-version': context.runtimeVersion,
    'solution-path': DISCOVER_SOLUTION,
    'checkout-ref': context.checkoutRef,
  };

  /*
   * Inputs for a check that is not about .NET at all.
   *
   * A secret in a .cs file and a secret in a .ts file are the same problem, so
   * gitleaks-scan.yml declares no dotnet-version and no solution-path. Passing
   * the full `shared` set would fail the call: a reusable workflow rejects an
   * input it does not declare.
   */
  const sharedLanguageAgnostic = {
    'working-directory': context.servicePath,
    'system-name': context.serviceName,
    'checkout-ref': context.checkoutRef,
  };

  return {
    testJobId: TEST_JOB_ID,
    /*
     * The four shared slots every stack fills, then the three this stack adds.
     *
     * The list is per-fragment on purpose, so a stack can carry more checks
     * than another without either of them special-casing the reporting job —
     * it takes whatever ids the fragment declares as its `needs`. Node has no
     * NuGet licences to inventory; .NET does, and neither has to know that.
     */
    qualityJobIds: [
      TEST_JOB_ID,
      'lint',
      'typecheck',
      'security',
      'secrets',
      'licenses',
      'sbom',
    ],
    packageBuildJob: packageBuildJob(context),
    /*
     * The .NET scaffold ships a Bruno collection, so this stack has something
     * to run against a deployment. Node does not yet, and declaring it there
     * would turn every Node pipeline red at the verify stage — the job fails
     * on a missing collection by design.
     */
    apiVerification: {
      collectionPath: 'tests/api',
      smokeFolder: 'smoke',
      // ASP.NET Core's built-in OpenAPI document (MapOpenApi), served at
      // runtime only; the scaffold's Bruno collection checks the same path.
      schemaUrlPath: '/openapi/v1.json',
    },
    sonar: {
      // SonarQube Cloud analyses C#, but only through SonarScanner for .NET,
      // which wraps the build so Roslyn analyzers emit findings as it compiles.
      // The generic CLI cannot analyse the language at all.
      workflow: 'sonarcloud-dotnet-scan.yml',
      sourcesPath: 'src',
      // Disjoint from sources. Passing Node's 'src,tests' made Program.cs both
      // a source and a test file, and Sonar failed the scan outright.
      testsPath: 'tests',
      // ReportGenerator writes this in dotnet-test.yml; the .NET scanner reads
      // Cobertura rather than the lcov the generic CLI consumes.
      coverageReportPath: 'coverage/coverage.cobertura.xml',
      extraWith: { 'dotnet-version': context.runtimeVersion },
    },
    qualityJobs: {
      [TEST_JOB_ID]: {
        needs: [context.policyJobId],
        uses: `${CENTRAL_WORKFLOW_BASE}/dotnet-test.yml@${context.centralWorkflowRef}`,
        with: {
          ...shared,
          'coverage-threshold': `\${{ fromJson(needs.${context.policyJobId}.outputs.coverage-threshold) }}`,
          'promotion-coverage-threshold': `\${{ fromJson(needs.${context.policyJobId}.outputs.promotion-coverage-threshold) }}`,
          'enforce-coverage': true,
        },
      },
      // Named 'lint' rather than 'dotnet-format' so the reporting job's needs
      // list and the branch policy read the same for every stack. What the job
      // runs is the toolchain's business; what it means is the pipeline's.
      lint: {
        needs: [context.policyJobId],
        uses: `${CENTRAL_WORKFLOW_BASE}/dotnet-format.yml@${context.centralWorkflowRef}`,
        with: {
          ...shared,
          'fail-on-warning': failOnWarningExpr,
        },
      },
      // .NET has no separate type check: the compiler is the type checker. The
      // slot is filled by the analyzer build so every stack's quality stage has
      // the same four jobs and the reporting job does not special-case a stack.
      typecheck: {
        needs: [context.policyJobId],
        uses: `${CENTRAL_WORKFLOW_BASE}/dotnet-analyze.yml@${context.centralWorkflowRef}`,
        with: {
          ...shared,
          'treat-warnings-as-errors': failOnWarningExpr,
        },
      },
      security: {
        needs: [context.accessJobId],
        uses: `${CENTRAL_WORKFLOW_BASE}/dotnet-audit.yml@${context.centralWorkflowRef}`,
        with: {
          ...shared,
          // Mirrors the Node fragment's 'fail-on-high: true'. Expressed as a
          // severity rather than a boolean because the .NET audit reads NuGet's
          // four-level scale directly.
          'fail-on-severity': 'High',
        },
      },
      /*
       * A committed secret is not a .NET problem, so this job is the same for
       * every stack that adopts it — no dotnet-version, no solution path.
       *
       * Working tree only. Scanning history would surface secrets removed long
       * ago, which are real but are a backlog to work through rather than a
       * gate to put in front of today's push; a stage that fails on the past
       * gets switched off rather than fixed.
       */
      secrets: {
        needs: [context.policyJobId],
        uses: `${CENTRAL_WORKFLOW_BASE}/gitleaks-scan.yml@${context.centralWorkflowRef}`,
        with: {
          ...sharedLanguageAgnostic,
          'fail-on-findings': strictGateExpr,
        },
      },
      /*
       * Licence terms of the resolved NuGet graph.
       *
       * The forbidden list is left at the workflow's default — the strong
       * copyleft terms a hosted service cannot satisfy. It is an input there
       * for the organisation that needs a different answer, but the platform
       * should not be inventing one per project.
       */
      licenses: {
        needs: [context.policyJobId],
        uses: `${CENTRAL_WORKFLOW_BASE}/dotnet-license-scan.yml@${context.centralWorkflowRef}`,
        with: {
          ...shared,
          'fail-on-forbidden': strictGateExpr,
        },
      },
      /*
       * The release record, not a verdict.
       *
       * It sits in the quality stage rather than the package stage because it
       * describes the RESOLVED dependency graph, which restore has already
       * decided by this point — and because the package stage does not run at
       * all on the working branch, which would leave dev with no SBOM to
       * compare a promotion against.
       */
      sbom: {
        needs: [context.policyJobId],
        uses: `${CENTRAL_WORKFLOW_BASE}/dotnet-sbom.yml@${context.centralWorkflowRef}`,
        with: {
          ...shared,
          'require-sbom': strictGateExpr,
        },
      },
    },
  };
}

export const dotnetToolchainFragment: ToolchainFragment = {
  stack: 'dotnet',
  build: buildDotnetQualityJobs,
};
