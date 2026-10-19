import {
  PIPELINE_BRANCHES,
  QA_BRANCH,
  QA_PROMOTION_TARGET_BRANCH,
  WORKING_BRANCH,
} from '#kernel/config/pipeline-branches';
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
 *   canMergeViaWorkspace / canCreatePullRequest (isAllowedPullRequestRoute):
 *     admin | lead may act on any branch EXCEPT the production branch; member
 *     (Developer) only feature -> dev and dev -> uat — main is reached only
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
 *   visibleBranchesFor: role-filtered branch LISTING (§4). A listing filter
 *     only, not enforcement: other endpoints that accept an arbitrary ref
 *     are deliberately unchanged.
 */

const PROJECT_MANAGEMENT_ROLES: readonly PlatformAppRole[] = ['admin', 'lead'];

/** The production branch is never reached through the workspace PR endpoints. */
function isProductionBranch(base: string): boolean {
  return base === QA_PROMOTION_TARGET_BRANCH;
}

/** Pipeline rungs (dev, uat, main); every other branch is a feature branch. */
function isPipelineBranch(name: string): boolean {
  return (PIPELINE_BRANCHES as readonly string[]).includes(name);
}

/**
 * Whether `role` may route a workspace pull request `head` -> `base` (open or
 * merge). Allow-lists only:
 *
 *   admin, lead: any head, any base except the production branch.
 *   member:      a non-pipeline head into the working branch (feature -> dev),
 *                or the working branch into the QA branch (dev -> uat).
 *                Nothing else: no feature -> uat, nothing out of uat, nothing
 *                into main.
 *   qa, other:   nothing.
 */
export function isAllowedPullRequestRoute(
  role: PlatformAppRole,
  head: string,
  base: string,
): boolean {
  if (isProductionBranch(base)) return false;
  switch (role) {
    case 'admin':
    case 'lead':
      return true;
    case 'member':
      return (
        (base === WORKING_BRANCH && !isPipelineBranch(head)) ||
        (head === WORKING_BRANCH && base === QA_BRANCH)
      );
    default:
      return false;
  }
}

/**
 * Whether `role` may merge a workspace pull request `head` -> `base`, through
 * the generic `POST .../pull-requests/:number/merge` endpoint.
 *
 * Always false for the production branch, regardless of role: merging into
 * main happens only through QA Studio's promotion gate (canMergeQaPromotion
 * in qa-run-access.rules.ts), never through this generic endpoint.
 */
export function canMergeViaWorkspace(
  role: PlatformAppRole,
  base: string,
  head: string,
): boolean {
  return isAllowedPullRequestRoute(role, head, base);
}

/**
 * Whether `role` may open a pull request `head` -> `base`, through
 * `POST .../pull-requests`.
 *
 * Always false for the production branch, regardless of role: a pull
 * request into main is opened only by the promotion flow, never by a person.
 */
export function canCreatePullRequest(
  role: PlatformAppRole,
  base: string,
  head: string,
): boolean {
  return isAllowedPullRequestRoute(role, head, base);
}

const BROWSER_TEST_ROLES: readonly PlatformAppRole[] = [
  'admin',
  'lead',
  'member',
];

/**
 * Whether `role` may open the "Add browser tests" pull request into the
 * working branch. Allow-list: admin, lead and member (Developer). QA verifies
 * what is deployed and does not change the repository, so it is never in it,
 * and a role added later gets no write access until it is named here.
 */
export function canAddBrowserTests(
  role: PlatformAppRole | null | undefined,
): boolean {
  return role != null && BROWSER_TEST_ROLES.includes(role);
}

/** Repository branch creation is limited to Developers and project admins. */
export function canCreateWorkspaceBranch(
  role: PlatformAppRole | null | undefined,
): boolean {
  return role != null && BROWSER_TEST_ROLES.includes(role);
}

const HOSTING_CONFIG_ROLES: readonly PlatformAppRole[] = ['admin', 'member'];

/** Whether `role` may list, provision, validate, or delete a project's environment variables. */
export function canManageEnvVars(
  role: PlatformAppRole | null | undefined,
): boolean {
  return role != null && HOSTING_CONFIG_ROLES.includes(role);
}

/**
 * Whether `role` may add, change, verify or remove a project's hosting:
 * deployment targets and custom domains.
 */
export function canManageHosting(
  role: PlatformAppRole | null | undefined,
): boolean {
  return role != null && HOSTING_CONFIG_ROLES.includes(role);
}

