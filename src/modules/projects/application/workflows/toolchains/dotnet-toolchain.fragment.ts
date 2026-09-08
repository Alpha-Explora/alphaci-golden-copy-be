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
  const shared = {
    'working-directory': context.servicePath,
    'system-name': context.serviceName,
    'dotnet-version': context.runtimeVersion,
    'solution-path': DISCOVER_SOLUTION,
    'checkout-ref': context.checkoutRef,
  };

  return {
    testJobId: TEST_JOB_ID,
    qualityJobIds: [TEST_JOB_ID, 'lint', 'typecheck', 'security'],
    packageBuildJob: packageBuildJob(context),
    qualityJobs: {
      [TEST_JOB_ID]: {
        needs: [context.policyJobId],
        uses: `${CENTRAL_WORKFLOW_BASE}/dotnet-test.yml@${context.centralWorkflowRef}`,
        with: {
          ...shared,
          'coverage-threshold': `\${{ fromJson(needs.${context.policyJobId}.outputs.coverage-threshold) }}`,
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
    },
  };
}

export const dotnetToolchainFragment: ToolchainFragment = {
  stack: 'dotnet',
  build: buildDotnetQualityJobs,
};
