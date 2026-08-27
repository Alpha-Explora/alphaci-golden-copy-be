import type { WorkflowFragmentBranch } from '../../../core/workflow-fragment.contract';

export const CENTRAL_WORKFLOW_REF =
  'cicd-external-project/cicd-workflow/.github/workflows';
export const BRANCH_EXPR = 'github.event.workflow_run.head_branch || github.ref_name';
export const HEAD_SHA_EXPR = '${{ github.event.workflow_run.head_sha || github.sha }}';

export function branchCondition(branch: WorkflowFragmentBranch): string {
  return `\${{ (${BRANCH_EXPR}) == '${branch}' }}`;
}

export function deploymentNeeds(branch: WorkflowFragmentBranch): string[] {
  return branch === 'main' ? ['build', 'production-gate'] : ['build'];
}
