import yaml from 'js-yaml';

import { resolveCentralWorkflowBase } from '#kernel/config/central-workflow';
import { ENV_GUARD_CHECK_CONTEXT } from '#kernel/ports/workflow-generation.port';
import type { WorkflowTemplate } from '../catalog/catalog.service';
import {
  VERCEL_ALIAS_VARIABLE,
  vercelAutomationBypassSecretName,
  vercelBranchAlias,
} from '#kernel/ports/workflow-fragment.port';
import type {
  WorkflowFragmentBranch,
  WorkflowFragmentRegistry,
} from '#kernel/ports/workflow-fragment.port';
import type {
  ToolchainApiVerification,
  ToolchainFragmentResult,
  ToolchainUiVerification,
} from '#kernel/ports/toolchain-fragment.port';
import {
  ENVIRONMENT_PROMOTE_WORKFLOW_FILE,
  HOSTED_BRANCHES,
  PIPELINE_BRANCHES,
} from '#kernel/config/pipeline-branches';
import { BROWSER_TEST_DEPENDENCIES } from './browser-test-dependencies';
import { defaultToolchainRegistry } from './toolchains';
import type { GenerateWorkflowDto } from './dto/generate-workflow.dto';

export type WorkflowStage =
  | 'access'
  | 'quality'
  | 'package'
  | 'verify'
  | 'guard'
  | 'promote';

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
 * Where a generated pipeline asks this deployment to release what it built.
 *
 * The base, not an endpoint: release.yml appends its own paths, and one value
 * covers both the request and the status poll. Installed as a repository
 * secret beside the token for the same reason the report URL is - a customer
 * repository must not carry a hardcoded address of someone else's platform.
 */
export const ALPHACI_API_URL = PLATFORM_BASE_URL;

/**
 * The browser-test packages playwright-e2e.yml makes sure resolve before it
 * runs (`ensure-test-deps`). Defined once in browser-test-dependencies.ts,
 * which the starter-pack scaffold also reads, so the versions the verify run
 * installs and the versions a new repository declares can never drift.
 * Re-exported here for callers that import it from the builder.
 */
export { BROWSER_TEST_DEPENDENCIES };

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
const PIPELINE_CONTEXT_JOB_ID = 'pipeline-context';
const PIPELINE_CONTEXT_ARTIFACT = 'alphaci-pipeline-context';

/*
 * WHICH BRANCH IS THIS RUN ACTUALLY FOR?
 *
 * Not the one GitHub reports. A `workflow_run` stage executes in the DEFAULT
 * branch context, so its own run records the default branch and the default
 * branch's commit - whatever branch the work was really for. That is survivable
 * one hop out, because the FIRST chained stage reads the payload of the push
 * run that triggered it, and a push run carries the truth.
 *
 * It is not survivable two hops out. The second chained stage reads the payload
 * of a `workflow_run` run, and every field in it already says `main`. Measured
 * on a real push to dev:
 *
 *     dev tip                    aa9911f5
 *     package run head_sha       ad9d9090   <- main's tip
 *     package run head_branch    main
 *
 * The consequences were not subtle. A push to dev ran the production gate,
 * built the main image, and attempted a PRODUCTION deploy - of main's code,
 * not the commit that was pushed - while promote-to-uat, which requires the
 * branch to be dev, could never fire. That is why the promotion PR had never
 * once been raised.
 *
 * Nothing in the event can recover it, so the context is carried instead: each
 * chained stage republishes the branch and commit it resolved as an artifact,
 * and the next stage reads it back from the run that triggered it. The first
 * chained stage has no artifact to read and falls back to the payload, which
 * is correct precisely there.
 */
/*
 * The access stage and the env guard are triggered by the push itself, so
 * the ref they run on IS the branch. They have no context job and must not
 * reference one - actionlint rejects the workflow outright if they do.
 */
const DIRECT_BRANCH_EXPR = 'github.ref_name';
const DIRECT_SHA_EXPR = '${{ github.sha }}';

const BRANCH_EXPR = `needs.${PIPELINE_CONTEXT_JOB_ID}.outputs.branch`;

const HEAD_SHA_EXPR = `\${{ needs.${PIPELINE_CONTEXT_JOB_ID}.outputs.sha }}`;

/**
 * Resolves the originating branch and commit, and republishes them for the
 * stage after this one.
 *
 * The fallback is not a nicety: the first chained stage legitimately has no
 * artifact to read, and a manual dispatch has no upstream run at all. In both
 * cases the payload - or the ref the dispatch chose - is the right answer.
 */
function pipelineContextJob() {
  const shell = [
    'set -euo pipefail',
    '',
    'branch="${FALLBACK_BRANCH}"',
    'sha="${FALLBACK_SHA}"',
    'source="the triggering event"',
    '',
    '# An artifact published by the previous stage is the only channel that',
    '# survives a second workflow_run hop, so it wins when it is there.',
    'if [ "${EVENT_NAME}" = "workflow_run" ] && [ -n "${TRIGGER_RUN_ID}" ]; then',
    '  api="https://api.github.com/repos/${GH_REPO}/actions/runs/${TRIGGER_RUN_ID}/artifacts"',
    '  filter=\'[.artifacts[]? | select(.name == $name) | .archive_download_url] | first // ""\'',
    '  url=$(curl -sf --max-time 10 -H "Authorization: Bearer ${GH_TOKEN}" -H "Accept: application/vnd.github+json" "${api}" | jq -r --arg name "${ARTIFACT_NAME}" "${filter}" || printf "")',
    '',
    '  if [ -n "${url}" ] && curl -sfL --max-time 20 -o context.zip -H "Authorization: Bearer ${GH_TOKEN}" "${url}"; then',
    '    unzip -o -q context.zip -d context-dir',
    '    if [ -f context-dir/pipeline-context.env ]; then',
    '      branch=$(grep -m1 "^branch=" context-dir/pipeline-context.env | cut -d= -f2-)',
    '      sha=$(grep -m1 "^sha=" context-dir/pipeline-context.env | cut -d= -f2-)',
    '      source="the ${PREVIOUS_NAME} stage"',
    '    fi',
    '  fi',
    'fi',
    '',
    '# Refusing to guess. Every later job is branch-scoped, so an empty branch',
    '# selects nothing - or worse, matches the wrong environment.',
    'if [ -z "${branch}" ] || [ -z "${sha}" ]; then',
    '  echo "::error::Could not determine which branch or commit this run is for. Without it every branch-scoped job would be selected wrongly, so the stage stops here."',
    '  exit 1',
    'fi',
    '',
    '{',
    '  echo "branch=${branch}"',
    '  echo "sha=${sha}"',
    '} | tee pipeline-context.env >> "$GITHUB_OUTPUT"',
    '',
    'echo "Branch ${branch} at ${sha}, according to ${source}."',
  ];

  return {
    runs_on: 'ubuntu-latest',
    permissions: {
      contents: 'read',
      actions: 'read',
    },
    outputs: {
      branch: '${{ steps.context.outputs.branch }}',
      sha: '${{ steps.context.outputs.sha }}',
    },
    steps: [
      {
        name: 'Resolve the originating branch and commit',
        id: 'context',
        env: {
          GH_TOKEN: '${{ github.token }}',
          GH_REPO: '${{ github.repository }}',
          EVENT_NAME: '${{ github.event_name }}',
          TRIGGER_RUN_ID: '${{ github.event.workflow_run.id }}',
          PREVIOUS_NAME: '${{ github.event.workflow_run.name }}',
          ARTIFACT_NAME: PIPELINE_CONTEXT_ARTIFACT,
          FALLBACK_BRANCH:
            '${{ github.event.workflow_run.head_branch || github.ref_name }}',
          FALLBACK_SHA:
            '${{ github.event.workflow_run.head_sha || github.sha }}',
        },
        run: shell.join('\n'),
      },
      {
        // Republished rather than forwarded: the stage after this one reads it
        // from THIS run, because that is the only run it can address.
        name: 'Publish the context for the next stage',
        uses: 'actions/upload-artifact@v4',
        with: {
          name: PIPELINE_CONTEXT_ARTIFACT,
          path: 'pipeline-context.env',
          'retention-days': 1,
        },
      },
    ],
  };
}

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
const RESOLVE_TARGETS_JOB_ID = 'resolve-targets';
const UPSTREAM_WORK_JOB_ID = 'upstream-work-check';

/*
 * Two conditions, not one. The previous run has to have CONCLUDED success
 * and to have actually run something - see upstreamWorkCheckJob for why the
 * conclusion alone is not enough.
 */
const CHAINED_STAGE_GATE =
  "${{ github.event_name == 'workflow_dispatch' || " +
  "(github.event.workflow_run.conclusion == 'success' && " +
  `needs.${UPSTREAM_WORK_JOB_ID}.outputs.ran == 'true') }}`;
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

/**
 * `branchIsOneOf`, and the deployment this suite points at was located.
 *
 * `resolve-targets` publishes `<kind>-skipped` when the variable holding the
 * address is not set - nothing was deployed there - and a suite aimed at an
 * address that does not exist reports the absence of an environment as a
 * failure of the code. The suite is skipped instead, and the stage says why.
 */
