import type {
  WorkflowFragment,
  WorkflowFragmentBranch,
  WorkflowFragmentContext,
  WorkflowFragmentResult,
  WorkflowFragmentTarget,
  WorkflowTargetExpansionContext,
  WorkflowTargetExpansionInput,
} from '../../../core/workflow-fragment.contract';
import {
  branchCondition,
  CENTRAL_WORKFLOW_BASE,
  deploymentNeeds,
  HEAD_SHA_EXPR,
} from '../core/workflow-fragment.helpers';
import {
  RENDER_SERVICE_BRANCHES,
  renderImageName,
  type RenderServiceBranch,
} from './render-conventions';
import {
  legacyEnvironmentLabel,
  type EnvironmentDeployInput,
} from '#kernel/ports/workflow-fragment.port';

function buildDockerJob(
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
    uses: `${CENTRAL_WORKFLOW_BASE}/docker-build.yml@${context.centralWorkflowRef}`,
    with: {
      'working-directory':
        target.dockerContext ?? target.rootDirectory ?? context.servicePath,
      'image-name': target.imageName ?? `alphaci-${target.slot}`,
      'dockerfile-path': target.dockerfilePath ?? 'Dockerfile',
      'push-image': true,
      'scan-vulnerabilities': true,
      'fail-on-vulnerabilities': true,
      /*
       * Both from the context job, never from the event. This stage runs on a
       * workflow_run, where the git context is the DEFAULT branch: without
       * these, a uat run built main's code and tagged the image `main` and
       * `latest`, so no tag ever named the uat build.
       */
      'checkout-ref': HEAD_SHA_EXPR,
      'pipeline-branch': branch,
    },
  };
}

function buildReleaseJob(
  target: WorkflowFragmentTarget,
  branch: WorkflowFragmentBranch,
  context: WorkflowFragmentContext,
  dockerJobId: string,
): Record<string, unknown> {
  return {
    needs: [dockerJobId],
    if: branchCondition(branch),
    uses: `${CENTRAL_WORKFLOW_BASE}/release.yml@${context.centralWorkflowRef}`,
    with: {
      'system-name': context.serviceName,
      slot: target.slot,
      branch,
      'commit-sha': HEAD_SHA_EXPR,
      /*
       * The exact build, not the branch tag. Both are pushed, but a second run
       * on the same branch moves the branch tag - so a deploy that asked for
       * `:uat` could ship a build that had not passed this run's gates.
       */
      artifact: `\${{ needs.${dockerJobId}.outputs.image-repo }}:sha-${HEAD_SHA_EXPR}`,
      'healthcheck-path': '/health',
    },
    /*
     * The only credentials a deploy job now carries: the project's own AlphaCI
     * token and the address to send it to. The hosting credential stays with
     * the platform, which is the point of releasing through it - a Render API
     * key is account-wide, so one in every customer repository would give
     * anyone who can push a workflow the run of the whole Render account.
     */
    secrets: {
      ALPHACI_TOKEN: '${{ secrets.ALPHACI_TOKEN }}',
      ALPHACI_API_URL: '${{ secrets.ALPHACI_API_URL }}',
    },
  };
}

function buildRenderFragment(
  target: WorkflowFragmentTarget,
  branch: WorkflowFragmentBranch,
  context: WorkflowFragmentContext,
): WorkflowFragmentResult | undefined {
  if (target.deploymentStrategy !== 'render_image_pushed') {
    return undefined;
  }

  const jobId = `deploy-${target.provider}-${target.slot}-${branch}`;
  const dockerJobId = `docker-${target.slot}-${branch}`;
  return {
    jobs: {
      [dockerJobId]: buildDockerJob(target, branch, context),
      [jobId]: buildReleaseJob(target, branch, context, dockerJobId),
    },
    jobIds: [dockerJobId, jobId],
    // Every branch that promotes onward, not just uat. Listing only uat meant
    // promote-to-uat waited on nothing but the compile, so a dev deployment
    // could fail and the code was promoted anyway. main never promotes, so it
    // contributes nothing here.
    promotionNeeds: branch === 'main' ? [] : [dockerJobId, jobId],
  };
}

