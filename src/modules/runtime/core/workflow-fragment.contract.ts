export type WorkflowFragmentBranch = 'uat' | 'main';

export interface WorkflowFragmentTarget {
  readonly provider: string;
  readonly slot: string;
  readonly deploymentStrategy: string;
  readonly rootDirectory?: string;
  readonly dockerContext?: string | null;
  readonly dockerfilePath?: string | null;
  readonly imageName?: string | null;
  readonly renderServiceType?: string | null;
  readonly renderInstanceType?: string | null;
  readonly secretNames?: {
    readonly token?: string;
    readonly orgId?: string;
    readonly projectId?: string;
    readonly deployHookUrl?: string;
    readonly healthcheckUrl?: string;
  };
}

export interface WorkflowFragmentContext {
  readonly serviceName: string;
  readonly servicePath: string;
  readonly centralWorkflowRef: string;
}

export interface WorkflowFragmentResult {
  readonly jobs: Record<string, unknown>;
  readonly jobIds: string[];
  readonly promotionNeeds: string[];
}

/**
 * Provider-owned workflow contribution. Workflows composes this result but
 * does not know provider job names, reusable workflow refs, or secret maps.
 */
export interface WorkflowFragment {
  build(
    target: WorkflowFragmentTarget,
    branch: WorkflowFragmentBranch,
    context: WorkflowFragmentContext,
  ): WorkflowFragmentResult | undefined;
}

const CENTRAL_WORKFLOW_REF =
  'cicd-external-project/cicd-workflow/.github/workflows';
const BRANCH_EXPR = 'github.event.workflow_run.head_branch || github.ref_name';
const HEAD_SHA_EXPR = '${{ github.event.workflow_run.head_sha || github.sha }}';

function branchCondition(branch: WorkflowFragmentBranch): string {
  return `\${{ (${BRANCH_EXPR}) == '${branch}' }}`;
}

function deploymentNeeds(branch: WorkflowFragmentBranch): string[] {
  return branch === 'main' ? ['build', 'production-gate'] : ['build'];
}

function vercelFragment(
  target: WorkflowFragmentTarget,
  branch: WorkflowFragmentBranch,
  context: WorkflowFragmentContext,
): WorkflowFragmentResult {
  const secretNames = target.secretNames ?? {};
  const jobId = `deploy-${target.provider}-${target.slot}-${branch}`;
  return {
    jobs: {
      [jobId]: {
        needs: deploymentNeeds(branch),
        if: branchCondition(branch),
        uses: `${CENTRAL_WORKFLOW_REF}/vercel-deploy.yml@${context.centralWorkflowRef}`,
        with: {
          'system-name': context.serviceName,
          'working-directory': target.rootDirectory ?? context.servicePath,
          environment: branch === 'main' ? 'production' : 'preview',
          'checkout-ref': HEAD_SHA_EXPR,
        },
        secrets: {
          VERCEL_TOKEN: `\${{ secrets.${secretNames.token ?? 'VERCEL_TOKEN'} }}`,
          VERCEL_ORG_ID: `\${{ secrets.${secretNames.orgId ?? 'VERCEL_ORG_ID'} }}`,
          VERCEL_PROJECT_ID: `\${{ secrets.${secretNames.projectId ?? 'VERCEL_PROJECT_ID'} }}`,
          GH_PR_TOKEN:
            "${{ secrets.GH_PR_TOKEN != '' && secrets.GH_PR_TOKEN || github.token }}",
        },
      },
    },
    jobIds: [jobId],
    promotionNeeds: branch === 'uat' ? [jobId] : [],
  };
}

function dockerBuildFragment(
  target: WorkflowFragmentTarget,
  branch: WorkflowFragmentBranch,
  context: WorkflowFragmentContext,
): Record<string, unknown> {
  return {
    // docker-build.yml's nested vulnerability-scan job requires
    // security-events: write to upload its Trivy SARIF report.
    permissions: {
      contents: 'read',
      packages: 'write',
      'security-events': 'write',
    },
    needs: deploymentNeeds(branch),
    if: branchCondition(branch),
    uses: `${CENTRAL_WORKFLOW_REF}/docker-build.yml@${context.centralWorkflowRef}`,
    with: {
      'working-directory':
        target.dockerContext ?? target.rootDirectory ?? context.servicePath,
      'image-name': target.imageName ?? `alphaci-${target.slot}`,
      'dockerfile-path': target.dockerfilePath ?? 'Dockerfile',
      'push-image': true,
      'scan-vulnerabilities': true,
      'fail-on-vulnerabilities': true,
    },
  };
}

function renderFragment(
  target: WorkflowFragmentTarget,
  branch: WorkflowFragmentBranch,
  context: WorkflowFragmentContext,
  dockerJobId: string,
): Record<string, unknown> {
  const secretNames = target.secretNames ?? {};
  return {
    needs: [dockerJobId],
    if: branchCondition(branch),
    uses: `${CENTRAL_WORKFLOW_REF}/render-deploy.yml@${context.centralWorkflowRef}`,
    with: {
      'system-name': context.serviceName,
      environment: branch === 'main' ? 'production' : branch,
      branch,
      'deploy-mode': 'auto',
      'healthcheck-path': '/api/v1/health',
      'require-api-center-check': true,
    },
    secrets: {
      RENDER_DEPLOY_HOOK_URL_TEST: `\${{ secrets.${secretNames.deployHookUrl ?? 'RENDER_DEPLOY_HOOK_URL_TEST'} }}`,
      RENDER_DEPLOY_HOOK_URL_UAT: `\${{ secrets.${secretNames.deployHookUrl ?? 'RENDER_DEPLOY_HOOK_URL_UAT'} }}`,
      RENDER_DEPLOY_HOOK_URL_MAIN: `\${{ secrets.${secretNames.deployHookUrl ?? 'RENDER_DEPLOY_HOOK_URL_MAIN'} }}`,
      RENDER_HEALTHCHECK_URL_TEST: `\${{ secrets.${secretNames.healthcheckUrl ?? 'RENDER_HEALTHCHECK_URL_TEST'} }}`,
      RENDER_HEALTHCHECK_URL_UAT: `\${{ secrets.${secretNames.healthcheckUrl ?? 'RENDER_HEALTHCHECK_URL_UAT'} }}`,
      RENDER_HEALTHCHECK_URL_MAIN: `\${{ secrets.${secretNames.healthcheckUrl ?? 'RENDER_HEALTHCHECK_URL_MAIN'} }}`,
    },
  };
}

const workflowFragments: ReadonlyMap<string, WorkflowFragment> = new Map([
  [
    'vercel',
    {
      build: (target, branch, context) =>
        vercelFragment(target, branch, context),
    },
  ],
  [
    'render',
    {
      build: (target, branch, context) => {
        if (target.deploymentStrategy !== 'render_image_pushed') {
          return undefined;
        }

        const jobId = `deploy-${target.provider}-${target.slot}-${branch}`;
        const dockerJobId = `docker-${target.slot}-${branch}`;
        return {
          jobs: {
            [dockerJobId]: dockerBuildFragment(target, branch, context),
            [jobId]: renderFragment(target, branch, context, dockerJobId),
          },
          jobIds: [dockerJobId, jobId],
          promotionNeeds: branch === 'uat' ? [dockerJobId, jobId] : [],
        };
      },
    },
  ],
]);

export function buildDeploymentWorkflowFragment(
  target: WorkflowFragmentTarget,
  branch: WorkflowFragmentBranch,
  context: WorkflowFragmentContext,
): WorkflowFragmentResult | undefined {
  return workflowFragments.get(target.provider)?.build(target, branch, context);
}
