import type {
  WorkflowFragment,
  WorkflowFragmentBranch,
  WorkflowFragmentContext,
  WorkflowFragmentResult,
  WorkflowFragmentTarget,
} from '../../../core/workflow-fragment.contract';
import {
  branchCondition,
  CENTRAL_WORKFLOW_REF,
  deploymentNeeds,
} from '../core/workflow-fragment.helpers';

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
      RENDER_DEPLOY_HOOK_URL_TEST: `\${{ secrets.${secretNames['deployHookUrl'] ?? 'RENDER_DEPLOY_HOOK_URL_TEST'} }}`,
      RENDER_DEPLOY_HOOK_URL_UAT: `\${{ secrets.${secretNames['deployHookUrl'] ?? 'RENDER_DEPLOY_HOOK_URL_UAT'} }}`,
      RENDER_DEPLOY_HOOK_URL_MAIN: `\${{ secrets.${secretNames['deployHookUrl'] ?? 'RENDER_DEPLOY_HOOK_URL_MAIN'} }}`,
      RENDER_HEALTHCHECK_URL_TEST: `\${{ secrets.${secretNames['healthcheckUrl'] ?? 'RENDER_HEALTHCHECK_URL_TEST'} }}`,
      RENDER_HEALTHCHECK_URL_UAT: `\${{ secrets.${secretNames['healthcheckUrl'] ?? 'RENDER_HEALTHCHECK_URL_UAT'} }}`,
      RENDER_HEALTHCHECK_URL_MAIN: `\${{ secrets.${secretNames['healthcheckUrl'] ?? 'RENDER_HEALTHCHECK_URL_MAIN'} }}`,
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
      [jobId]: buildRenderJob(target, branch, context, dockerJobId),
    },
    jobIds: [dockerJobId, jobId],
    promotionNeeds: branch === 'uat' ? [dockerJobId, jobId] : [],
  };
}

/** Render's provider-owned workflow contribution. */
export const renderWorkflowFragment: WorkflowFragment = {
  provider: 'render',
  build: (target, branch, context) =>
    buildRenderFragment(target, branch, context),
};
