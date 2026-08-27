import { WorkflowFragmentRegistry } from '#kernel/ports/workflow-fragment.port';
import { renderWorkflowFragment } from '../render/render-workflow.fragment';
import { vercelWorkflowFragment } from '../vercel/vercel-workflow.fragment';

/** Runtime composition for the providers shipped with this application. */
export function createDefaultWorkflowFragmentRegistry(): WorkflowFragmentRegistry {
  return new WorkflowFragmentRegistry([
    renderWorkflowFragment,
    vercelWorkflowFragment,
  ]);
}
