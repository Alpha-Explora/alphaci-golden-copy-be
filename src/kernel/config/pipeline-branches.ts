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

/** The reported stages of a generated pipeline, in the order they run. */
export type PipelineStageName = 'access' | 'quality' | 'package' | 'verify';

/**
 * Whether a generated pipeline runs this stage's work on this branch.
 *
 * The workflow generator and the run reader have to agree on this and neither
 * owns the other. The generator scopes jobs by branch (build and quality run on
 * every tier of the flow, the post-deploy tests only where something is hosted);
 * the reader had no idea, so a stage that is absent BY DESIGN on a branch -
 * verify on dev - was read as a stage that never arrived, resolved to
 * `stalled`, and turned a green run red.
 *
 *   access   runs on every ref the workflow triggers on, pull requests included
 *   quality  the tiers of the flow (PIPELINE_BRANCHES)
 *   package  the tiers of the flow (PIPELINE_BRANCHES)
 *   verify   only where there is a deployment to test (HOSTED_BRANCHES)
 *
 * Any other ref - a feature branch, a pull request's merge ref - has no
 * chained-stage work: those jobs are scoped out by branch and report nothing.
 */
export function stageRunsOnBranch(
  stage: PipelineStageName,
  branch: string,
): boolean {
  switch (stage) {
    case 'access':
      return true;
    case 'quality':
    case 'package':
      return (PIPELINE_BRANCHES as readonly string[]).includes(branch);
    case 'verify':
      return (HOSTED_BRANCHES as readonly string[]).includes(branch);
  }
}
/**
 * The generated workflow that deploys a promoted release to a later project
 * environment. The workflow generator writes it and Runtime dispatches it, so
 * the file name is declared once here.
 */
export const ENVIRONMENT_PROMOTE_WORKFLOW_FILE = '30-alphaci-promote.yml';

/**
 * Inputs of an environment pipeline's verify workflow: the address of the
 * deployed environment it tests. The generator declares them and ALPHACI
 * passes them when it starts the workflow, so they are named once here.
 */
export const VERIFY_UI_URL_INPUT = 'ui-url';
export const VERIFY_API_URL_INPUT = 'api-url';

const ACCESS_WORKFLOW_BASENAME = /^00-alphaci-access(-[a-z0-9]+)?.ya?ml$/i;

/**
 * A project's generated verify workflow file, from its stored workflow_path
 * (the access stage's file). Every stage of one bundle shares the suffix; a
 * path outside the naming convention falls back to no suffix.
 */
export function verifyWorkflowFileFor(
  workflowPath: string | null | undefined,
): string {
  const basename = workflowPath?.split('/').pop() ?? '';
  const suffix = ACCESS_WORKFLOW_BASENAME.exec(basename)?.[1] ?? '';
  return `30-alphaci-verify${suffix}.yml`;
}

/**
 * The branches a project's pipeline runs on. Its environments' source branches
 * come first, in position order, then the fixed tiers. `base` is where a
 * workflow fix is proposed: the first environment's branch, or the working tier
 * for a project with no environments. Projects set their own branch names, so
 * a fixed list alone can miss the branch that actually runs CI.
 */
export function projectPipelineBranches(
  environments: ReadonlyArray<{ sourceBranch: string }>,
): { base: string; branches: string[] } {
  const fromEnvironments = environments
    .map((environment) => environment.sourceBranch.trim())
    .filter((branch) => branch.length > 0);
  const branches = [
    ...new Set<string>([...fromEnvironments, ...PIPELINE_BRANCHES]),
  ];
  return { base: fromEnvironments[0] ?? WORKING_BRANCH, branches };
}
