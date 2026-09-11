import { resolveCentralWorkflowBase } from '#kernel/config/central-workflow';
import type {
  ToolchainFragment,
  ToolchainUiVerification,
  ToolchainFragmentContext,
  ToolchainFragmentResult,
} from '#kernel/ports/toolchain-fragment.port';

/**
 * Quality jobs for the Node stacks: nextjs, react, nestjs and nodejs.
 *
 * One fragment serves all four because their pipelines differ only in which
 * reusable test workflow they call and which inputs that workflow takes - the
 * toolchain underneath is identical. A stack whose toolchain genuinely differs
 * registers its own fragment rather than adding a branch here.
 *
 * The jobs are reproduced exactly as the generator emitted them inline, so
 * moving them behind this contract changes no generated pipeline. See ADR-0006.
 */

/**
 * `owner/name/.github/workflows` prefix for every `uses:` this fragment emits.
 *
 * Resolved from the same kernel function the generator and the provider
 * fragments use, so a toolchain job can never point at a different repository
 * than the deploy jobs in the same pipeline. Imported from the kernel rather
 * than from the provider helpers, which live in another module and are private
 * to it.
 */
const CENTRAL_WORKFLOW_BASE = resolveCentralWorkflowBase();

/** How a Node stack's test job is shaped. */
interface NodeStackProfile {
  /** Reusable workflow that runs the tests. */
  /**
   * Where a browser suite lives, for the stacks that render in one.
   *
   * On the profile rather than per stack because it follows exactly the split
   * this profile already draws: a frontend serves pages a browser can drive, a
   * Node service serves JSON it cannot.
   */
  readonly uiVerification?: ToolchainUiVerification;
  readonly testWorkflow: 'backend-tests.yml' | 'frontend-tests.yml';
  /** Job id, which is also what Sonar waits on for the coverage artifact. */
  readonly testJobId: 'backend-tests' | 'frontend-tests';
  /**
   * Test command. The central test workflows enforce coverage by parsing
   * coverage/coverage-summary.json and SonarCloud ingests lcov, so the command
   * must produce both reporters. The two differ only in `npm test` against
   * `npm run test`, which is how the respective starters name the script.
   */
  readonly testCommand: string;
  /**
   * Inputs unique to this shape.
   *
   * The two test workflows do not accept the same arguments: the backend one is
   * told which stack it is running, while the frontend one is told where the
   * unit tests live. Neither input exists on the other workflow, and Actions
   * hard-fails a `uses:` that passes an input the callee does not declare - so
   * these cannot be collapsed into one shape.
   */
  extraWith(
    context: ToolchainFragmentContext,
    stack: string,
  ): Record<string, string>;
}

const BACKEND_PROFILE: NodeStackProfile = {
  testWorkflow: 'backend-tests.yml',
  testJobId: 'backend-tests',
  testCommand:
    'npm test -- --coverage --coverageReporters=json-summary --coverageReporters=lcov --json --outputFile=test-results.json',
  extraWith: (_context, stack) => ({ 'backend-stack': stack }),
};

const FRONTEND_PROFILE: NodeStackProfile = {
  /*
   * Browser tests for the stacks that have a browser.
   *
   * `tests/e2e` is the directory the scaffold's README already names, and the
   * Playwright workflow fails when it is absent — so a stack declaring this
   * has to ship specs there, exactly as a stack declaring apiVerification has
   * to ship a collection.
   *
   * Chromium alone by default. A three-browser matrix triples the runtime of
   * the slowest stage in the pipeline to catch a class of bug that is rare in
   * an app this size; widening it is a per-project decision, not a default
   * everyone pays for.
   */
  uiVerification: {
    testsDirectory: 'tests/e2e',
    browsers: 'chromium',
  },
  testWorkflow: 'frontend-tests.yml',
  testJobId: 'frontend-tests',
  testCommand:
    'npm run test -- --coverage --coverageReporters=json-summary --coverageReporters=lcov --json --outputFile=test-results.json',
  // Repos born with the ALPHACI scaffold ship tests/unit and the guard
  // enforces it stays; BYO repos fall back to src, the one folder every
  // layout is guaranteed to have.
  extraWith: (context) => ({
    'unit-tests-directory': context.hasTestsDirectory ? 'tests/unit' : 'src',
  }),
};

const LINT_COMMAND = 'npm run lint';

function typecheckJob(context: ToolchainFragmentContext) {
  return {
    needs: [context.policyJobId],
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
        uses: 'actions/setup-node@v6',
        with: {
          'node-version': Number(context.runtimeVersion),
        },
      },
      {
        name: 'Install dependencies',
        run: 'if [ -f package-lock.json ]; then npm ci --ignore-scripts; else npm install --ignore-scripts; fi',
      },
      {
        name: 'Run TypeScript type check',
        run: [
          "TYPECHECK_CMD=$(node -e \"const fs=require('fs'); const pkg=JSON.parse(fs.readFileSync('package.json','utf8')); process.stdout.write(pkg.scripts && pkg.scripts.typecheck ? 'npm run typecheck' : 'npx tsc --noEmit');\")",
          'echo "Running ${TYPECHECK_CMD}"',
          'bash -lc "${TYPECHECK_CMD}"',
        ].join('\n'),
      },
    ],
  };
}

