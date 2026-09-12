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
/*
 * Read from the package stage's context job, never from the event.
 *
 * A deploy fragment is emitted into a `workflow_run` stage two hops from the
 * push, and by then every branch and sha field in the event says `main` - the
 * default branch the stage executes in. Reading them here made a push to dev
 * run the production deploy job, against main's commit rather than the one
 * that was pushed. The context job carries the real values forward; these must
 * stay in step with PIPELINE_CONTEXT_JOB_ID in the workflow builder.
 */
export const PIPELINE_CONTEXT_JOB_ID = 'pipeline-context';
export const BRANCH_EXPR = `needs.${PIPELINE_CONTEXT_JOB_ID}.outputs.branch`;
export const HEAD_SHA_EXPR = `\${{ needs.${PIPELINE_CONTEXT_JOB_ID}.outputs.sha }}`;

export function branchCondition(branch: WorkflowFragmentBranch): string {
  return `\${{ (${BRANCH_EXPR}) == '${branch}' }}`;
}

export function deploymentNeeds(branch: WorkflowFragmentBranch): string[] {
  return branch === 'main' ? ['build', 'production-gate'] : ['build'];
}
