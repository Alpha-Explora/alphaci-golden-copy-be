import {
  WorkflowFragmentRegistry,
  type WorkflowFragmentBranch,
  type WorkflowFragmentContext,
  type WorkflowFragmentResult,
  type WorkflowFragmentTarget,
} from '../../../core/workflow-fragment.contract';
import { renderWorkflowFragment } from '../render/render-workflow.fragment';
import { vercelWorkflowFragment } from '../vercel/vercel-workflow.fragment';

/**
 * Runtime composition point for workflow provider plugins. The core contract
 * stays vendor-neutral; each provider folder owns its workflow contribution.
 * A future provider adds its fragment to this composition list, not to the
 * builder, DTO, or registry implementation.
 */
export const DEFAULT_WORKFLOW_FRAGMENT_REGISTRY =
  new WorkflowFragmentRegistry([
    renderWorkflowFragment,
    vercelWorkflowFragment,
  ]);

export function buildDeploymentWorkflowFragment(
  target: WorkflowFragmentTarget,
  branch: WorkflowFragmentBranch,
  context: WorkflowFragmentContext,
): WorkflowFragmentResult | undefined {
  return DEFAULT_WORKFLOW_FRAGMENT_REGISTRY.get(target.provider)?.build(
    target,
    branch,
    context,
  );
}

export { WorkflowFragmentRegistry } from '../../../core/workflow-fragment.contract';
export type {
  WorkflowFragment,
  WorkflowFragmentContext,
  WorkflowFragmentResult,
  WorkflowFragmentTarget,
} from '../../../core/workflow-fragment.contract';