function branchIsOneOfAndDeployed(
  branches: readonly string[],
  kind: 'api' | 'ui',
): string {
  const test = branches
    .map((branch) => `(${BRANCH_EXPR}) == '${branch}'`)
    .join(' || ');

  return `\${{ (${test}) && needs.${RESOLVE_TARGETS_JOB_ID}.outputs.${kind}-skipped != 'true' }}`;
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
  /**
   * `owner/repo` of the paired frontend/backend repository, multi-repo
   * projects only. Threaded into the generated promote-to-uat /
   * promote-to-main jobs' `sibling-repo` input so `promotion.yml` can
   * cross-link this promotion PR with the sibling's matching one (§8.5).
   *
   * Left undefined for every other repo shape, and for multi-repo callers
   * that predate this field. `promotionJob` below omits the `sibling-repo`
   * key from the generated `with:` block entirely when this is undefined —
   * not an empty string — so a single-repo pipeline's generated YAML is
   * byte-for-byte unchanged.
   */
  siblingRepoFullName?: string;
  /**
   * The project's environments. When set, the pipeline is generated from
   * them: every source branch runs the quality stages, only the first
   * environment deploys on push, and later environments deploy only when
   * AlphaCI dispatches the promotion workflow for a registered release.
   */
  environments?: StagedWorkflowEnvironment[];
  /** The deployment target of each environment and slot, for environments mode. */
  environmentTargets?: StagedEnvironmentTarget[];
}

export interface StagedWorkflowEnvironment {
  id: string;
  slug: string;
  sourceBranch: string;
  position: number;
  role: 'production' | 'non_production';
}

export interface StagedEnvironmentTarget {
  environmentId: string;
  slot: 'backend' | 'frontend' | 'standalone';
  targetId: string;
  provider: string;
}

/** The promotion workflow AlphaCI dispatches, relative to .github/workflows. */
export const PROMOTE_WORKFLOW_FILE = ENVIRONMENT_PROMOTE_WORKFLOW_FILE;
const PROMOTE_WORKFLOW_NAME = 'ALPHACI 5 Promote';

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
  verifyName: string;
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
  siblingRepoFullName: string | undefined;
  names: StagedNames;
  /** Branches that run the pipeline: the environments' source branches, or the fixed flow. */
  branches: readonly string[];
}

function resolveStagedNames(
  workflowVariant: StagedWorkflowOptions['workflowVariant'],
): StagedNames {
  const fileSuffix = workflowVariant ? `-${workflowVariant}` : '';
  const nameSuffix = workflowVariant ? ` (${workflowVariant})` : '';
  return {
    fileSuffix,
    accessName: `ALPHACI 1 Access${nameSuffix}`,
    qualityName: `ALPHACI 2 Quality${nameSuffix}`,
    packageName: `ALPHACI 3 Build and Deploy${nameSuffix}`,
    verifyName: `ALPHACI 4 Post-Deploy Tests${nameSuffix}`,
  };
}

/**
 * The title GitHub shows for a run of a chained stage.
 *
 * A `workflow_run` stage executes in the DEFAULT branch context, so GitHub
 * records its branch as `main` whatever branch the work was actually for, and
 * its title as the workflow's own name. The result is a run list where four
 * rows read "ALPHACI 2 Quality / main" and nothing distinguishes the dev run
 * from the uat one - verified on a real run that GitHub recorded as `main`
 * while the workflow itself resolved `branch=dev`.
 *
 * `display_title` rather than the commit message: a message can be several
 * lines long, and a newline in a run-name mangles it. GitHub derives
 * display_title as a single line.
 *
 * The direct-trigger workflows do not need this - GitHub already shows their
 * real branch and commit, because they are triggered by the push itself.
 */
/*
 * run-name is evaluated before any job runs, so it cannot read the context job,
 * and the branch is only knowable at the FIRST chained stage - the one whose
 * trigger was the push itself. Later stages inherit it for free: their
 * display_title is the previous stage's run-name, which already carries the
 * prefix. Repeating the event expression in them would print `main` on a dev
 * run, which is exactly the misleading label this exists to remove.
 */
const FIRST_CHAINED_RUN_NAME =
  '${{ github.event.workflow_run.head_branch || github.ref_name }}' +
  ' · ' +
  '${{ github.event.workflow_run.display_title || github.sha }}';

const INHERITED_RUN_NAME =
  '${{ github.event.workflow_run.display_title || github.sha }}';

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
    siblingRepoFullName: dto.siblingRepoFullName,
    names: resolveStagedNames(dto.workflowVariant),
    branches: environmentBranches(dto.environments) ?? PIPELINE_BRANCHES,
  };
}

// Branch names go into workflow expressions, so only plain ref characters.
const SAFE_BRANCH = /^[A-Za-z0-9._/-]{1,255}$/;

function orderedEnvironments(
  environments: StagedWorkflowEnvironment[],
): StagedWorkflowEnvironment[] {
  const ordered = [...environments].sort((a, b) => a.position - b.position);
  for (const environment of ordered) {
    if (!SAFE_BRANCH.test(environment.sourceBranch)) {
      throw new Error(
        'Environment ' +
          environment.slug +
          ' has a source branch that cannot be used in a workflow: ' +
          environment.sourceBranch,
      );
    }
  }
  return ordered;
}

function environmentBranches(
  environments: StagedWorkflowEnvironment[] | undefined,
): string[] | undefined {
  if (!environments?.length) return undefined;
  return [
    ...new Set(
      orderedEnvironments(environments).map(({ sourceBranch }) => sourceBranch),
    ),
  ];
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
        push: { branches: [...ctx.branches] },
        pull_request: { branches: [...ctx.branches] },
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
    buildBranchCondition: branchIsOneOf(ctx.branches),
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
      'run-name': FIRST_CHAINED_RUN_NAME,
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
      jobs: withPipelineContext({
        [UPSTREAM_WORK_JOB_ID]: upstreamWorkCheckJob(),
        [VALIDATE_ACCESS_JOB_ID]: {
          needs: [UPSTREAM_WORK_JOB_ID],
          if: CHAINED_STAGE_GATE,
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
      }),
    }),
  };
}

/**
 * The verify stage: exercise the service that was just deployed.
 *
 * Every earlier stage reads source. Access checks entitlement, quality
 * analyses the code, package builds and deploys the artifact — and none of
 * them can answer whether the thing now running actually behaves. That is the
 * question this stage exists for, and it is why it needs a stage rather than a
 * job inside package: its subject is a deployment, not a commit.
 *
 * It runs only where there IS a deployment. Render targets are generated for
 * uat and main, so dev builds and is never deployed; pointing an API suite at
 * a service that does not exist would report the absence of an environment as
 * a failure of the code.
 *
 * uat runs the whole collection, main runs the read-only subset. A CRUD suite
 * aimed at production is not a test, it is a write — and main is reached only
 * by promotion from uat, so the destructive coverage has already run against
 * the same artifact.
 */
