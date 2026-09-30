import { QA_PROMOTION_TARGET_BRANCH } from '#kernel/config/pipeline-branches';
import type { PlatformAppRole } from '#kernel/ports/platform-admin.port';

/**
 * Plain functions, not an injectable class — same reasoning as
 * qa-run-access.rules.ts: undecorated classes under a domain/rules folder get
 * no constructor args from Nest, and none of these rules has a dependency to
 * wire, so a function keeps them pure data in, data out.
 *
 * Lives in the kernel, not in the `projects` module alongside
 * qa-run-access.rules.ts, for the same reason PIPELINE_BRANCHES does
 * (kernel/config/pipeline-branches.ts): two bounded contexts have to agree on
 * this policy and neither owns the other. `projects` (pull requests, project
 * lifecycle) and `runtime` (env vars, deployment secrets) both gate HTTP
 * routes on it, and `projects` already imports `runtime` (RuntimeModule, for
 * CI/deployment features on the project surface) — a plain import of a
 * `projects`-owned rules file from `runtime` would close that into a
 * cross-context cycle dependency-cruiser's no-cross-context-cycles rule
 * forbids. A future rename or policy change reaches every caller from here,
 * the same way pipeline-branches.ts already does for branch names.
 *
 * Source of truth: PERSONA_WORKFLOW_SPEC.md §3 (the feature separation
 * matrix wins over §8.1's older recommendation where the two disagree).
 * Personas are the global `identity.app_users.app_role` — 'admin' | 'lead' |
 * 'qa' | 'member' — resolved by ProjectsRepository.findAppRole, which folds
 * any identity.platform_admins row into 'admin' regardless of the stored
 * app_role column. Naming lines up with the frontend's own guards
 * (canMergeQaPromotion-style) so a rule renamed or re-scoped here is renamed
 * or re-scoped on both sides at once.
 *
 *   canMergeViaWorkspace / canCreatePullRequest: admin | lead | member may
 *     act on any branch EXCEPT the production branch — main is reached only
 *     through the promotion flow (dev -> uat auto/manual, uat -> main via
 *     QA Studio's "Ready for production" gate, see qa-promotion.service.ts's
 *     canMergeQaPromotion). qa is never in this allow-list: QA verifies
 *     preview deployments and returns defects to developers, it does not
 *     open or merge pull requests (§3, "Create PR" / merge rows).
 *   canManageEnvVars / canManageProjectLifecycle: admin | lead only. Both
 *     touch a project's live configuration (deployment credentials,
 *     provider secrets, disconnecting a project entirely) — §3's "Hosting &
 *     Secrets" and "Team Administration" rows list these as lead/admin
 *     "Full Access", everyone else "Restricted".
 */

const WORKSPACE_PULL_REQUEST_ROLES: readonly PlatformAppRole[] = [
  'admin',
  'lead',
  'member',
];

const PROJECT_MANAGEMENT_ROLES: readonly PlatformAppRole[] = ['admin', 'lead'];

/** The production branch is never reached through the workspace PR endpoints. */
function isProductionBranch(base: string): boolean {
  return base === QA_PROMOTION_TARGET_BRANCH;
}

/**
 * Whether `role` may merge a workspace pull request whose base is `base`,
 * through the generic `POST .../pull-requests/:number/merge` endpoint.
 *
 * Always false for the production branch, regardless of role: merging into
 * main happens only through QA Studio's promotion gate (canMergeQaPromotion
 * in qa-run-access.rules.ts), never through this generic endpoint.
 */
export function canMergeViaWorkspace(
  role: PlatformAppRole,
  base: string,
): boolean {
  return (
    !isProductionBranch(base) && WORKSPACE_PULL_REQUEST_ROLES.includes(role)
  );
}

/**
 * Whether `role` may open a pull request whose base is `base`, through
 * `POST .../pull-requests`.
 *
 * Always false for the production branch, regardless of role: a pull
 * request into main is opened only by the promotion flow, never by a person.
 */
export function canCreatePullRequest(
  role: PlatformAppRole,
  base: string,
): boolean {
  return (
    !isProductionBranch(base) && WORKSPACE_PULL_REQUEST_ROLES.includes(role)
  );
}

/** Whether `role` may list, provision, validate, or delete a project's environment variables. */
export function canManageEnvVars(role: PlatformAppRole): boolean {
  return PROJECT_MANAGEMENT_ROLES.includes(role);
}

/**
 * Whether `role` may reinstall a deployment target's CI secrets, or
 * disconnect a project (any variant, including the non-destructive one).
 */
export function canManageProjectLifecycle(role: PlatformAppRole): boolean {
  return PROJECT_MANAGEMENT_ROLES.includes(role);
}
