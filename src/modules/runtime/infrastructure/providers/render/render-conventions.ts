import type { PipelineBranch } from '#kernel/config/pipeline-branches';

/**
 * The facts the two halves of Render support must agree on.
 *
 * Provisioning creates the service and the workflow generator writes the jobs
 * that feed it, and they live in different files. Every time one of these
 * values was spelled out in both, they drifted:
 *
 *   - the image: provisioning pointed the service at
 *     `alphaci-backend-uat-<project>-uat` because it appended the branch to a
 *     project name that already ended in it, while the pipeline pushed
 *     `alphaci-backend-uat-<project>`. Render can only ever deploy the image
 *     its service names, so nothing the pipeline built could be released.
 *   - the branches: two independent `['uat', 'main']` literals, which is why
 *     adding a branch to the promotion flow does not reach Render.
 *
 * Both halves import from here instead.
 */

/** Where the central docker-build workflow pushes images. */
const IMAGE_REGISTRY = 'ghcr.io';

/**
 * Branches that get their own managed Render service.
 *
 * `satisfies` ties this to the promotion flow: a branch renamed in
 * PIPELINE_BRANCHES stops compiling here rather than silently generating jobs
 * for a branch Render has no service for.
 *
 * Every branch in the flow has its own service, so a developer can see their
 * own change running. That costs three free services per backend project;
 * RenderCostPolicyService owns whether those may be paid ones.
 */
export const RENDER_SERVICE_BRANCHES = [
  'dev',
  'uat',
  'main',
] as const satisfies readonly PipelineBranch[];

export type RenderServiceBranch = (typeof RENDER_SERVICE_BRANCHES)[number];

export function isRenderServiceBranch(
  branchName: string | null | undefined,
): branchName is RenderServiceBranch {
  return (RENDER_SERVICE_BRANCHES as readonly string[]).includes(
    (branchName ?? '').trim(),
  );
}

/**
 * The branch a target's Render resources are named after.
 *
 * Anything Render has no service for falls back to the first branch in the
 * flow rather than to production: a wrong guess must not point a deploy at the
 * customer's live environment.
 */
export function renderBranchFor(
  branchName: string | null | undefined,
): RenderServiceBranch {
  return isRenderServiceBranch(branchName)
    ? (branchName.trim() as RenderServiceBranch)
    : RENDER_SERVICE_BRANCHES[0];
}

/**
 * A project name without its branch suffix.
 *
 * Provisioning names the service `<base>-<branch>`, so by the time an expanded
 * target reaches image naming its projectName already carries the branch.
 * Composing on top of that produced the duplicated `-uat-...-uat` image.
 */
function baseProjectName(projectName: string | null | undefined): string {
  return (projectName ?? '')
    .trim()
    .replace(/-(test|dev|uat|main|production)$/i, '');
}

function sanitize(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/g, '-')
    .replaceAll(/^-+|-+$/g, '');
}

/** The image name the pipeline builds and the service pulls. */
export function renderImageName(input: {
  slot: string;
  branchName: RenderServiceBranch;
  projectName?: string | null | undefined;
}): string {
  const base = baseProjectName(input.projectName) || input.slot;
  return sanitize(`alphaci-${input.slot}-${input.branchName}-${base}`);
}

/** `<registry>/<owner>/<image name>`, without a tag. */
export function renderImageRepository(input: {
  repoFullName: string;
  slot: string;
  branchName: RenderServiceBranch;
  projectName?: string | null | undefined;
}): string | null {
  const [owner] = input.repoFullName.split('/');
  if (!owner) return null;
  return `${IMAGE_REGISTRY}/${owner.toLowerCase()}/${renderImageName(input)}`;
}

/**
 * The image reference a service is created with.
 *
 * Tagged with the branch, because Render's trigger-deploy API accepts a
 * different tag but requires the host, repository and image name to match what
 * the service was configured with.
 */
export function renderImageUrl(input: {
  repoFullName: string;
  slot: string;
  branchName: RenderServiceBranch;
  projectName?: string | null | undefined;
}): string | null {
  const repository = renderImageRepository(input);
  return repository ? `${repository}:${input.branchName}` : null;
}