function buildVerifyWorkflowFile(
  ctx: StagedWorkflowContext,
  verification: {
    api?: ToolchainApiVerification | undefined;
    ui?: ToolchainUiVerification | undefined;
  },
): StagedWorkflowFile {
  const { verifyName, packageName, fileSuffix } = ctx.names;

  /*
   * Where each kind of test points.
   *
   * Read from `vars`, and passed on through the resolve-targets job below
   * rather than inlined here. Three separate constraints force that shape:
   *
   *   1. `secrets` is NOT an allowed context inside a reusable workflow call's
   *      `with:` block. GitHub rejects the WHOLE FILE at parse time, producing
   *      a 0-second run with no jobs, listed by filename because the workflow
   *      name could not be read either. This stage never ran once on a real
   *      project because of it.
   *   2. Routing a secret through a job output does not work either: GitHub
   *      redacts job outputs containing a secret, so the URL arrives empty.
   *   3. A `workflow_run` stage cannot see the triggering run's job outputs,
   *      so the address cannot be handed over from the deploy that set it.
   *
   * `vars` satisfies all three, and is where these belong on their own merit:
   * a healthcheck URL and a Vercel alias are public hostnames, not credentials.
   */
  const apiUrl = (branch: 'uat' | 'main') =>
    `\${{ needs.${RESOLVE_TARGETS_JOB_ID}.outputs.api-${branch} }}`;

  const uiUrl = (branch: 'uat' | 'main') =>
    `https://\${{ needs.${RESOLVE_TARGETS_JOB_ID}.outputs.ui-${branch} }}`;

  const apiTestJob = (branch: 'uat' | 'main') => ({
    needs: [VALIDATE_ACCESS_JOB_ID, RESOLVE_TARGETS_JOB_ID],
    if: branchIsOneOfAndDeployed([branch], 'api'),
    uses: `${CENTRAL_WORKFLOW_BASE}/bruno-api-test.yml@${ctx.centralWorkflowRef}`,
    with: {
      'working-directory': ctx.servicePath,
      'system-name': ctx.serviceName,
      'base-url': apiUrl(branch),
      'collection-path': verification.api!.collectionPath,
      // Production runs the read-only folder; uat runs everything.
      ...(branch === 'main' ? { folder: verification.api!.smokeFolder } : {}),
      'checkout-ref': HEAD_SHA_EXPR,
    },
    secrets: {
      API_USERNAME: '${{ secrets.API_USERNAME }}',
      API_PASSWORD: '${{ secrets.API_PASSWORD }}',
      API_TOKEN: '${{ secrets.API_TOKEN }}',
    },
  });

  /*
   * Contract tests, uat only.
   *
   * This sends deliberately malformed payloads. Aimed at production that is
   * not a test, it is an attack on a live service — and main is reached only
   * by promotion from uat, so the same artifact has already been fuzzed.
   */
  const contractTestJob = () => ({
    needs: [VALIDATE_ACCESS_JOB_ID, RESOLVE_TARGETS_JOB_ID],
    if: branchIsOneOfAndDeployed(['uat'], 'api'),
    uses: `${CENTRAL_WORKFLOW_BASE}/schemathesis-scan.yml@${ctx.centralWorkflowRef}`,
    with: {
      'working-directory': ctx.servicePath,
      'system-name': ctx.serviceName,
      'base-url': apiUrl('uat'),
      'checkout-ref': HEAD_SHA_EXPR,
    },
  });

  const uiTestJob = (branch: 'uat' | 'main') => ({
    needs: [VALIDATE_ACCESS_JOB_ID, RESOLVE_TARGETS_JOB_ID],
    if: branchIsOneOfAndDeployed([branch], 'ui'),
    uses: `${CENTRAL_WORKFLOW_BASE}/playwright-e2e.yml@${ctx.centralWorkflowRef}`,
    with: {
      'working-directory': ctx.servicePath,
      'system-name': ctx.serviceName,
      'e2e-base-url': uiUrl(branch),
      'e2e-tests-directory': verification.ui!.testsDirectory,
      'browser-list': verification.ui!.browsers,
      /*
       * The branch is decided above, by the `if:` on this job.
       *
       * playwright-e2e.yml carries a second branch gate of its own, defaulting
       * to `test` - a tier that no longer exists - and it compares against
       * `github.ref_name`. A workflow_run stage always reports the DEFAULT
       * branch there, which is the whole reason this pipeline resolves its own
       * context, so that comparison was `main != test` on every run: the suite
       * reported `skipped`, and `skipped` finalises as a pass. Playwright has
       * therefore never executed once on a generated pipeline.
       *
       * `*` disables the inner gate rather than feeding it a branch it cannot
       * see correctly. One gate, in the half that knows the answer.
       */
      'run-only-on-branch': '*',
      'upload-artifacts': true,
      /*
       * ALPHACI-stored visual baselines (opt-in input on playwright-e2e.yml).
       *
       * With this on, the reusable workflow fetches the branch's approved
       * baseline screenshots from this platform before the run, compares
       * against them, and reports the outcome back (`/ci/visual-summary`,
       * `/ci/visual-results/file`). Baselines therefore never live in the
       * customer repository: a person approves a changed screenshot in
       * ALPHACI and the next run compares against it, with no commit.
       *
       * `alphaci-api-url` is the platform base, the same value release.yml
       * receives, and is a literal because a `with:` block cannot read
       * `secrets.*` (the whole file is rejected at parse time). It is a
       * public address, not a credential. The branch is passed explicitly for
       * the reason `run-only-on-branch` is: the reusable workflow sees the
       * DEFAULT branch in `github.ref_name` under `workflow_run`, and
       * baselines are per branch (main falls back to uat's approved set).
       */
      'ensure-test-deps': BROWSER_TEST_DEPENDENCIES,
      'visual-baselines': true,
      'alphaci-api-url': ALPHACI_API_URL,
      'visual-branch': branch,
    },
    /*
     * A browser suite's target is always the Vercel-deployed frontend slot -
     * Vercel is the only provider this platform lets take that slot (see
     * `supportedSlots` on the provider registry) - so the bypass secret this
     * job needs is always the frontend one, whether or not this particular
     * project has that target wired up yet.
     *
     * `secrets:` and not `with:`: GitHub rejects the whole workflow file at
     * parse time if a reusable-workflow call reads `secrets.*` inside `with:`,
     * but a `secrets:` block is exactly what a reusable-workflow call takes
     * it in. An unset repository secret evaluates to an empty string here,
     * which playwright-e2e.yml (and this scaffold's playwright.config.ts)
     * both treat as "no bypass header to send" - so a project with no Vercel
     * frontend target, or one that predates this, runs exactly as before.
     */
    secrets: {
      VERCEL_AUTOMATION_BYPASS_SECRET: `\${{ secrets.${vercelAutomationBypassSecretName('frontend')} }}`,
      /*
       * The bearer for the visual-baseline calls: the same per-repository
       * token the report job authenticates with. A `secrets:` entry, never
       * inside `with:`, for the parse-time reason above.
       */
      ALPHACI_TOKEN: '${{ secrets.ALPHACI_TOKEN }}',
    },
  });

  /*
   * Only the jobs this stack can actually supply.
   *
   * A stack declaring neither never reaches here — the stage is not emitted
   * for it. A stack declaring both gets both, which is what a full-stack
   * repository in one slot would want.
   */
  /*
   * Reads the deployment addresses out of `vars` and republishes them as job
   * outputs, because `needs` IS allowed in a `with:` block and `secrets` is
   * not - see the comment on apiUrl above.
   *
   * It also fails loudly when the variable this branch needs is missing. That
   * is the half that matters day to day: an unset variable is an empty base
   * URL, the suite requests "", and the connection error that follows reads
   * like a broken API rather than like configuration nobody added.
   */
  const resolveTargetsJob = () => {
    const outputs: Record<string, string> = {};
    const env: Record<string, string> = {
      BRANCH: `\${{ ${BRANCH_EXPR} }}`,
    };
    const lines: string[] = ['set -euo pipefail', '', '{'];
    const requiredByBranch: Record<string, ['api' | 'ui', string][]> = {
      uat: [],
      main: [],
    };

    /*
     * One variable for every branch, because the branch is a prefix on it.
     * A Render service is per-branch and so are its variables; a Vercel
     * project serves all three branches, so a per-branch variable would have
     * been three copies of one hostname.
     */
    if (verification.ui) {
      env[VERCEL_ALIAS_VARIABLE] = `\${{ vars.${VERCEL_ALIAS_VARIABLE} }}`;
      outputs['ui-skipped'] = '${{ steps.resolve.outputs.ui-skipped }}';
    }
    if (verification.api) {
      outputs['api-skipped'] = '${{ steps.resolve.outputs.api-skipped }}';
    }
    outputs['skip-reason'] = '${{ steps.resolve.outputs.skip-reason }}';

    for (const branch of ['uat', 'main'] as const) {
      if (verification.api) {
        const variable = `RENDER_HEALTHCHECK_URL_${branch.toUpperCase()}`;
        outputs[`api-${branch}`] =
          `\${{ steps.resolve.outputs.api-${branch} }}`;
        env[variable] = `\${{ vars.${variable} }}`;
        lines.push(`  echo "api-${branch}=\${${variable}}"`);
        requiredByBranch[branch]!.push(['api', variable]);
      }
      if (verification.ui) {
        outputs[`ui-${branch}`] = `\${{ steps.resolve.outputs.ui-${branch} }}`;
        lines.push(
          `  echo "ui-${branch}=${vercelBranchAlias(branch, `\${${VERCEL_ALIAS_VARIABLE}}`)}"`,
        );
        requiredByBranch[branch]!.push(['ui', VERCEL_ALIAS_VARIABLE]);
      }
    }

    /*
     * Every variable this branch needs, not just the first one.
     *
     * These used to be one `case` arm per variable, which put two `uat)`
     * labels in the same statement for a repository that has both an API and
     * a UI suite - and a `case` stops at the first match, so the second
     * variable was never checked at all.
     */
    const cases = (['uat', 'main'] as const).flatMap((branch) => {
      const required = requiredByBranch[branch] ?? [];
      if (required.length === 0) {
        return [];
      }
      return [
        `  ${branch})`,
        ...required.map(
          ([kind, variable]) => `    require ${kind} "${variable}"`,
        ),
        '    ;;',
      ];
    });

    lines.push(
      '} >> "$GITHUB_OUTPUT"',
      '',
      '# A missing address is neither a failure of the code nor of this job:',
      '# nothing was deployed there, so there is nothing to test. It is recorded',
      '# per kind of suite so those jobs skip, and skip-reason lets the stage say',
      '# WHY it tested nothing instead of failing a suite aimed at no address.',
      'missing=""',
      'require() {',
      // Indirect expansion: $2 is the variable NAME, so ${!2} is its value.
      // `:-` keeps `set -u` from treating an unset one as a fatal error,
      // because an unset variable is exactly what this function reports on.
      '  value="${!2:-}"',
      '  if [ -z "${value}" ]; then',
      '    missing="${missing:+${missing}, }$2"',
      '    echo "$1-skipped=true" >> "$GITHUB_OUTPUT"',
      '    echo "  $2 is not set"',
      '  else',
      '    echo "  $2=${value}"',
      '  fi',
      '}',
      '',
      '# A dev run tests no deployed service, so demanding the uat address',
      '# there would fail a branch that was never going to use it.',
      'echo "Resolving deployment targets for ${BRANCH}"',
      'case "${BRANCH}" in',
      ...cases,
      '  *)',
      '    echo "Branch ${BRANCH} runs no tests against a deployed environment."',
      '    exit 0',
      '    ;;',
      'esac',
      '',
      'if [ -n "${missing}" ]; then',
      '  case "${missing}" in *,*) verb="are" ;; *) verb="is" ;; esac',
      '  # Variables, not secrets: public addresses that ALPHACI installs when the',
      '  # deployment target is provisioned. Missing means this project was never',
      '  # given hosting, or the variable was removed.',
      '  echo "skip-reason=Nothing was deployed for ${BRANCH}: ${missing} ${verb} not set - provision hosting in ALPHACI." >> "$GITHUB_OUTPUT"',
      'fi',
    );

    return {
      needs: [VALIDATE_ACCESS_JOB_ID],
      'runs-on': 'ubuntu-latest',
      outputs,
      steps: [
        {
          name: 'Resolve deployment targets',
          id: 'resolve',
          env,
          run: lines.join('\n'),
        },
      ],
    };
  };

  const verifyJobs: Record<string, unknown> = {
    [RESOLVE_TARGETS_JOB_ID]: resolveTargetsJob(),
    ...(verification.api && {
      'api-tests-uat': apiTestJob('uat'),
      'api-tests-main': apiTestJob('main'),
      'contract-tests-uat': contractTestJob(),
    }),
    ...(verification.ui && {
      'ui-tests-uat': uiTestJob('uat'),
      'ui-tests-main': uiTestJob('main'),
    }),
  };

  // The resolver is plumbing, not work. Counting it as work would make a dev
  // run - where every test job is branch-scoped out - report a successful
  // verify stage that tested nothing. It IS in report-results' `needs`
  // though, because STAGE_FAILED only reads the jobs the report waits for:
  // left out, a resolver failure reached nobody (six runs, no reports, and the
  // product said "Not run").
  const workJobIds = Object.keys(verifyJobs).filter(
    (jobId) => jobId !== RESOLVE_TARGETS_JOB_ID,
  );
  return {
    stage: 'verify',
    name: verifyName,
    path: `.github/workflows/30-alphaci-verify${fileSuffix}.yml`,
    gated: true,
    yaml: dumpWorkflow({
      name: verifyName,
      'run-name': INHERITED_RUN_NAME,
      on: {
        workflow_run: {
          workflows: [packageName],
          types: ['completed'],
        },
        workflow_dispatch: {},
      },
      permissions: {
        contents: 'read',
      },
      env: {
        ALPHACI_VALIDATE_URL,
        ALPHACI_REPORT_URL: '${{ secrets.ALPHACI_REPORT_URL }}',
      },
      jobs: withPipelineContext({
        [UPSTREAM_WORK_JOB_ID]: upstreamWorkCheckJob(),
        'validate-access': {
          needs: [UPSTREAM_WORK_JOB_ID],
          if: CHAINED_STAGE_GATE,
          ...validationJob('verify'),
        },
        ...verifyJobs,
        'report-results': reportingJob(
          'verify',
          [VALIDATE_ACCESS_JOB_ID, RESOLVE_TARGETS_JOB_ID, ...workJobIds],
          {
            /*
             * When no suite could run because nothing was deployed, the stage is
             * reported as skipped with the reason resolve-targets gave, rather
             * than reporting nothing (which reads as stalled) or failing.
             */
            skipReasonJobId: RESOLVE_TARGETS_JOB_ID,
            /*
             * Only the test jobs count as work. Every one is branch-scoped, so
             * some always skip — and on dev they all do, which is what makes
             * the stage report nothing there rather than a success it did not
             * earn.
             */
            workJobIds,
            /*
             * Named only when this stack has a browser suite. A stack with no
             * UI has no such jobs, and reading outputs off a job that is not
             * in `needs` evaluates to empty — which would post a count of
             * nothing as though it were a count of zero.
             */
            ...(verification.ui
              ? { uiTestJobIds: ['ui-tests-uat', 'ui-tests-main'] }
              : {}),
          },
        ),
      }),
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
      'run-name': INHERITED_RUN_NAME,
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
      jobs: withPipelineContext({
        [UPSTREAM_WORK_JOB_ID]: upstreamWorkCheckJob(),
        'validate-access': {
          needs: [UPSTREAM_WORK_JOB_ID],
          if: CHAINED_STAGE_GATE,
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
          ctx.siblingRepoFullName,
        ),
        'promote-to-main': promotionJob(
          'uat-to-main',
          'uat',
          ctx.serviceName,
          ctx.centralWorkflowRef,
          deploymentPlan.promotionNeeds.uat,
          ctx.siblingRepoFullName,
        ),
        'report-results': reportingJob(
          'package',
          [
            'validate-access',
            'build',
            'production-gate',
            ...deploymentPlan.jobIds,
            /*
             * The promotion jobs, so the report goes out AFTER them.
             *
             * It did not wait: report-results needed only the build and deploy
             * jobs, ran as soon as those finished and posted `success` while the
             * promotion PR was still being created. When that failed
             * (logistics2cicd-fe run 37031776199, `Create Promotion PR`) GitHub
             * said failure and ALPHACI kept a success. The report job is
             * `always()`, so a failed or skipped promotion cannot hold it back,
             * and STAGE_FAILED and the per-job checks now see the result.
             */
            'promote-to-uat',
            'promote-to-main',
          ],
          {
            // The deploy jobs are branch-scoped and skip by design, so `build`
            // alone decides whether this stage packaged anything.
            workJobIds: ['build'],
          },
        ),
      }),
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
  if (dto.environments?.length) {
    return buildEnvironmentWorkflowBundle(
      ctx,
      toolchain,
      dto,
      workflowFragmentRegistry,
    );
  }
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

  /*
   * Verify needs BOTH an API suite and somewhere it is deployed.
   *
   * Its subject is a running service, not a commit. A repository with no
   * deployment target has no URL to point a suite at, and emitting the stage
   * anyway would report the absence of an environment as a failure of the
   * code — the same confusion as testing through a deploy that has not
   * finished starting.
   *
   * The stack has to supply a suite too, of either kind. These jobs fail when
   * the collection or the specs directory is missing, deliberately, so
   * emitting the stage for a stack whose scaffold ships neither turns every
   * one of its pipelines red at the last stage.
   *
   * Which kind follows the stack, not the provider: an API is checked by
   * sending requests and reading JSON, a bundle on a CDN by driving a browser.
   * A stack may declare both, and a full-stack repository in one slot would.
   */
  if (
    (toolchain.apiVerification || toolchain.uiVerification) &&
    deploymentPlan.jobIds.length > 0
  ) {
    files.push(
      buildVerifyWorkflowFile(ctx, {
        api: toolchain.apiVerification,
        ui: toolchain.uiVerification,
      }),
    );
  }

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
/**
 * The pipeline for a project with configured environments.
 *
 * Access and quality run on every environment's source branch. The package
 * stage builds and deploys only the FIRST environment, on a push to its
 * branch: it builds each container image once, registers an immutable release
 * with AlphaCI, has it signed, and deploys that release to the first
 * environment's targets. A push to any later environment's branch runs the
 * checks and stops. Later environments receive a release only when AlphaCI
 * dispatches the promotion workflow after a signed-in promotion, which deploys
 * the release's pinned commit and image digests to that environment's own
 * targets. There is no branch-to-target inference anywhere: every deploy job
 * names its environment ID, GitHub Environment, and target ID.
 */
function buildEnvironmentWorkflowBundle(
  ctx: StagedWorkflowContext,
  toolchain: ToolchainFragmentResult,
  dto: StagedWorkflowOptions,
  registry: WorkflowFragmentRegistry | undefined,
): StagedWorkflowBundle {
  if (!registry) {
    throw new Error(
      'Environment pipelines need the workflow fragment registry.',
    );
  }
  const environments = orderedEnvironments(dto.environments ?? []);
  const targets = dto.environmentTargets ?? [];
  for (const target of targets) {
    if (!environments.some(({ id }) => id === target.environmentId)) {
      throw new Error(
        'Deployment target ' +
          target.targetId +
          ' names an unknown environment.',
      );
    }
  }

  const files: StagedWorkflowFile[] = [
    buildAccessWorkflowFile(ctx),
    buildQualityWorkflowFile(ctx, toolchain),
    buildEnvironmentPackageWorkflowFile(
      ctx,
      toolchain,
      registry,
      environments,
      targets,
    ),
  ];
  if (dto.workflowVariant !== 'frontend') {
    files.push(buildPromoteWorkflowFile(ctx, registry, environments, targets));
    files.push(buildEnvGuardWorkflowFile(ctx.branches));
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

/** A deploy job for one environment target, built by its provider's fragment. */
function environmentDeployJob(
  ctx: StagedWorkflowContext,
  registry: WorkflowFragmentRegistry,
  environment: StagedWorkflowEnvironment,
  target: StagedEnvironmentTarget,
  input: {
    needs: string[];
    if: string;
    commitSha: string;
    artifact: string | undefined;
  },
) {
  return registry.environmentDeployJob(
    target.provider,
    {
      environment,
      targetId: target.targetId,
      ...input,
    },
    {
      serviceName: ctx.serviceName,
      servicePath: ctx.servicePath,
      centralWorkflowRef: ctx.centralWorkflowRef,
    },
  );
}

const imageJobId = (slot: string) => 'image-' + slot;
const releaseImageOutput = (slot: string) => 'image-' + slot;

/**
 * Slots whose target, in any environment, runs a container image built by
 * this pipeline. A later environment can need an image the first one does
 * not: a frontend on Vercel in test and on an on-prem host in production is
 * built from source in test and pulled by digest in production.
 */
function containerSlots(
  registry: WorkflowFragmentRegistry,
  targets: StagedEnvironmentTarget[],
): string[] {
  return [
    ...new Set(
      targets
        .filter(({ provider }) => registry.deploysBuiltImage(provider))
        .map(({ slot }) => slot),
    ),
  ];
}

/** The image reference a target deploys, if its provider deploys one. */
function targetArtifact(
  registry: WorkflowFragmentRegistry,
  target: StagedEnvironmentTarget,
  slots: string[],
  reference: (slot: string) => string,
): string | undefined {
  return registry.deploysBuiltImage(target.provider) &&
    slots.includes(target.slot)
    ? reference(target.slot)
    : undefined;
}

const CI_REQUEST_HEADERS = [
  '-H "Authorization: Bearer $ALPHACI_TOKEN"',
  '-H "Content-Type: application/json"',
].join(' ');

function buildEnvironmentPackageWorkflowFile(
  ctx: StagedWorkflowContext,
  toolchain: ToolchainFragmentResult,
  registry: WorkflowFragmentRegistry,
  environments: StagedWorkflowEnvironment[],
  targets: StagedEnvironmentTarget[],
): StagedWorkflowFile {
  const { packageName, qualityName, fileSuffix } = ctx.names;
  const first = environments[0]!;
  const firstTargets = targets.filter(
    ({ environmentId }) => environmentId === first.id,
  );
  const onFirstBranch = branchIsOneOf([first.sourceBranch]);
  // A release carries only slots the first environment has a target for.
  const slots = containerSlots(registry, targets).filter((slot) =>
    firstTargets.some((target) => target.slot === slot),
  );
  // An on-prem first environment is deployed and reported by its host.
  const hostDelivered =
    firstTargets.length > 0 &&
    firstTargets.every(({ provider }) => registry.deliveredByHost(provider));
  const imageJobs = Object.fromEntries(
    slots.map((slot) => [
      imageJobId(slot),
      {
        needs: ['build'],
        if: onFirstBranch,
        // docker-build's scan job uploads SARIF; a reusable workflow that
        // asks for more than its caller grants fails at startup.
        permissions: {
          contents: 'read',
          packages: 'write',
          'security-events': 'write',
        },
        uses: `${CENTRAL_WORKFLOW_BASE}/docker-build.yml@${ctx.centralWorkflowRef}`,
        with: {
          'working-directory': ctx.servicePath,
          'image-name': ctx.serviceName + '-' + slot,
          'push-image': true,
          'checkout-ref': HEAD_SHA_EXPR,
          'pipeline-branch': first.sourceBranch,
        },
        secrets: 'inherit',
      },
    ]),
  );
  const imageEnv = Object.fromEntries(
    slots.map((slot) => [
      'IMAGE_' + slot.toUpperCase(),
      `\${{ needs.${imageJobId(slot)}.outputs.image-ref }}`,
    ]),
  );
  const artifactsProgram =
    '[' +
    slots
      .map(
        (slot) => `{slot:"${slot}",reference:env.IMAGE_${slot.toUpperCase()}}`,
      )
      .join(',') +
    ']';

  const deployJobs = Object.fromEntries(
    firstTargets
      .filter(({ provider }) => !registry.deliveredByHost(provider))
      .map((target) => {
        const artifact = targetArtifact(
          registry,
          target,
          slots,
          (slot) => `\${{ needs.${imageJobId(slot)}.outputs.image-ref }}`,
        );
        return [
          'deploy-' + first.slug + '-' + target.slot,
          environmentDeployJob(ctx, registry, first, target, {
            needs: [
              'register-release',
              ...(artifact ? [imageJobId(target.slot)] : []),
            ],
            if: onFirstBranch,
            commitSha: HEAD_SHA_EXPR,
            artifact,
          }),
        ];
      }),
  );
  const deployJobIds = Object.keys(deployJobs);

  return {
    stage: 'package',
    name: packageName,
    path: `.github/workflows/20-alphaci-package${fileSuffix}.yml`,
    gated: true,
    yaml: dumpWorkflow({
      name: packageName,
      'run-name': INHERITED_RUN_NAME,
      on: {
        workflow_run: { workflows: [qualityName], types: ['completed'] },
        workflow_dispatch: {},
      },
      permissions: { contents: 'read', packages: 'write' },
      env: {
        ALPHACI_VALIDATE_URL,
        ALPHACI_REPORT_URL: '${{ secrets.ALPHACI_REPORT_URL }}',
      },
      jobs: withPipelineContext({
        [UPSTREAM_WORK_JOB_ID]: upstreamWorkCheckJob(),
        'validate-access': {
          needs: [UPSTREAM_WORK_JOB_ID],
          if: CHAINED_STAGE_GATE,
          ...validationJob('package'),
        },
        build: toolchain.packageBuildJob,
        ...imageJobs,
        'register-release': {
          needs: ['build', ...Object.keys(imageJobs)],
          if: onFirstBranch,
          runs_on: 'ubuntu-latest',
          outputs: { 'release-id': '${{ steps.register.outputs.release-id }}' },
          steps: [
            {
              name: 'Register the release with AlphaCI',
              id: 'register',
              env: {
                ALPHACI_TOKEN: '${{ secrets.ALPHACI_TOKEN }}',
                ALPHACI_API_URL,
                HEAD_SHA: HEAD_SHA_EXPR,
                SOURCE_ENVIRONMENT_ID: first.id,
                SOURCE_BRANCH: first.sourceBranch,
                ...imageEnv,
              },
              run: [
                'set -euo pipefail',
                `ARTIFACTS=$(jq -n '${artifactsProgram}')`,
                'BODY=$(jq -n --arg repo "$GITHUB_REPOSITORY" --arg env "$SOURCE_ENVIRONMENT_ID" --arg branch "$SOURCE_BRANCH" --arg sha "$HEAD_SHA" --arg run "$GITHUB_RUN_ID" --arg url "$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID" --argjson artifacts "$ARTIFACTS" \'{repoFullName:$repo, sourceEnvironmentId:$env, sourceBranch:$branch, commitSha:$sha, artifacts:$artifacts, workflowRun:{provider:"github_actions", repo:$repo, runId:$run, url:$url}}\')',
                `RESPONSE=$(curl -sf --max-time 30 -X POST "$ALPHACI_API_URL/api/v1/ci/releases" ${CI_REQUEST_HEADERS} -d "$BODY")`,
                "RELEASE_ID=$(printf '%s' \"$RESPONSE\" | jq -r '.releaseId')",
                ...(hostDelivered
                  ? []
                  : [
                      `curl -sf --max-time 30 -X POST "$ALPHACI_API_URL/api/v1/ci/releases/$RELEASE_ID/deployment-status" ${CI_REQUEST_HEADERS} -d "$(jq -n --arg repo "$GITHUB_REPOSITORY" '{repoFullName:$repo,status:"deploying"}')"`,
                    ]),
                'echo "release-id=$RELEASE_ID" >> "$GITHUB_OUTPUT"',
              ].join('\n'),
            },
          ],
        },
        'sign-release': {
          needs: ['register-release'],
          // Keyless Cloud KMS signing exchanges the job's OIDC token.
          permissions: { contents: 'read', 'id-token': 'write' },
          uses: `${CENTRAL_WORKFLOW_BASE}/sign-release.yml@${ctx.centralWorkflowRef}`,
          with: {
            'release-id': '${{ needs.register-release.outputs.release-id }}',
            'api-url': ALPHACI_API_URL,
          },
          // Named, not `inherit`: inheriting only works between repositories
          // of one organization, and the central workflows live in another.
          secrets: {
            ALPHACI_TOKEN: '${{ secrets.ALPHACI_TOKEN }}',
            ALPHACI_RELEASE_SIGNING_KEY:
              '${{ secrets.ALPHACI_RELEASE_SIGNING_KEY }}',
          },
        },
        ...deployJobs,
        ...(hostDelivered
          ? {
              'report-signing-failure': {
                needs: ['register-release', 'sign-release'],
                if: "${{ always() && needs.register-release.result == 'success' && needs.sign-release.result != 'success' }}",
                runs_on: 'ubuntu-latest',
                steps: [
                  {
                    name: 'Clear the unsigned host deployment after signing fails',
                    env: {
                      ALPHACI_TOKEN: '${{ secrets.ALPHACI_TOKEN }}',
                      ALPHACI_API_URL,
                      RELEASE_ID:
                        '${{ needs.register-release.outputs.release-id }}',
                    },
                    run: [
                      'set -euo pipefail',
                      `curl -sf --max-time 30 -X POST "$ALPHACI_API_URL/api/v1/ci/releases/$RELEASE_ID/deployment-status" ${CI_REQUEST_HEADERS} -d "$(jq -n --arg repo "$GITHUB_REPOSITORY" '{repoFullName:$repo,status:"failed",detail:"Release signing failed or was cancelled before host delivery."}')"`,
                    ].join('\n'),
                  },
                ],
              },
            }
          : {
              'report-deployment': {
                needs: ['register-release', ...deployJobIds],
                if: "${{ always() && needs.register-release.result == 'success' }}",
                runs_on: 'ubuntu-latest',
                steps: [
                  {
                    name: 'Report the first environment deployment',
                    env: {
                      ALPHACI_TOKEN: '${{ secrets.ALPHACI_TOKEN }}',
                      ALPHACI_API_URL,
                      RELEASE_ID:
                        '${{ needs.register-release.outputs.release-id }}',
                      RESULTS: "${{ join(needs.*.result, ' ') }}",
                    },
                    run: [
                      'set -euo pipefail',
                      'STATUS=healthy',
                      'for RESULT in $RESULTS; do [ "$RESULT" = success ] || STATUS=failed; done',
                      `curl -sf --max-time 30 -X POST "$ALPHACI_API_URL/api/v1/ci/releases/$RELEASE_ID/deployment-status" ${CI_REQUEST_HEADERS} -d "$(jq -n --arg repo "$GITHUB_REPOSITORY" --arg status "$STATUS" '{repoFullName:$repo,status:$status}')"`,
                      '[ "$STATUS" = healthy ]',
                    ].join('\n'),
                  },
                ],
              },
            }),
        'report-results': reportingJob(
          'package',
          [
            'validate-access',
            'build',
            'register-release',
            'sign-release',
            ...deployJobIds,
          ],
          { workJobIds: ['build'] },
        ),
      }),
    }),
  };
}

/**
 * Deploys a registered release to one later environment. AlphaCI dispatches
 * it after a promotion; the inputs name the release, the deployment record,
 * and the destination environment. The commit and image digests come from
 * the release itself, so nothing is rebuilt for a container target.
 */
function buildPromoteWorkflowFile(
  ctx: StagedWorkflowContext,
  registry: WorkflowFragmentRegistry,
  environments: StagedWorkflowEnvironment[],
  targets: StagedEnvironmentTarget[],
): StagedWorkflowFile {
  const slots = containerSlots(registry, targets);
  // A host-delivered environment is never dispatched; its host pulls instead.
  const workflowTargets = targets.filter(
    ({ provider }) => !registry.deliveredByHost(provider),
  );
  const later = environments
    .slice(1)
    .filter(({ id }) =>
      workflowTargets.some(({ environmentId }) => environmentId === id),
    );
  const deployJobs = Object.fromEntries(
    later.flatMap((environment) =>
      workflowTargets
        .filter(({ environmentId }) => environmentId === environment.id)
        .map((target) => [
          'deploy-' + environment.slug + '-' + target.slot,
          environmentDeployJob(ctx, registry, environment, target, {
            needs: ['release'],
            if: `\${{ inputs.environment-id == '${environment.id}' }}`,
            commitSha: '${{ needs.release.outputs.commit-sha }}',
            artifact: targetArtifact(
              registry,
              target,
              slots,
              (slot) =>
                `\${{ needs.release.outputs.${releaseImageOutput(slot)} }}`,
            ),
          }),
        ]),
    ),
  );
  const knownEnvironments = later.map(({ id }) => id).join(' ');

  return {
    stage: 'promote',
    name: PROMOTE_WORKFLOW_NAME,
    path: '.github/workflows/' + PROMOTE_WORKFLOW_FILE,
    gated: false,
    yaml: dumpWorkflow({
      name: PROMOTE_WORKFLOW_NAME,
      'run-name': 'Promote ${{ inputs.release-id }}',
      on: {
        workflow_dispatch: {
          inputs: {
            'release-id': { required: true, type: 'string' },
            'deployment-id': { required: true, type: 'string' },
            'environment-id': { required: true, type: 'string' },
          },
        },
      },
      permissions: { contents: 'read' },
      concurrency: {
        group: 'alphaci-promote-${{ inputs.environment-id }}',
        'cancel-in-progress': false,
      },
      jobs: {
        release: {
          runs_on: 'ubuntu-latest',
          outputs: {
            'commit-sha': '${{ steps.release.outputs.commit-sha }}',
            ...Object.fromEntries(
              slots.map((slot) => [
                releaseImageOutput(slot),
                `\${{ steps.release.outputs.${releaseImageOutput(slot)} }}`,
              ]),
            ),
          },
          steps: [
            {
              name: 'Read the release and start the deployment',
              id: 'release',
              env: {
                ALPHACI_TOKEN: '${{ secrets.ALPHACI_TOKEN }}',
                ALPHACI_API_URL,
                RELEASE_ID: '${{ inputs.release-id }}',
                DEPLOYMENT_ID: '${{ inputs.deployment-id }}',
                ENVIRONMENT_ID: '${{ inputs.environment-id }}',
                KNOWN_ENVIRONMENTS: knownEnvironments,
                EXPECTED_TARGETS: JSON.stringify(
                  Object.fromEntries(
                    later.map(({ id }) => [
                      id,
                      workflowTargets
                        .filter(({ environmentId }) => environmentId === id)
                        .map(({ targetId }) => targetId)
                        .sort(),
                    ]),
                  ),
                ),
              },
              run: [
                'set -euo pipefail',
                'case " $KNOWN_ENVIRONMENTS " in *" $ENVIRONMENT_ID "*) ;; *) echo "::error::Unknown environment $ENVIRONMENT_ID"; exit 1 ;; esac',
                'RELEASE=$(curl -sf --max-time 30 -G "$ALPHACI_API_URL/api/v1/ci/releases/$RELEASE_ID" --data-urlencode "repo=$GITHUB_REPOSITORY" -H "Authorization: Bearer $ALPHACI_TOKEN")',
                'printf \'%s\' "$RELEASE" | jq -e --arg deployment "$DEPLOYMENT_ID" --arg environment "$ENVIRONMENT_ID" --argjson expected "$EXPECTED_TARGETS" \'.deployments[] | select(.id == $deployment and .environmentId == $environment and .delivery == "workflow") | (.targetIds | sort) == ($expected[$environment] | sort)\' >/dev/null || { echo "::error::Deployment targets changed; regenerate this project workflow before promoting."; exit 1; }',
                'echo "commit-sha=$(printf \'%s\' "$RELEASE" | jq -r \'.commitSha\')" >> "$GITHUB_OUTPUT"',
                ...slots.map(
                  (slot) =>
                    `echo "${releaseImageOutput(slot)}=$(printf '%s' "$RELEASE" | jq -r '.artifacts[] | select(.slot == "${slot}") | .image + "@" + .digest')" >> "$GITHUB_OUTPUT"`,
                ),
                `curl -sf --max-time 30 -X POST "$ALPHACI_API_URL/api/v1/ci/deployments/$DEPLOYMENT_ID/status" ${CI_REQUEST_HEADERS} -d "$(jq -n --arg repo "$GITHUB_REPOSITORY" '{repoFullName:$repo,status:"deploying"}')"`,
              ].join('\n'),
            },
          ],
        },
        ...deployJobs,
        'report-deployment': {
          needs: ['release', ...Object.keys(deployJobs)],
          if: '${{ always() }}',
          runs_on: 'ubuntu-latest',
          steps: [
            {
              name: 'Report the promoted deployment',
              env: {
                ALPHACI_TOKEN: '${{ secrets.ALPHACI_TOKEN }}',
                ALPHACI_API_URL,
                DEPLOYMENT_ID: '${{ inputs.deployment-id }}',
                RESULTS: "${{ join(needs.*.result, ' ') }}",
              },
              run: [
                'set -euo pipefail',
                'STATUS=healthy',
                'for RESULT in $RESULTS; do case "$RESULT" in success|skipped) ;; *) STATUS=failed ;; esac; done',
                `curl -sf --max-time 30 -X POST "$ALPHACI_API_URL/api/v1/ci/deployments/$DEPLOYMENT_ID/status" ${CI_REQUEST_HEADERS} -d "$(jq -n --arg repo "$GITHUB_REPOSITORY" --arg status "$STATUS" '{repoFullName:$repo,status:$status}')"`,
                '[ "$STATUS" = healthy ]',
              ].join('\n'),
            },
          ],
        },
      },
    }),
  };
}

export function buildEnvGuardWorkflowFile(
  branches: readonly string[] = PIPELINE_BRANCHES,
): StagedWorkflowFile {
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
        push: { branches: [...branches] },
        pull_request: { branches: [...branches] },
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

/*
 * Did the stage this one follows actually do anything?
 *
 * `workflow_run.conclusion` cannot answer that. A workflow whose jobs ALL
 * skipped concludes `success`, because skipped is not failed - so a stage
 * whose own gate was closed hands the next stage a green light. Observed:
 * quality failed, every job in the build stage skipped, the run concluded
 * success, and the post-deploy stage opened its gate and began testing a
 * commit that had never been deployed. Nothing bad happened only because a
 * missing variable stopped it; with that variable set, the suite would have
 * run against a stale deployment, passed, and recorded a green stage for a
 * commit that was never shipped.
 *
 * The answer lives in the previous run's JOBS, so this asks for them. The
 * reporting job is excluded because it carries `if: always()` and therefore
 * runs even when the whole stage skipped - counting it would make every
 * skipped stage look like it had worked.
 *
 * This job never fails. It publishes a fact, and the gate below consumes it,
 * so a stage with no work to build on SKIPS rather than turning red. A red
 * stage here would blame the wrong one: the fault is upstream, and the
 * platform already renders a stage that reported nothing as blocked, naming
 * the stage that stopped it.
 */
function upstreamWorkCheckJob() {
  return {
    runs_on: 'ubuntu-latest',
    permissions: {
      contents: 'read',
      actions: 'read',
    },
    outputs: {
      ran: '${{ steps.check.outputs.ran }}',
    },
    steps: [
      {
        name: 'Check the previous stage did its work',
        id: 'check',
        env: {
          GH_TOKEN: '${{ github.token }}',
          GH_REPO: '${{ github.repository }}',
          PREVIOUS_RUN_ID: '${{ github.event.workflow_run.id }}',
          PREVIOUS_NAME: '${{ github.event.workflow_run.name }}',
          EVENT_NAME: '${{ github.event_name }}',
        },
        run: [
          'set -euo pipefail',
          '',
          '# A manual run has no previous stage to inspect and is always allowed.',
          'if [ "$EVENT_NAME" != "workflow_run" ]; then',
          '  echo "ran=true" >> "$GITHUB_OUTPUT"',
          '  exit 0',
          'fi',
          '',
          'JOBS=$(curl -sf --max-time 10 \\',
          '  -H "Authorization: Bearer $GH_TOKEN" \\',
          '  -H "Accept: application/vnd.github+json" \\',
          '  "https://api.github.com/repos/$GH_REPO/actions/runs/$PREVIOUS_RUN_ID/jobs?filter=latest" \\',
          '  || printf \'{"jobs":[]}\')',
          '',
          '# An unreachable API is not evidence of a skipped stage. Letting the stage',
          '# through on a failed lookup keeps a GitHub outage from silently halting',
          '# every pipeline.',
          "TOTAL=$(printf '%s' \"$JOBS\" | jq '[.jobs[]?] | length')",
          'if [ "$TOTAL" -eq 0 ]; then',
          '  echo "::warning::Could not read the jobs of $PREVIOUS_NAME, so this stage proceeds without checking whether it did any work."',
          '  echo "ran=true" >> "$GITHUB_OUTPUT"',
          '  exit 0',
          'fi',
          '',
          'WORKED=$(printf \'%s\' "$JOBS" | jq \'[.jobs[]? | select(.name != "report-results") | select(.conclusion != "skipped")] | length\')',
          '',
          'if [ "$WORKED" -eq 0 ]; then',
          '  echo "::warning::$PREVIOUS_NAME completed without running any of its jobs, so this stage has nothing to act on and will skip. Its gate was closed, which usually means the stage before IT did not pass - fix that one."',
          '  echo "ran=false" >> "$GITHUB_OUTPUT"',
          '  exit 0',
          'fi',
          '',
          'echo "$PREVIOUS_NAME ran $WORKED job(s)."',
          'echo "ran=true" >> "$GITHUB_OUTPUT"',
        ].join('\n'),
      },
    ],
  };
}

/**
 * Puts the context job in front of a chained stage and makes every other job
 * wait for it.
 *
 * Applied to the whole job map rather than written out per job, because the
 * cost of forgetting it on one job is silent: that job reads an empty branch,
 * its `if` selects nothing, and the stage reports success having skipped the
 * work. A job added later inherits the wiring for free.
 */
function withPipelineContext(
  jobs: Record<string, unknown>,
): Record<string, unknown> {
  const wired = Object.fromEntries(
    Object.entries(jobs).map(([jobId, job]) => {
      const definition = job as { needs?: string[] | string };
      const existing =
        definition.needs === undefined
          ? []
          : Array.isArray(definition.needs)
            ? definition.needs
            : [definition.needs];

      return [
        jobId,
        {
          ...(definition as Record<string, unknown>),
          needs: [PIPELINE_CONTEXT_JOB_ID, ...existing],
        },
      ];
    }),
  );

  return { [PIPELINE_CONTEXT_JOB_ID]: pipelineContextJob(), ...wired };
}

/*
 * The chained stages carry NO `concurrency` block, and that is the fix rather
 * than an omission.
 *
 * They had one. It was added to stop two package runs racing on the buildx
 * cache, and it keyed the group on the repository alone - the only thing
 * available, because `concurrency` is evaluated before any job runs and so
 * cannot read `pipeline-context`. That put dev, uat and main in ONE group, and
 * GitHub keeps a single pending run per group: every new arrival cancels the
 * one queued behind it. On testsandbox-fe, with every other fix in place, dev
 * and uat recorded an access report and nothing else - their quality runs were
 * cancelled, five of seven, while main's went through.
 *
 * A cancelled pipeline reports nothing at all, which is strictly worse than
 * the cache collision it was guarding: that fails one run, loudly, with the
 * reason in the log.
 *
 * The collision is also mostly gone on its own. The cache scope is derived
 * from the image name, which carries the branch - `alphaci-backend-main-…`
 * against `alphaci-backend-dev-…` - so once a stage resolves its branch
 * correctly the scopes differ and cross-branch runs cannot contend. What
 * remains is two runs of the SAME branch, which happens because a push and a
 * pull_request both fire the chain; that is a duplicate-trigger problem and
 * belongs where the triggers are, not in a group key that cannot see the
 * branch.
 */

function validationJob(stage: WorkflowStage) {
  /*
   * The commit reported to the platform must be the one that was pushed. On a
   * chained stage the event's head_sha is the DEFAULT branch's commit, so
   * reporting it filed every dev and uat run against main.
   */
  const shaExpr =
    stage === 'access'
      ? '${{ github.sha }}'
      : `\${{ needs.${PIPELINE_CONTEXT_JOB_ID}.outputs.sha }}`;
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
            '\\",\\"workflowRunId\\":\\"${{ github.run_id }}\\",\\"headSha\\":\\"' +
            shaExpr +
            '\\"}" \\',
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

function isHostedBranch(value: string | undefined): value is DeployBranch {
  return (HOSTED_BRANCHES as readonly string[]).includes(value ?? '');
}

/**
 * Which branches a deployment target produces jobs for.
 *
 * A target that names a branch deploys that one; a branch-neutral target - a
 * Vercel project serves every branch from one project - fans out across the
 * hosted tiers.
 *
 * Hosted rather than every pipeline branch, so a target cannot ask for a dev
 * deployment. dev is local: it builds and runs the full quality stage, and
 * there is nothing to deploy it to. A target naming it produces no jobs at
 * all rather than jobs pointed at a service that does not exist.
 */
function resolveDeploymentBranches(
  branchName: string | undefined,
): DeployBranch[] {
  if (isHostedBranch(branchName)) {
    return [branchName];
  }

  return branchName === undefined ? [...HOSTED_BRANCHES] : [];
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
  siblingRepoFullName?: string,
) {
  const needs = ['build', ...additionalNeeds];
  const conditions = [
    '!cancelled()',
    `(${BRANCH_EXPR}) == '${sourceBranch}'`,
    "needs.build.result == 'success'",
    /*
     * `success`, not `success || skipped`.
     *
     * These jobs are branch-scoped to the branch being promoted FROM, and the
     * promotion only runs on that branch, so on a real run they are active. A
     * skipped one therefore does not mean "not applicable here" - it means
     * something upstream of it failed and it never ran. Accepting that opened
     * a promotion PR for a commit whose deployment never happened, which is
     * the same mistake as treating a stage whose jobs all skipped as a stage
     * that succeeded. A provider with no job for this branch is absent from
     * `needs` entirely and never reaches this line.
     */
    ...additionalNeeds.map((need) => `needs['${need}'].result == 'success'`),
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
      // Omitted entirely (not sent as "") when there is no sibling, so a
      // single-repo pipeline's generated YAML is byte-for-byte unchanged.
      ...(siblingRepoFullName !== undefined && {
        'sibling-repo': siblingRepoFullName,
      }),
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
  opts?: {
    testJobId?: string;
    workJobIds?: string[];
    /**
     * The browser-suite jobs, whose counts the verify stage reports.
     *
     * A list rather than one id because uat and main each have their own job
     * and only the branch's own runs; the other is skipped and publishes
     * nothing, so the script takes whichever answered.
     */
    uiTestJobIds?: string[];
    /**
     * A job whose `skip-reason` output explains why the stage's work was left
     * out on purpose (verify: nothing was deployed). When the work did not run
     * and this output is non-empty, the stage is reported as skipped with it.
     */
    skipReasonJobId?: string;
  },
) {
  // Only the chained stages have a context job to read from.
  const chained = stage !== 'access';
  const isQuality = stage === 'quality';
  const testJobId = opts?.testJobId;
  const uiTestJobIds = opts?.uiTestJobIds ?? [];
  const skipReasonJobId = opts?.skipReasonJobId;

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
    GH_BRANCH: `\${{ ${chained ? BRANCH_EXPR : DIRECT_BRANCH_EXPR} }}`,
    GH_SHA: chained ? HEAD_SHA_EXPR : DIRECT_SHA_EXPR,
    GH_RUN_ID: '${{ github.run_id }}',
    GITHUB_TOKEN: '${{ github.token }}',
    /*
     * The commit-status context this stage posts under.
     *
     * A chained stage runs via `workflow_run`, and GitHub does not attach those
     * runs to a pull request as checks — so the stage that runs the tests was
     * invisible to branch protection, which could only require the 5-second
     * `env-guard`. A commit status is the one verdict from a workflow_run chain
     * that protection can see, and it lands on the sha `pipeline-context`
     * resolved, not the branch head GitHub would have guessed.
     */
    STATUS_CONTEXT: `alphaci/${stage}`,
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

  if (skipReasonJobId) {
    stepEnv['SKIP_REASON'] =
      `\${{ needs.${skipReasonJobId}.outputs.skip-reason }}`;
  }

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
    /*
     * Why the analysis could not run, when the cause is a setting.
     *
     * It cannot arrive as an annotation: a workflow-level error is attributed
     * to `.github`, and those are filtered out because the runner's own
     * "Process completed with exit code 1" arrives the same way and says
     * nothing. So the reason travels as an output or not at all.
     */
    stepEnv['SONAR_BLOCKED_BY'] = '${{ needs.sonar.outputs.blocked-by }}';
    stepEnv['SONAR_CONDITIONS'] =
      '${{ needs.sonar.outputs.failed-conditions }}';
    stepEnv['SONAR_MEASURES'] = '${{ needs.sonar.outputs.measures }}';
    /*
     * The most severe issues on new code (rule, file, line, message), so a
     * developer gets the place to fix and not only a count. Empty from a
     * central workflow that does not collect them; the guard leaves it out.
     */
    stepEnv['SONAR_ISSUES'] = '${{ needs.sonar.outputs.issues }}';
  }

  /*
   * The browser suite's counts and failing test names.
   *
   * The verify stage used to publish `results: {}`, so a Playwright run that
   * executed forty tests and failed three reported one word — and the three
   * names existed only inside an uploaded artifact nothing reads. These are
   * the same four outputs a unit-test workflow publishes, so the browser suite
   * arrives through `results.tests` and renders beside every other tool rather
   * than needing a surface of its own.
   *
   * One set per branch job, because only the branch's own job runs and the
   * other is skipped; the script below takes whichever answered.
   */
  uiTestJobIds.forEach((jobId, index) => {
    const slot = String(index);
    stepEnv[`E2E_TOTAL_${slot}`] = `\${{ needs.${jobId}.outputs.tests-total }}`;
    stepEnv[`E2E_PASSED_${slot}`] =
      `\${{ needs.${jobId}.outputs.tests-passed }}`;
    stepEnv[`E2E_FAILED_${slot}`] =
      `\${{ needs.${jobId}.outputs.tests-failed }}`;
    stepEnv[`E2E_FAILURES_${slot}`] =
      `\${{ needs.${jobId}.outputs.tests-failures }}`;
    /*
     * The names of the tests that PASSED, as a one-line JSON array. Passed
     * through env like the other outputs and never interpolated into the
     * script body, so a long list cannot push the generated run block towards
     * GitHub's 21,000-character expression limit: the expression is this one
     * short reference, and the value is read as a shell variable.
     */
    stepEnv[`E2E_PASSES_${slot}`] =
      `\${{ needs.${jobId}.outputs.tests-passes }}`;
    /*
     * Every test with what it checks, its steps and its full error, as a
     * one-line JSON array (failures first, capped by the central workflow).
     * By reference through env for the same 21,000-character reason.
     */
    stepEnv[`E2E_CASES_${slot}`] = `\${{ needs.${jobId}.outputs.tests-cases }}`;
  });

  const scriptLines = [
    "# Put this stage's verdict on the commit, where branch protection can",
    '# require it.',
    '#',
    '# Defined before anything that can exit, and called on every path that',
    '# reaches a verdict, because a REQUIRED status that never arrives leaves a',
    '# pull request pending for ever. Blocking every merge is a worse failure',
    '# than the one this is here to prevent, so the ordering is deliberate.',
    '#',
    '# Never fails the stage. A green pipeline must not turn red because GitHub',
    '# would not take a status, but a silently broken status path is how a gate',
    '# stops gating without anyone noticing - so it warns, loudly, in the log.',
    'post_commit_status() {',
    '  if [ -z "${GH_SHA}" ]; then',
    '    echo "::warning::No commit sha resolved, so no ${STATUS_CONTEXT} status was posted."',
    '    return 0',
    '  fi',
    '  STATUS_PAYLOAD=$(jq -n \\',
    '    --arg state "$1" \\',
    '    --arg description "$2" \\',
    '    --arg context "$STATUS_CONTEXT" \\',
    '    --arg url "https://github.com/${GH_REPO}/actions/runs/${GH_RUN_ID}" \\',
    "    '{state:$state,description:$description,context:$context,target_url:$url}')",
    '  curl -sf --max-time 5 \\',
    '    -X POST "https://api.github.com/repos/${GH_REPO}/statuses/${GH_SHA}" \\',
    '    -H "Authorization: Bearer ${GITHUB_TOKEN}" \\',
    '    -H "Accept: application/vnd.github+json" \\',
    '    -d "$STATUS_PAYLOAD" >/dev/null \\',
    '    || echo "::warning::Could not post the ${STATUS_CONTEXT} status. Branch protection requiring it will hold this commit as pending."',
    '}',
    '',
    '# Derive stage conclusion from upstream needs results',
    'if [ "$STAGE_FAILED" = "true" ]; then',
    '  CONCLUSION="failure"',
    '  post_commit_status "failure" "The ${STATUS_CONTEXT#alphaci/} stage failed."',
    'elif [ "$STAGE_CANCELLED" = "true" ]; then',
    '  CONCLUSION="cancelled"',
    '  post_commit_status "error" "The ${STATUS_CONTEXT#alphaci/} stage was cancelled."',
    ...(skipReasonJobId
      ? [
          'elif [ "$STAGE_WORK_RAN" != "true" ] && [ -n "${SKIP_REASON:-}" ]; then',
          '  # The work was left out ON PURPOSE and the stage knows why: there was',
          '  # nothing deployed to test. Reported with the reason, so the product',
          '  # shows "not run, because..." instead of a stage that stalls.',
          '  #',
          '  # No commit status, for the reason given below: a green status would',
          '  # say this commit cleared a stage that never examined it.',
          '  CONCLUSION="success"',
          '  SKIPPED="true"',
        ]
      : []),
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
    '  # NO STATUS EITHER, deliberately.',
    '  #',
    '  # A green status here would say this commit cleared a stage that never',
    '  # examined it - the same claim as the package rows that recorded a build',
    '  # of nothing as a successful deploy, moved to the one place that decides',
    '  # whether code reaches uat and main.',
    '  #',
    '  # The cost is that only a stage which ALWAYS does work can safely be a',
    '  # required check: require one that skips on some branches and those pull',
    '  # requests wait for a status that is never coming. `quality` runs on',
    '  # every branch and is the one meant to be required; package and verify',
    '  # are branch-scoped and are published for reading, not for gating.',
    '  exit 0',
    'else',
    '  CONCLUSION="success"',
    '  post_commit_status "success" "The ${STATUS_CONTEXT#alphaci/} stage passed."',
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
    '  #',
    '  # `.github` paths ARE kept when the level is failure. Every `::error::` a',
    '  # workflow step prints is attributed to `.github` - "AlphaCI refused the',
    '  # release (HTTP 502)", "Repository variable VERCEL_ALIAS is not set" - and',
    '  # dropping that path dropped the only place the real reason was written.',
    '  # The runner\'s own "Process completed with exit code N" arrives the same',
    '  # way and says nothing, so that one stays filtered (second select).',
    '  #',
    '  # Deduplicated because a solution built more than once (analyze, then',
    '  # sonar) reports the same diagnostic on each pass.',
    '  ANNOTATIONS=$(printf \'%s %s\' "$ANNOTATIONS" "$JOB_ANN" | jq -s -c \'add | map(select(.path and ((.path | startswith(".github") | not) or .annotation_level == "failure"))) | map(select(.message and (.message | test("Process completed with exit code") | not))) | map({path: .path, line: .start_line, level: .annotation_level, title: .title, message: .message}) | unique_by([.path, .line, .message]) | .[0:20]\' || printf \'%s\' "$ANNOTATIONS")',
    'done',
    '',
    '# Build results sub-object (reads from job outputs)',
    'RESULTS="{}"',
    ...(skipReasonJobId
      ? [
          'if [ "${SKIPPED:-}" = "true" ]; then',
          '  RESULTS=$(jq -n -c --arg reason "$SKIP_REASON" \'{skipped:{reason:$reason}}\')',
          'fi',
        ]
      : []),
    ...(uiTestJobIds.length > 0
      ? [
          '',
          '# The browser suite, reported the way every other test job is.',
          '#',
          '# Only one branch job runs, so the first slot carrying a number is',
          '# the one that answered. A suite whose project has not enabled the',
          '# json reporter publishes nothing, and `tests` is left out entirely',
          '# rather than posted as zeros - "no tests failed" and "we could not',
          '# tell" must not look the same.',
          'for slot in ' +
            uiTestJobIds.map((_, index) => String(index)).join(' ') +
            '; do',
          '  eval "e2e_total=\\${E2E_TOTAL_${slot}:-}"',
          '  if ! echo "$e2e_total" | grep -qE \'^[0-9]+$\'; then continue; fi',
          '  if [ "$e2e_total" -eq 0 ]; then continue; fi',
          '  eval "e2e_passed=\\${E2E_PASSED_${slot}:-0}"',
          '  eval "e2e_failed=\\${E2E_FAILED_${slot}:-0}"',
          '  eval "e2e_failures=\\${E2E_FAILURES_${slot}:-[]}"',
          '  eval "e2e_passes=\\${E2E_PASSES_${slot}:-}"',
          '  eval "e2e_cases=\\${E2E_CASES_${slot}:-}"',
          '  # The passing names are optional and fail-soft: an older central',
          '  # workflow publishes none, and a malformed value must not cost the',
          '  # whole report. Anything that is not a JSON array of strings is',
          '  # dropped, and the list is capped to what ingest accepts (500 names',
          '  # of at most 500 characters). An empty array is kept - it means',
          '  # "ran, nothing passed" - while a missing one is left out, so ALPHACI',
          '  # knows to fall back to inference for that run.',
          '  if [ -n "$e2e_passes" ] && printf \'%s\' "$e2e_passes" | jq -e \'type == "array" and all(.[]; type == "string")\' >/dev/null 2>&1; then',
          "    e2e_passes=$(printf '%s' \"$e2e_passes\" | jq -c '[.[:500][] | .[0:500]]')",
          '  else',
          '    e2e_passes=',
          '  fi',
          '  # The per-test detail is optional and fail-soft like the names: an',
          '  # older central workflow publishes none, and anything that is not an',
          '  # array of objects is dropped rather than costing the report. Capped',
          '  # to what ingest accepts (50).',
          '  if [ -n "$e2e_cases" ] && printf \'%s\' "$e2e_cases" | jq -e \'type == "array" and all(.[]; type == "object")\' >/dev/null 2>&1; then',
          "    e2e_cases=$(printf '%s' \"$e2e_cases\" | jq -c '.[:50]')",
          '  else',
          '    e2e_cases=',
          '  fi',
          '  E2E_TESTS=$(jq -n \\',
          '    --argjson total "$e2e_total" \\',
          '    --argjson passed "${e2e_passed:-0}" \\',
          '    --argjson failed "${e2e_failed:-0}" \\',
          '    --argjson failures "${e2e_failures:-[]}" \\',
          '    --argjson passes "${e2e_passes:-null}" \\',
          '    --argjson cases "${e2e_cases:-null}" \\',
          "    '{total:$total,passed:$passed,failed:$failed,failures:$failures} + (if $passes == null then {} else {passes:$passes} end) + (if $cases == null then {} else {cases:$cases} end)')",
          '  RESULTS=$(printf \'%s\' "$RESULTS" | jq -c --argjson tests "$E2E_TESTS" \'. + {tests:$tests}\')',
          '  break',
          'done',
        ]
      : []),
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
          '# Why the analysis could not run, when the cause is a setting rather',
          '# than the code. Carried as a fact because it cannot arrive any other',
          '# way: a workflow-level error is attributed to `.github`, and those',
          '# annotations are filtered out.',
          'if [ -n "$SONAR_BLOCKED_BY" ]; then',
          '  SONAR=$(printf \'%s\' "$SONAR" | jq -c --arg b "$SONAR_BLOCKED_BY" \'. + {blockedBy:$b}\')',
          'fi',
          'if [ -n "$SONAR_GATE" ]; then',
          '  SONAR=$(printf \'%s\' "$SONAR" | jq -c --arg gate "$SONAR_GATE" \'. + {gate:$gate}\')',
          'fi',
          'if printf \'%s\' "${SONAR_CONDITIONS:-}" | jq -e \'type == "array" and length > 0\' >/dev/null 2>&1; then',
          '  SONAR=$(printf \'%s\' "$SONAR" | jq -c --argjson c "$SONAR_CONDITIONS" \'. + {failedConditions:$c}\')',
          'fi',
          'if printf \'%s\' "${SONAR_MEASURES:-}" | jq -e \'type == "object" and length > 0\' >/dev/null 2>&1; then',
          '  SONAR=$(printf \'%s\' "$SONAR" | jq -c --argjson m "$SONAR_MEASURES" \'. + {measures:$m}\')',
          'fi',
          'if printf \'%s\' "${SONAR_ISSUES:-}" | jq -e \'type == "array" and length > 0 and all(.[]; type == "object")\' >/dev/null 2>&1; then',
          '  SONAR=$(printf \'%s\' "$SONAR" | jq -c --argjson i "$SONAR_ISSUES" \'. + {issues:$i[:20]}\')',
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
     *
     * `statuses: write` is what lets this job put the stage's verdict on the
     * commit. A chained stage runs via `workflow_run` and never appears as a
     * pull-request check, so without this the only thing branch protection
     * could require was a five-second environment check - and a pull request
     * into uat could be merged with every test failing.
     */
    permissions: {
      contents: 'read',
      actions: 'read',
      checks: 'read',
      statuses: 'write',
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
