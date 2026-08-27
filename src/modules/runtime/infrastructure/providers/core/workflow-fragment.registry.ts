import {
  WorkflowFragmentRegistry,
  type WorkflowFragmentBranch,
  type WorkflowFragmentContext,
  type WorkflowFragmentResult,
  type WorkflowFragmentTarget,
} from '#kernel/ports/workflow-fragment.port';

export function buildDeploymentWorkflowFragment(
  target: WorkflowFragmentTarget,
  branch: WorkflowFragmentBranch,
  context: WorkflowFragmentContext,
  registry: WorkflowFragmentRegistry = new WorkflowFragmentRegistry(),
): WorkflowFragmentResult | undefined {
  return registry.build(target, branch, context);
}

export {
  WORKFLOW_FRAGMENTS,
  WorkflowFragmentRegistry,
} from '#kernel/ports/workflow-fragment.port';
export type {
  WorkflowFragment,
  WorkflowFragmentContext,
  WorkflowFragmentResult,
  WorkflowFragmentTarget,
  WorkflowTargetExpansionContext,
  WorkflowTargetExpansionInput,
} from '../../../core/workflow-fragment.contract';
