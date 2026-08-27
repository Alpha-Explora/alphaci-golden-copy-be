import {
  WorkflowFragmentRegistry,
  type WorkflowFragmentBranch,
  type WorkflowFragmentContext,
  type WorkflowFragmentResult,
  type WorkflowFragmentTarget,
} from '../../../core/workflow-fragment.contract';

export function buildDeploymentWorkflowFragment(
  target: WorkflowFragmentTarget,
  branch: WorkflowFragmentBranch,
  context: WorkflowFragmentContext,
  registry: WorkflowFragmentRegistry = new WorkflowFragmentRegistry(),
): WorkflowFragmentResult | undefined {
  return registry.get(target.provider)?.build(target, branch, context);
}

export {
  WORKFLOW_FRAGMENTS,
  WorkflowFragmentRegistry,
} from '../../../core/workflow-fragment.contract';
export type {
  WorkflowFragment,
  WorkflowFragmentContext,
  WorkflowFragmentResult,
  WorkflowFragmentTarget,
  WorkflowTargetExpansionContext,
  WorkflowTargetExpansionInput,
} from '../../../core/workflow-fragment.contract';
