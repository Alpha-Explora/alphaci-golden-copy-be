/**
 * Resolve the generated verify workflow's filename for a project, from its
 * stored `workflow_path` — the access-gate stage's own generated path
 * (`.github/workflows/00-alphaci-access[-<variant>].yml`; see
 * staged-workflow.builder.ts's resolveStagedNames). Every stage in one
 * bundle shares the same fileSuffix, so extracting it from the ONE path the
 * project row actually carries backs a workflow file that was never
 * separately persisted.
 *
 * There is no persisted `workflowVariant` field on a project — it exists
 * only as a build-time input while a microservices bundle is generated
 * (staged-workflow.builder.ts's StagedWorkflowOptions). A project whose
 * `workflow_path` does not follow the ALPHACI naming convention at all — a
 * BYO/existing-repo setup, which can use any filename — falls back to no
 * suffix, same as a single-repo project. That is a best-effort default,
 * not a guarantee: dispatch.ts's 404 -> VERIFY_WORKFLOW_MISSING mapping is
 * what actually answers a mismatch, not this function.
 */

import { verifyWorkflowFileFor } from '#kernel/config/pipeline-branches';

export function resolveVerifyWorkflowFile(
  workflowPath: string | null | undefined,
): string {
  return verifyWorkflowFileFor(workflowPath);
}
