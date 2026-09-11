import { vercelAliasSecret } from '#kernel/ports/workflow-fragment.port';

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
        uses: `${CENTRAL_WORKFLOW_BASE}/vercel-deploy.yml@${context.centralWorkflowRef}`,
        with: {
          'system-name': context.serviceName,
          'working-directory': target.rootDirectory ?? context.servicePath,
          environment: branch === 'main' ? 'production' : 'preview',
          /*
           * Pin the preview to a stable hostname.
           *
           * `vercel deploy` returns a URL unique to the deployment, and a
           * later workflow_run stage cannot read this job's outputs — so a UI
           * suite would have no address to aim at. Production needs none:
           * --prod already lands on a fixed domain.
           *
           * The name is shared with the verify stage through
           * vercelAliasSecret, so the address this deploy claims and the one
           * the browser is sent to cannot drift apart.
           *
           * `vars`, not `secrets`: GitHub forbids the secrets context inside a
           * reusable workflow call's `with:` block and rejects the whole file
           * at parse time when it finds one - which is why the package stage
           * could not be registered at all on a real project. An alias is a
           * public hostname, so it belongs in vars regardless.
           */
          ...(branch === 'main'
            ? {}
            : {
                'branch-alias': `\${{ vars.${vercelAliasSecret(branch)} }}`,
              }),
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
