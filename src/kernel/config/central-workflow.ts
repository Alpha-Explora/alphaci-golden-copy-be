/**
 * Identity of the central workflow repository that generated customer
 * pipelines call into.
 *
 * Two shapes are derived from one setting, because they were previously two
 * unrelated hardcoded constants in different bounded contexts that could drift
 * apart without anything noticing:
 *
 *   repo -> `owner/name`                     GitHub API calls, e.g. tag listing
 *   base -> `owner/name/.github/workflows`   the `uses:` prefix in generated YAML
 *
 * Naming: this is the *repository*. The git ref (`v1`, `internal-v1`, `educ-v1`)
 * is a separate setting, CENTRAL_WORKFLOW_REF, resolved elsewhere. Those two
 * were previously both spelled CENTRAL_WORKFLOW_REF — one a constant meaning
 * the repository, one an environment variable meaning the tag. That collision
 * is why making "the ref" configurable left the repository hardcoded: the
 * change did what its name said, and the name covered two different things.
 *
 * The default is the repository every deployment should use, so a deployment
 * that configures nothing still generates correct pipelines. CENTRAL_WORKFLOW_REPO
 * exists to point a single deployment somewhere else — a fork, or a staging line —
 * without a code change, not to carry the value the product actually runs on.
 */
export const DEFAULT_CENTRAL_WORKFLOW_REPO = 'Alpha-Explora/alphaci-workflow';

/** Path within the repository that holds the reusable workflows. */
const WORKFLOWS_PATH = '.github/workflows';

/**
 * `owner/name` of the central workflow repository.
 */
export function resolveCentralWorkflowRepo(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return env['CENTRAL_WORKFLOW_REPO']?.trim() || DEFAULT_CENTRAL_WORKFLOW_REPO;
}

/**
 * `owner/name/.github/workflows` — the prefix every generated `uses:` is built
 * from. Always derived from {@link resolveCentralWorkflowRepo} so the two can
 * never name different repositories again.
 */
export function resolveCentralWorkflowBase(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return `${resolveCentralWorkflowRepo(env)}/${WORKFLOWS_PATH}`;
}
