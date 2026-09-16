import { PIPELINE_BRANCHES } from '#kernel/config/pipeline-branches';
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
} from '../core/workflow-fragment.helpers';
import {
  RENDER_SERVICE_BRANCHES,
  renderImageName,
  type RenderServiceBranch,
} from './render-conventions';

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
    },
  };
}

function buildRenderJob(
  target: WorkflowFragmentTarget,
  branch: WorkflowFragmentBranch,
  context: WorkflowFragmentContext,
  dockerJobId: string,
): Record<string, unknown> {
  const secretNames = target.secretNames ?? {};
  return {
    needs: [dockerJobId],
    if: branchCondition(branch),
    uses: `${CENTRAL_WORKFLOW_BASE}/render-deploy.yml@${context.centralWorkflowRef}`,
    with: {
      'system-name': context.serviceName,
      environment: branch === 'main' ? 'production' : branch,
      branch,
      'deploy-mode': 'auto',
      'healthcheck-path': '/api/v1/health',
      'require-api-center-check': true,
    },
    // render-deploy.yml declares one secret per branch in the flow and picks the
    // right one from its `branch` input, so every slot is handed the same
    // branch-scoped value. The keys are derived from the branch model rather
    // than listed: they were listed, the flow moved from `test` to `dev`, and
    // the generator kept sending RENDER_*_TEST. Actions rejects a secret the
    // called workflow does not declare, so the whole package stage failed to
    // start — for every Render deploy, on every stack.
    secrets: renderDeploySecrets(secretNames),
  };
}

function renderDeploySecrets(
  secretNames: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    PIPELINE_BRANCHES.flatMap((pipelineBranch) => {
      const suffix = pipelineBranch.toUpperCase();
      const deployHook =
        secretNames['deployHookUrl'] ?? `RENDER_DEPLOY_HOOK_URL_${suffix}`;
      const healthcheck =
        secretNames['healthcheckUrl'] ?? `RENDER_HEALTHCHECK_URL_${suffix}`;

      return [
        [`RENDER_DEPLOY_HOOK_URL_${suffix}`, `\${{ secrets.${deployHook} }}`],
        [`RENDER_HEALTHCHECK_URL_${suffix}`, `\${{ secrets.${healthcheck} }}`],
      ];
    }),
  );
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
      [jobId]: buildRenderJob(target, branch, context, dockerJobId),
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
  expandTargets: expandRenderTargets,
  build: (target, branch, context) =>
    buildRenderFragment(target, branch, context),
};