/**
 * Whether `role` may reinstall a deployment target's CI secrets, or
 * disconnect a project (any variant, including the non-destructive one).
 */
export function canManageProjectLifecycle(role: PlatformAppRole): boolean {
  return PROJECT_MANAGEMENT_ROLES.includes(role);
}

const PROJECT_CREATOR_ROLES: readonly PlatformAppRole[] = ['admin', 'lead'];
const REPOSITORY_CREATOR_ROLES: readonly PlatformAppRole[] = [
  'admin',
  'member',
];

/**
 * Whether `role` may create a Project (an empty hierarchy delivery project):
 * Product owners ('lead') and admins. Developers and QA never do.
 */
export function canCreateProjectFolder(role: PlatformAppRole): boolean {
  return PROJECT_CREATOR_ROLES.includes(role);
}

/**
 * Whether `role` may create or onboard a repository (create wizard, existing
 * repo setup, hierarchy create, raw GitHub repo create): Developers ('member')
 * and admins. Product owners ('lead') and QA never do - leads make the Project,
 * developers fill it. Existing repositories are untouched by this rule.
 */
export function canCreateRepository(role: PlatformAppRole): boolean {
  return REPOSITORY_CREATOR_ROLES.includes(role);
}

/**
 * Whether a repository create by `role` must name an existing Project. Only
 * admins may omit it (the legacy auto-created Project); a Developer always
 * files the repository into a Project a Product owner already made.
 */
export function repositoryCreateRequiresProject(
  role: PlatformAppRole,
): boolean {
  return canCreateRepository(role) && role !== 'admin';
}

const REPOSITORY_FEATURE_GATED_ROLES: readonly PlatformAppRole[] = ['member'];

/**
 * Whether a repository create by `role` must wait for the Project to have at
 * least one active Feature (a functional requirement). Allow-list, Developers
 * ('member') only: Product owners write the Features first and developers
 * build against them. Admins are exempt; lead and qa are already refused
 * upstream (canCreateRepository), and an unresolved role matches nothing.
 */
export function repositoryCreateRequiresFeature(
  role: PlatformAppRole,
): boolean {
  return REPOSITORY_FEATURE_GATED_ROLES.includes(role);
}

/** Whether `role` may create or edit a Project's QA checklists (requirements). */
export function canManageRequirements(role: PlatformAppRole): boolean {
  return PROJECT_CREATOR_ROLES.includes(role);
}

const REPOSITORY_ASSIGNEE_ROLES: readonly PlatformAppRole[] = ['member'];

/**
 * Whether a user whose global app_role is `role` may be given a repository
 * ASSIGNMENT (which drives the GitHub team sync). Allow-list, Developers
 * ('member') only: QA and leads already see every repository in the team
 * through workspace membership, so an assignment would only grant GitHub push
 * access nobody in those personas is meant to have. Evaluated on the TARGET's
 * app_role, never on the derived group role (where qa also maps to 'member').
 */
export function canBeAssignedRepository(role: PlatformAppRole): boolean {
  return REPOSITORY_ASSIGNEE_ROLES.includes(role);
}

/**
 * The branch a self-service ALPHACI pull request (workflow settings, drift
 * repair, existing-repo setup) should target: the working tier `dev`, else
 * `uat`, never the production branch. Null when the repository has neither, in
 * which case the caller refuses (409) instead of falling back to main.
 */
export function selfServicePullRequestBase(
  existingBranches: Iterable<string>,
): string | null {
  const existing = new Set(existingBranches);
  for (const candidate of [WORKING_BRANCH, QA_BRANCH]) {
    if (existing.has(candidate)) return candidate;
  }
  return null;
}

/**
 * The branches `role` may see in the workspace branch list (§4, allow-list,
 * fail closed).
 *
 *   admin, lead: every branch.
 *   qa:          only the pipeline rungs (dev, uat, main) that exist.
 *   member:      every branch (read-only source browsing).
 *   anything else: dev only.
 *
 * Order of `branches` is preserved.
 */
export function visibleBranchesFor<T extends { name: string }>(
  role: string,
  branches: readonly T[],
): T[] {
  switch (role) {
    case 'admin':
    case 'lead':
      return [...branches];
    case 'qa':
      return branches.filter((b) =>
        (PIPELINE_BRANCHES as readonly string[]).includes(b.name),
      );
    case 'member':
      return [...branches];
    default:
      return branches.filter((b) => b.name === WORKING_BRANCH);
  }
}