/**
 * The package stage's build job.
 *
 * Moved here verbatim from the generator, where it was written inline against
 * `setup-node` and `npm ci`. Compiling is as language-specific as testing, and
 * leaving it in the pipeline meant a non-Node stack would have run `npm ci`
 * against a repository with no package.json.
 */
function packageBuildJob(context: ToolchainFragmentContext) {
  return {
    needs: [context.accessJobId],
    // Builds on every promotion-flow branch, dev included. A build break found
    // on dev is a minute of CI; the same break found on uat has already cost a
    // promotion and a QA cycle. The condition is derived from the branch list
    // rather than spelled out, so it cannot fall behind it.
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
        uses: 'actions/setup-node@v6',
        with: {
          'node-version': Number(context.runtimeVersion),
        },
      },
      {
        name: 'Install dependencies',
        // Fresh ALPHACI scaffolds have no package-lock.json yet (the customer
        // generates it on first `npm install`), so npm ci would hard-fail.
        run: 'if [ -f package-lock.json ]; then npm ci --ignore-scripts; else npm install --ignore-scripts; fi',
      },
      { run: 'npm run build' },
    ],
  };
}

function buildNodeQualityJobs(
  stack: string,
  profile: NodeStackProfile,
  context: ToolchainFragmentContext,
): ToolchainFragmentResult {
  return {
    testJobId: profile.testJobId,
    qualityJobIds: [profile.testJobId, 'lint', 'typecheck', 'security'],
    packageBuildJob: packageBuildJob(context),
    sonar: {
      workflow: 'sonarcloud-scan.yml',
      sourcesPath: 'src',
      // Node keeps unit tests beside the code as *.spec.ts, so src appears in
      // both and sonar-project.properties disambiguates with test.inclusions.
      // A stack whose tests live only in their own folder must not copy this.
      testsPath: context.hasTestsDirectory ? 'src,tests' : 'src',
      coverageReportPath: 'coverage/lcov.info',
    },
    qualityJobs: {
      [profile.testJobId]: {
        needs: [context.policyJobId],
        uses: `${CENTRAL_WORKFLOW_BASE}/${profile.testWorkflow}@${context.centralWorkflowRef}`,
        with: {
          'working-directory': context.servicePath,
          'system-name': context.serviceName,
          ...profile.extraWith(context, stack),
          'node-version': Number(context.runtimeVersion),
          'coverage-threshold': `\${{ fromJson(needs.${context.policyJobId}.outputs.coverage-threshold) }}`,
          'enforce-coverage': true,
          'test-command': profile.testCommand,
          'checkout-ref': context.checkoutRef,
        },
      },
      lint: {
        needs: [context.policyJobId],
        uses: `${CENTRAL_WORKFLOW_BASE}/lint-check.yml@${context.centralWorkflowRef}`,
        with: {
          'working-directory': context.servicePath,
          'system-name': context.serviceName,
          'node-version': Number(context.runtimeVersion),
          'lint-command': LINT_COMMAND,
          // PR source refs use the baseline; direct uat/main runs are strict.
          'fail-on-warning': `\${{ fromJson(needs.${context.policyJobId}.outputs.fail-on-warning) }}`,
          'checkout-ref': context.checkoutRef,
        },
      },
      typecheck: typecheckJob(context),
      security: {
        needs: [context.accessJobId],
        uses: `${CENTRAL_WORKFLOW_BASE}/security-scan.yml@${context.centralWorkflowRef}`,
        with: {
          'working-directory': context.servicePath,
          'system-name': context.serviceName,
          'node-version': Number(context.runtimeVersion),
          'fail-on-high': true,
          'checkout-ref': context.checkoutRef,
        },
      },
    },
  };
}

function nodeFragment(
  stack: string,
  profile: NodeStackProfile,
): ToolchainFragment {
  return {
    stack,
    build: (context) => ({
      ...buildNodeQualityJobs(stack, profile, context),
      ...(profile.uiVerification && {
        uiVerification: profile.uiVerification,
      }),
    }),
  };
}

/**
 * Every stack the Node toolchain serves.
 *
 * The mobile stacks have no catalog entry and reach the generator only through
 * legacy templates, where `isBackend` classified them as frontends by omission.
 * They are registered explicitly so that the classification is a decision on
 * the record rather than a consequence of not appearing on a list.
 */
export const nodeToolchainFragments: readonly ToolchainFragment[] = [
  nodeFragment('nestjs', BACKEND_PROFILE),
  nodeFragment('nodejs', BACKEND_PROFILE),
  nodeFragment('nextjs', FRONTEND_PROFILE),
  nodeFragment('react', FRONTEND_PROFILE),
  nodeFragment('react-native', FRONTEND_PROFILE),
  nodeFragment('expo', FRONTEND_PROFILE),
];
