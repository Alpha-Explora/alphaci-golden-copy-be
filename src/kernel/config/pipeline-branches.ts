import type { WorkflowFragmentBranch } from '#kernel/ports/workflow-fragment.port';

/**
 * The promotion flow, in order, for every provisioned repository.
 *
 *   dev  → where work lands, and the only tier developers push to directly.
 *   uat  → the QA tier, protected, reached by promotion from dev.
 *   main → production, protected, reached by promotion from uat.
 *
 * This lives in the kernel because two halves of the product have to agree on
 * it and neither owns the other: the workflow generator writes these names into
 * every `on: push:` trigger and branch condition, while repository provisioning
 * creates the branches and applies protection. They disagreed — provisioning
 * created `develop` while the generated pipelines listened on `dev` — and
 * nothing failed. The dev tier simply never ran: no workflow watched the branch
 * that existed, and the branch every workflow watched was never created.
 *
 * That is the shape of failure this file exists to prevent. A name is declared
 * once and both sides derive from it, so a future rename cannot reach one half
 * and not the other.
 */
export const PIPELINE_BRANCHES = [
  'dev',
  'uat',
  'main',
] as const satisfies readonly WorkflowFragmentBranch[];

export type PipelineBranch = (typeof PIPELINE_BRANCHES)[number];

/** Production, and the branch every provisioned repository starts on. */
export const DEFAULT_BRANCH = 'main' satisfies PipelineBranch;

/**
 * Branches provisioning creates from the default branch.
 *
 * Derived rather than listed: `main` already exists when a repository is
 * created, so the set is every other tier. Adding a tier to the flow above
 * makes it appear here without a second edit.
 */
export const BRANCHES_CREATED_ON_PROVISION = PIPELINE_BRANCHES.filter(
  (branch): branch is Exclude<PipelineBranch, typeof DEFAULT_BRANCH> =>
    branch !== DEFAULT_BRANCH,
);

/**
 * Branches that receive protection rules and required status checks.
 *
 * Everything above the working tier. `dev` is deliberately unprotected: it is
 * where developers push, and requiring a pull request there would make the
 * promotion flow start one step too late.
 */
export const PROTECTED_BRANCHES = PIPELINE_BRANCHES.filter(
  (branch) => branch !== PIPELINE_BRANCHES[0],
);

/**
 * Branches that get hosted infrastructure: a service, a deploy job, and an
 * address something can be tested against.
 *
 * `dev` is deliberately absent. It is where developers push, and a developer
 * runs their own branch locally — so a hosted dev tier is a service per
 * project that nobody visits, paid for on every plan and kept warm by nothing.
 * dev still builds and still runs the full quality stage; it simply has
 * nowhere to deploy to.
 *
 * Separate from PROTECTED_BRANCHES even though the two hold the same names
 * today. One answers "what may be pushed to directly" and the other answers
 * "what costs money to run" — and a future tier could easily be one without
 * being the other. Collapsing them would make that a silent change.
 *
 * Written out rather than derived so the list reads as a decision, with
 * `satisfies` keeping it tied to the flow: rename a tier above and this stops
 * compiling rather than quietly hosting a branch that no longer exists.
 */
export const HOSTED_BRANCHES = [
  'uat',
  'main',
] as const satisfies readonly PipelineBranch[];

export type HostedBranch = (typeof HOSTED_BRANCHES)[number];

/**
 * Every branch a provisioned repository ends up with, default branch included.
 *
 * Reported to the caller so the product can show what it actually created. The
 * frontend previously hardcoded this list on its own success screen and drifted
 * from the backend the moment the flow changed, telling users a branch had been
 * created that had not.
 */
export const PROVISIONED_BRANCHES: readonly string[] = [
  DEFAULT_BRANCH,
  ...BRANCHES_CREATED_ON_PROVISION,
];
