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
  CENTRAL_WORKFLOW_REF,
  deploymentNeeds,
  HEAD_SHA_EXPR,
} from '../core/workflow-fragment.helpers';

function buildVercelFragment(
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
          VERCEL_TOKEN: `\${{ secrets.${secretNames['token'] ?? 'VERCEL_TOKEN'} }}`,
          VERCEL_ORG_ID: `\${{ secrets.${secretNames['orgId'] ?? 'VERCEL_ORG_ID'} }}`,
          VERCEL_PROJECT_ID: `\${{ secrets.${secretNames['projectId'] ?? 'VERCEL_PROJECT_ID'} }}`,
          GH_PR_TOKEN:
            "${{ secrets.GH_PR_TOKEN != '' && secrets.GH_PR_TOKEN || github.token }}",
        },
      },
    },
    jobIds: [jobId],
    promotionNeeds: branch === 'uat' ? [jobId] : [],
  };
}

function expandVercelTargets(
  target: WorkflowTargetExpansionInput,
  context: WorkflowTargetExpansionContext,
): readonly WorkflowFragmentTarget[] {
  if (target.slot !== 'frontend') {
    return [];
  }

  const rootDirectory =
    target.rootDirectory?.trim() ||
    context.fallbackRootDirectory?.trim() ||
    undefined;
  return [
    {
      slot: target.slot,
      provider: 'vercel',
      deploymentStrategy: 'vercel_ci_pushed',
      secretNames: {
        token: `VERCEL_${target.slot.toUpperCase()}_TOKEN`,
        orgId: `VERCEL_${target.slot.toUpperCase()}_ORG_ID`,
        projectId: `VERCEL_${target.slot.toUpperCase()}_PROJECT_ID`,
      },
      ...(rootDirectory ? { rootDirectory } : {}),
    },
  ];
}

/** Vercel's provider-owned workflow contribution. */
export const vercelWorkflowFragment: WorkflowFragment = {
  provider: 'vercel',
  expandTargets: expandVercelTargets,
  build: (target, branch, context) =>
    buildVercelFragment(target, branch, context),
};
