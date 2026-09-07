import { resolveCentralWorkflowBase } from '#kernel/config/central-workflow';
import type { WorkflowFragmentBranch } from '../../../core/workflow-fragment.contract';

/**
 * `owner/name/.github/workflows` prefix for provider deploy jobs.
 *
 * Named BASE, not REF: this is the repository, while `context.centralWorkflowRef`
 * is the git tag. Shares one resolver with the workflow generator so a provider
 * fragment can never emit a `uses:` pointing at a different repository than the
 * quality stages in the same pipeline.
 */
export const CENTRAL_WORKFLOW_BASE = resolveCentralWorkflowBase();
export const BRANCH_EXPR =
  'github.event.workflow_run.head_branch || github.ref_name';
export const HEAD_SHA_EXPR =
  '${{ github.event.workflow_run.head_sha || github.sha }}';

export function branchCondition(branch: WorkflowFragmentBranch): string {
  return `\${{ (${BRANCH_EXPR}) == '${branch}' }}`;
}

export function deploymentNeeds(branch: WorkflowFragmentBranch): string[] {
  return branch === 'main' ? ['build', 'production-gate'] : ['build'];
}
