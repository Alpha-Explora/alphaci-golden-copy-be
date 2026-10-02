import type { WorkflowFragmentBranch } from '#kernel/ports/workflow-fragment.port';

/**
 * The promotion flow, in order, for every provisioned repository.
 *
 *   dev  → where work lands, reached by pull request from a feature branch.
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

/** The working tier work lands on; first rung of the promotion flow. */
export const WORKING_BRANCH = PIPELINE_BRANCHES[0];

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
 * Every tier of the flow. Nobody pushes to any of them directly: work reaches
 * `dev` through a pull request from a feature branch, `uat` from `dev`, and
 * `main` only through QA Studio's "Merge to main". `dev` used to be left
 * unprotected so developers could push to it, and that is exactly how commits
 * landed with no pull request, no review trail and nothing in the Pull
 * requests list. The rule is "pull request required, zero approvals" so
 * ALPHACI-driven merges keep working; see GithubService.ensurePullRequestProtection.
 */
export const PROTECTED_BRANCHES: readonly PipelineBranch[] = PIPELINE_BRANCHES;

/**
 * Branches that get hosted infrastructure: a service, a deploy job, and an
 * address something can be tested against.
 *
 * `dev` is deliberately absent. It is where work lands, and a developer
 * runs their own branch locally — so a hosted dev tier is a service per
 * project that nobody visits, paid for on every plan and kept warm by nothing.
 * dev still builds and still runs the full quality stage; it simply has
 * nowhere to deploy to.
 *
 * Separate from PROTECTED_BRANCHES. One answers "what needs a pull request"
 * and the other answers "what costs money to run" — and a future tier could easily be one without
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
 * The branch QA verifies. QA runs, QA Studio and the promotion gate read this
 * one name: uat is the hosted QA tier (see the promotion model in
 * staged-workflow.builder.ts), and a verdict on main would be a verdict on
 * what is already in production. Promotion then carries a QA-approved uat
 * commit to TARGET branch main.
 *
 * `satisfies` ties it to the hosted list: a QA branch that is not deployed
 * would have nothing to preview.
 */
export const QA_BRANCH = 'uat' satisfies HostedBranch;

/** Where a QA-approved uat commit is promoted to. */
export const QA_PROMOTION_TARGET_BRANCH = DEFAULT_BRANCH satisfies HostedBranch;

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