function resolveRenderDeploymentStrategy(
  target: WorkflowTargetExpansionInput,
): 'render_image_pushed' | 'render_git_connected' | 'render_existing_service' {
  if (providerDataString(target, 'renderDeployMethod') === 'existing_service') {
    return 'render_existing_service';
  }
  if (
    target.ownershipMode === 'flowci_managed' ||
    providerDataString(target, 'renderDeployMethod') === 'byo_image'
  ) {
    return 'render_image_pushed';
  }
  return 'render_git_connected';
}

function renderSecretNames(
  slot: string,
  branchName: RenderServiceBranch,
): Record<string, string> {
  const prefix = `RENDER_${slot.toUpperCase()}_${branchName.toUpperCase()}`;
  const branchSuffix = branchName.toUpperCase();
  return {
    apiKey: `${prefix}_API_KEY`,
    serviceId: `${prefix}_SERVICE_ID`,
    ownerId: `${prefix}_OWNER_ID`,
    registryCredentialId: `${prefix}_REGISTRY_CREDENTIAL_ID`,
    deployHookUrl: `RENDER_DEPLOY_HOOK_URL_${branchSuffix}`,
    healthcheckUrl: `RENDER_HEALTHCHECK_URL_${branchSuffix}`,
  };
}

function expandRenderTargets(
  target: WorkflowTargetExpansionInput,
  context: WorkflowTargetExpansionContext,
): readonly WorkflowFragmentTarget[] {
  /*
   * Deliberately no instance-type or service-type check.
   *
   * RenderCostPolicyService already refuses anything but a free web service
   * when it creates the target, and it does so from configuration. Repeating
   * the rule here made the workflow generator a second, silent gate: a
   * deployment that allowed a paid plan got its services created and no deploy
   * jobs at all, with nothing said. One rule, in the half that owns it.
   */
  if (
    target.slot !== 'backend' ||
    resolveRenderDeploymentStrategy(target) !== 'render_image_pushed'
  ) {
    return [];
  }

  const rootDirectory =
    target.rootDirectory?.trim() ||
    context.fallbackRootDirectory?.trim() ||
    undefined;
  return RENDER_SERVICE_BRANCHES.map((branchName) => ({
    slot: target.slot,
    provider: 'render',
    branchName,
    deploymentStrategy: 'render_image_pushed',
    secretNames: renderSecretNames(target.slot, branchName),
    dockerContext: target.dockerContext?.trim() || rootDirectory || '.',
    dockerfilePath: target.dockerfilePath?.trim() || 'Dockerfile',
    imageName: renderImageName({
      slot: target.slot,
      branchName,
      projectName: target.projectName,
    }),
    ...(rootDirectory ? { rootDirectory } : {}),
  }));
}

function providerDataString(
  target: WorkflowTargetExpansionInput,
  key: string,
): string {
  const value = target.providerData?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

/** Render's provider-owned workflow contribution. */
export const renderWorkflowFragment: WorkflowFragment = {
  provider: 'render',
  deploysBuiltImage: true,
  expandTargets: expandRenderTargets,
  build: (target, branch, context) =>
    buildRenderFragment(target, branch, context),
  environmentDeployJob: (input, context) =>
    renderEnvironmentDeployJob(input, context),
};

/**
 * Deploy one environment's Render target: the digest built for this release,
 * named by environment, GitHub Environment, and target ID. Nothing is read
 * from the branch.
 */
function renderEnvironmentDeployJob(
  input: EnvironmentDeployInput,
  context: WorkflowFragmentContext,
): Record<string, unknown> {
  return {
    needs: input.needs,
    if: input.if,
    uses: `${CENTRAL_WORKFLOW_BASE}/render-deploy.yml@${context.centralWorkflowRef}`,
    with: {
      'system-name': context.serviceName,
      environment: legacyEnvironmentLabel(input.environment.role),
      branch: input.environment.sourceBranch,
      'environment-id': input.environment.id,
      'environment-name': input.environment.slug,
      'target-id': input.targetId,
      'commit-sha': input.commitSha,
      ...(input.artifact ? { artifact: input.artifact } : {}),
    },
    secrets: 'inherit',
  };
}
