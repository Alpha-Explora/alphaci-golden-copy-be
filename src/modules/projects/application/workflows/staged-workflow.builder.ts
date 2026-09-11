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

export type WorkflowStage =
  | 'access'
  | 'quality'
  | 'package'
  | 'verify'
  | 'guard';

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
    // The catalog's declared version wins over the DTO, not the other way
    // round. The DTO only carries `nodeVersion`, and the create form sends it
    // for every stack whether or not the stack runs on Node — so reading it
    // first meant a .NET project was generated with `dotnet-version: 24` and
    // every job failed on an SDK that does not exist. A stack that declares its
    // runtime version owns it; only stacks that declare none take the DTO's,
    // which is every Node stack. See ADR-0006.
    runtimeVersion: template.runtimeVersion ?? dto.nodeVersion ?? '24',
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
          uses: `${CENTRAL_WORKFLOW_BASE}/${toolchain.sonar.workflow}@${ctx.centralWorkflowRef}`,
          with: {
            'working-directory': ctx.servicePath,
            'system-name': ctx.serviceName,
            'sources-path': toolchain.sonar.sourcesPath,
            'tests-path': toolchain.sonar.testsPath,
            'coverage-report-path': toolchain.sonar.coverageReportPath,
            ...(toolchain.sonar.extraWith ?? {}),
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
          {
            testJobId: toolchain.testJobId,
            // Sonar is secret-gated and skips on repositories that have not
            // configured it, so it cannot stand in for "the stage ran".
            workJobIds: toolchain.qualityJobIds,
          },
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
        'report-results': reportingJob(
          'package',
          ['validate-access', 'build', ...deploymentPlan.jobIds],
          {
            // The deploy jobs are branch-scoped and skip by design, so `build`
            // alone decides whether this stage packaged anything.
            workJobIds: ['build'],
          },
        ),
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
  opts?: { testJobId?: string; workJobIds?: string[] },
) {
  const isQuality = stage === 'quality';
  const testJobId = opts?.testJobId;

  /*
   * The jobs that ARE the stage, as opposed to the ones that let it start.
   *
   * Every stage needs `validate-access`, and in the two later stages it is
   * plumbing: it re-checks the caller and then hands over to the work. Asking
   * "did any job succeed?" therefore answered yes as soon as that gate passed,
   * which is not the same question as "did this stage do anything", and the
   * gap between the two is what produced 24 package rows reporting a success
   * with an empty payload. Naming the work explicitly closes it.
   *
   * Defaults to `needs` for a stage whose needs ARE its work, which is the
   * access stage: the gate is the only thing it does.
   */
  const workJobIds = opts?.workJobIds ?? needs;
  const workRanExpr = workJobIds
    .map((jobId) => `needs.${jobId}.result != 'skipped'`)
    .join(' || ');

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
    /*
     * Whether this stage's actual work ran, rather than whether any job did.
     *
     * `skipped` is neither failure nor cancelled, so without this a stage whose
     * work never started fell through to "success" — see the conclusion block
     * below for what that produced.
     */
    STAGE_WORK_RAN: `\${{ ${workRanExpr} }}`,
  };

  if (isQuality && testJobId) {
    stepEnv['COVERAGE_PCT'] =
      `\${{ needs.${testJobId}.outputs.coverage-percent }}`;
    stepEnv['COVERAGE_THRESHOLD'] =
      '${{ needs.branch-policy.outputs.coverage-threshold }}';
    /*
     * Counts and failing test NAMES, so the product can say
     * "2 test(s) failed: HealthTests.ReturnsServiceName" instead of handing
     * over a log and letting someone read it.
     *
     * A central workflow that does not publish these outputs yields empty
     * strings, and the script then omits `tests` entirely. A pipeline pinned
     * to an older ref therefore reports exactly as it did before, rather
     * than failing on an output it has never heard of.
     */
    stepEnv['TESTS_TOTAL'] = `\${{ needs.${testJobId}.outputs.tests-total }}`;
    stepEnv['TESTS_PASSED'] = `\${{ needs.${testJobId}.outputs.tests-passed }}`;
    stepEnv['TESTS_FAILED'] = `\${{ needs.${testJobId}.outputs.tests-failed }}`;
    stepEnv['TESTS_FAILURES'] =
      `\${{ needs.${testJobId}.outputs.tests-failures }}`;
    /*
     * Which packages are vulnerable, not just that the audit failed.
     *
     * The security job is named 'security' on every stack, which is why one
     * set of reads serves .NET and Node alike: dotnet-audit.yml and
     * security-scan.yml both publish these.
     */
    stepEnv['VULN_CRITICAL'] =
      '${{ needs.security.outputs.vulnerabilities-critical }}';
    stepEnv['VULN_HIGH'] = '${{ needs.security.outputs.vulnerabilities-high }}';
    stepEnv['VULN_ITEMS'] =
      '${{ needs.security.outputs.vulnerabilities-items }}';
    /*
     * Findings from the gates whose counts were computed and discarded.
     *
     * gitleaks-scan, dotnet-license-scan and dotnet-sbom each publish a count
     * and nothing read them. It matters most on dev, where these gates are
     * advisory: the job passes, so its conclusion says nothing, and the count
     * is the only thing separating 'clean' from '3 secrets found, not blocking
     * on this branch'.
     *
     * Read only when the toolchain actually declares the job. Node fills four
     * quality slots and has no licence inventory to take; `needs.licenses` there
     * would name a job that is not in `needs`, which evaluates to empty and
     * would post a count of nothing as though it were a count of zero.
     */
    const countOutputs: Record<string, [string, string][]> = {
      secrets: [
        ['SECRETS_FINDINGS', 'findings-count'],
        // Rule and location. The secret value is absent by construction
        // upstream — see gitleaks-scan.yml — because a report that carries it
        // has leaked it into somewhere more people can read than the repo.
        ['SECRETS_ITEMS', 'findings-items'],
      ],
      licenses: [
        ['LICENSE_FORBIDDEN', 'forbidden-count'],
        ['LICENSE_ITEMS', 'forbidden-items'],
        // Kept apart from the forbidden count on purpose: "this one is
        // disallowed" and "we could not tell" need different responses, and
        // merging them either buries a real hit or invents one.
        ['LICENSE_UNKNOWN', 'unknown-count'],
      ],
      sbom: [['SBOM_COMPONENTS', 'component-count']],
    };

    for (const [jobId, outputs] of Object.entries(countOutputs)) {
      if (!workJobIds.includes(jobId)) {
        continue;
      }
      for (const [envName, output] of outputs) {
        stepEnv[envName] = `\${{ needs.${jobId}.outputs.${output} }}`;
      }
    }

    /*
     * What SonarCloud actually said, not just whether it passed.
     *
     * `sonar` is in the reporting job's `needs` on every stack, so these are
     * read unconditionally — unlike the counts above, which belong to jobs only
     * some toolchains declare. A repository without Sonar credentials skips the
     * job, the outputs arrive empty, and the guards below leave the key out.
     *
     * Without these the product could say "sonar failed" and nothing else,
     * which is an instruction to go and read SonarCloud — the thing this is
     * supposed to remove.
     */
    stepEnv['SONAR_GATE'] = '${{ needs.sonar.outputs.gate-status }}';
    stepEnv['SONAR_CONDITIONS'] =
      '${{ needs.sonar.outputs.failed-conditions }}';
    stepEnv['SONAR_MEASURES'] = '${{ needs.sonar.outputs.measures }}';
  }

  const scriptLines = [
    '# Derive stage conclusion from upstream needs results',
    'if [ "$STAGE_FAILED" = "true" ]; then',
    '  CONCLUSION="failure"',
    'elif [ "$STAGE_CANCELLED" = "true" ]; then',
    '  CONCLUSION="cancelled"',
    'elif [ "$STAGE_WORK_RAN" != "true" ]; then',
    '  # THE WORK OF THIS STAGE NEVER RAN.',
    '  #',
    '  # Two ways to get here. The stage before it did not pass, so the access',
    '  # gate skipped and everything needing it skipped in turn; or the gate',
    '  # passed but the work is branch-scoped and this branch is not one it',
    '  # builds — a pull request into dev, whose head branch is the PR branch.',
    '  # `skipped` is neither failure nor cancelled, so this used to fall',
    '  # through to "success" and the platform recorded a package stage that',
    '  # built nothing and deployed nothing as a green deploy.',
    '  #',
    '  # Reporting nothing is the honest answer. When an earlier stage failed,',
    '  # it is also the complete one: a stage with no report resolves on read',
    '  # as `blocked`, naming the stage that stopped it. When the gate passed',
    '  # and only the branch scope skipped the work, the reader currently sees',
    '  # `pending`, which is imprecise but not a lie — unlike the `success` it',
    '  # replaces. Saying `skipped` outright would need a migration.',
    '  echo "This stage did no work, so there is nothing to report."',
    '  echo "Either the stage before it did not pass, or this branch is not one"',
    '  echo "this stage builds."',
    '  exit 0',
    'else',
    '  CONCLUSION="success"',
    'fi',
    '',
    '# Capture WHY the stage failed: the job, the step inside it that failed,',
    '# and the annotations GitHub recorded (lint errors, failing tests,',
    '# compiler output). Without these the product can only say THAT a stage',
    '# failed, which is what sent people to GitHub to learn anything useful.',
    'FAILED_JOBS=""',
    'ANNOTATIONS="[]"',
    'CHECKS="[]"',
    '',
    '# ALWAYS fetch, on success as well as failure.',
    '#',
    '# This used to sit behind `if [ "$CONCLUSION" = "failure" ]`, which meant',
    '# the branch that most needs the detail never collected any. On dev the',
    '# gates are advisory - `fail-on-warning` is false - so a stage carrying',
    '# twelve real diagnostics still concludes SUCCESS, skipped the capture',
    '# entirely, and the developer saw a green tick and a coverage number.',
    '# The warnings that would block them at uat were recorded nowhere, on the',
    '# one branch where there was still time to fix them.',
    'JOBS_JSON=$(curl -sf --max-time 10 -H "Authorization: Bearer $GITHUB_TOKEN" -H "Accept: application/vnd.github+json" "https://api.github.com/repos/$GH_REPO/actions/runs/$GH_RUN_ID/jobs?filter=latest" || printf \'{"jobs":[]}\')',
    '',
    '# Every job, with what it concluded - the per-TOOL view.',
    '#',
    '# A stage status answers "did the quality stage pass". It cannot answer',
    '# "did the licence scan pass", and one red bar covering seven tools sends',
    '# the reader to GitHub to find out which one. The reporting job is the only',
    '# place that can see all of them at once, so it is the place that lists them.',
    '#',
    '# The reporting job itself is excluded: it is still running, so its',
    '# conclusion is null, and it is plumbing rather than a check anyone asked for.',
    'CHECKS=$(printf \'%s\' "$JOBS_JSON" | jq -c \'[.jobs[]? | select(.name != "report-results") | {name: .name, conclusion: (.conclusion // "running"), startedAt: .started_at, completedAt: .completed_at}]\' || printf \'[]\')',
    '',
    'if [ "$CONCLUSION" = "failure" ]; then',
    '  FAILED_JOBS=$(printf \'%s\' "$JOBS_JSON" | jq -r \'.jobs[] | select(.conclusion == "failure") | . as $job | (([$job.steps[]? | select(.conclusion == "failure") | .name] | first) // "") as $step | if $step == "" then "Failed GitHub Actions job: \\($job.name)" else "Failed GitHub Actions job: \\($job.name) > \\($step)" end\' | head -n 5 || true)',
    'fi',
    '',
    '# Annotations are the actual diagnostics - "Program.cs:11 Await RunAsync',
    '# instead of blocking". Collected from every job that ran, not only the',
    '# failed ones, because an advisory job on dev reports its findings as',
    '# annotations and passes. Those ARE the errors the developer needs.',
    '#',
    '# A job id is its check-run id for Actions, so one id addresses both.',
    '# Failed jobs first, so a capped list keeps the diagnostics that explain a',
    '# failure ahead of the advisory noise from jobs that passed.',
    'ANNOTATION_IDS=$(printf \'%s\' "$JOBS_JSON" | jq -r \'[.jobs[]? | select(.name != "report-results")] | sort_by(.conclusion != "failure") | .[].id\' | head -n 8)',
    'for JOB_ID in $ANNOTATION_IDS; do',
    '  JOB_ANN=$(curl -sf --max-time 10 -H "Authorization: Bearer $GITHUB_TOKEN" -H "Accept: application/vnd.github+json" "https://api.github.com/repos/$GH_REPO/check-runs/$JOB_ID/annotations" || printf \'[]\')',
    '  # Keep the annotations that point at CODE, at any level.',
    '  #',
    '  # Filtering on annotation_level == "failure" looked right and threw away',
    '  # every useful annotation. A Roslyn analyzer or formatter reports its',
    '  # diagnostics as WARNINGS - "Program.cs:11 Await RunAsync instead" -',
    '  # while the only failure-level annotation is the runner\'s own "Process',
    '  # completed with exit code 1", whose path is the workflow file. So the',
    '  # filter kept the one annotation that says nothing and discarded every',
    '  # one that named the actual problem.',
    '  #',
    '  # Deduplicated because a solution built more than once (analyze, then',
    '  # sonar) reports the same diagnostic on each pass.',
    '  ANNOTATIONS=$(printf \'%s %s\' "$ANNOTATIONS" "$JOB_ANN" | jq -s -c \'add | map(select(.path and (.path | startswith(".github") | not))) | map(select(.message and (.message | test("Process completed with exit code") | not))) | map({path: .path, line: .start_line, level: .annotation_level, title: .title, message: .message}) | unique_by([.path, .line, .message]) | .[0:20]\' || printf \'%s\' "$ANNOTATIONS")',
    'done',
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
          '',
          '# Include the test counts and failing names when the central workflow',
          '# published them. An older ref publishes nothing, so these arrive empty',
          '# and `tests` is simply left out of the payload.',
          'if echo "$TESTS_TOTAL" | grep -qE \'^[0-9]+$\' && [ "$TESTS_TOTAL" -gt 0 ]; then',
          '  TESTS=$(jq -n \\',
          '    --argjson total "$TESTS_TOTAL" \\',
          '    --argjson passed "${TESTS_PASSED:-0}" \\',
          '    --argjson failed "${TESTS_FAILED:-0}" \\',
          '    --argjson failures "${TESTS_FAILURES:-[]}" \\',
          "    '{total:$total,passed:$passed,failed:$failed,failures:$failures}')",
          '  RESULTS=$(printf \'%s\' "$RESULTS" | jq -c --argjson tests "$TESTS" \'. + {tests:$tests}\')',
          'fi',
          '',
          '# Include the vulnerability counts when the security job published them.',
          '# Same guard as the tests: an older central ref publishes nothing, so these',
          '# arrive empty and `security` is left out rather than posted as null.',
          'if echo "$VULN_CRITICAL$VULN_HIGH" | grep -qE \'^[0-9]+$\'; then',
          '  SECURITY=$(jq -n \\',
          '    --argjson critical "${VULN_CRITICAL:-0}" \\',
          '    --argjson high "${VULN_HIGH:-0}" \\',
          '    --argjson items "${VULN_ITEMS:-[]}" \\',
          "    '{critical:$critical,high:$high,items:$items}')",
          '  RESULTS=$(printf \'%s\' "$RESULTS" | jq -c --argjson security "$SECURITY" \'. + {security:$security}\')',
          'fi',
          '',
          '# Counts from the advisory gates, so "passed" can be told apart from',
          '# "passed with findings".',
          '#',
          '# On dev these three do not block, so their job conclusion is `success`',
          '# whether they found nothing or found nine. The count is the only thing',
          '# that separates the two, and without it the developer reads a green tick',
          '# and promotes into a uat run that fails on exactly what dev already knew.',
          '#',
          '# Absent when the toolchain does not declare the job, so an empty string',
          '# leaves the key out rather than posting 0 - which would claim a clean',
          '# scan for a scan that never ran.',
          'FINDINGS="{}"',
          'if echo "$SECRETS_FINDINGS" | grep -qE \'^[0-9]+$\'; then',
          '  FINDINGS=$(printf \'%s\' "$FINDINGS" | jq -c --argjson n "$SECRETS_FINDINGS" \'. + {secrets:$n}\')',
          'fi',
          'if echo "$LICENSE_FORBIDDEN" | grep -qE \'^[0-9]+$\'; then',
          '  FINDINGS=$(printf \'%s\' "$FINDINGS" | jq -c --argjson n "$LICENSE_FORBIDDEN" \'. + {forbiddenLicenses:$n}\')',
          'fi',
          'if echo "$SBOM_COMPONENTS" | grep -qE \'^[0-9]+$\'; then',
          '  FINDINGS=$(printf \'%s\' "$FINDINGS" | jq -c --argjson n "$SBOM_COMPONENTS" \'. + {sbomComponents:$n}\')',
          'fi',
          'if echo "$LICENSE_UNKNOWN" | grep -qE \'^[0-9]+$\'; then',
          '  FINDINGS=$(printf \'%s\' "$FINDINGS" | jq -c --argjson n "$LICENSE_UNKNOWN" \'. + {undeterminedLicenses:$n}\')',
          'fi',
          '',
          '# The lists, not just the totals. A count cannot be acted on: it says a',
          '# problem exists and leaves finding it as homework.',
          '#',
          '# The secret VALUES are not here and must never be. gitleaks-scan.yml',
          '# selects rule and location only, so what arrives is already safe to',
          '# store and to render.',
          'if printf \'%s\' "${SECRETS_ITEMS:-}" | jq -e \'type == "array" and length > 0\' >/dev/null 2>&1; then',
          '  FINDINGS=$(printf \'%s\' "$FINDINGS" | jq -c --argjson i "$SECRETS_ITEMS" \'. + {secretItems:$i}\')',
          'fi',
          'if printf \'%s\' "${LICENSE_ITEMS:-}" | jq -e \'type == "array" and length > 0\' >/dev/null 2>&1; then',
          '  FINDINGS=$(printf \'%s\' "$FINDINGS" | jq -c --argjson i "$LICENSE_ITEMS" \'. + {licenseItems:$i}\')',
          'fi',
          'if [ "$FINDINGS" != "{}" ]; then',
          '  RESULTS=$(printf \'%s\' "$RESULTS" | jq -c --argjson findings "$FINDINGS" \'. + {findings:$findings}\')',
          'fi',
          '',
          '# What SonarCloud said, so nobody has to open SonarCloud to read it.',
          '#',
          '# The gate alone is the same problem one level up: "ERROR" tells a',
          '# reader something is wrong and nothing about what. The conditions',
          '# carry the metric, the actual value and the threshold, which is the',
          '# difference between "quality gate failed" and "new coverage 61.2 is',
          '# below the required 80".',
          '#',
          '# UNKNOWN is kept rather than dropped: it means the analysis ran and',
          '# the gate could not be read, which is a different thing from a gate',
          '# that passed, and silently treating it as clean is how a broken',
          '# reporting path starts looking like a healthy project.',
          'SONAR="{}"',
          'if [ -n "$SONAR_GATE" ]; then',
          '  SONAR=$(printf \'%s\' "$SONAR" | jq -c --arg gate "$SONAR_GATE" \'. + {gate:$gate}\')',
          'fi',
          'if printf \'%s\' "${SONAR_CONDITIONS:-}" | jq -e \'type == "array" and length > 0\' >/dev/null 2>&1; then',
          '  SONAR=$(printf \'%s\' "$SONAR" | jq -c --argjson c "$SONAR_CONDITIONS" \'. + {failedConditions:$c}\')',
          'fi',
          'if printf \'%s\' "${SONAR_MEASURES:-}" | jq -e \'type == "object" and length > 0\' >/dev/null 2>&1; then',
          '  SONAR=$(printf \'%s\' "$SONAR" | jq -c --argjson m "$SONAR_MEASURES" \'. + {measures:$m}\')',
          'fi',
          'if [ "$SONAR" != "{}" ]; then',
          '  RESULTS=$(printf \'%s\' "$RESULTS" | jq -c --argjson sonar "$SONAR" \'. + {sonar:$sonar}\')',
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
    '  --argjson annotations "$ANNOTATIONS" \\',
    '  --argjson checks "$CHECKS" \\',
    "  '{repoFullName:$repo,branch:$branch,commitSha:$sha,runId:$runId,stage:$stage,conclusion:$conclusion,results:$results,rawLogs:$rawLogs,annotations:$annotations,checks:$checks}')",
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
    /*
     * Granted on this job alone, so reading run metadata cannot widen what the
     * build and deploy jobs are allowed to do.
     *
     * `actions: read` is what makes failure capture work AT ALL on a private
     * repository. Declaring `permissions:` sets every unlisted scope to none,
     * and the jobs API needs `actions: read` unless the repository is public,
     * where the same data is readable without it. That is exactly why the
     * failed job name was recorded for every public test repo and for none of
     * the private ones: the call 401'd and `|| true` swallowed it. Private is
     * the default for real customers, so the product was blind precisely where
     * it mattered.
     *
     * `checks: read` is for the annotations, which carry the file, line and
     * message of each individual error.
     */
    permissions: {
      contents: 'read',
      actions: 'read',
      checks: 'read',
    },
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
