/**
 * Branches a deployment fragment can target, in promotion order.
 *
 * `dev` is where work lands, `uat` is the QA tier that must pass before
 * promotion, and `main` is production. Fragments were previously typed to only
 * the last two, which is why the third environment that render-deploy.yml has
 * always supported was unreachable: the workflow could deploy it, the secrets
 * existed for it, and no caller could ask for it.
 */
export type WorkflowFragmentBranch = 'dev' | 'uat' | 'main';

export interface WorkflowFragmentTarget {
  readonly provider: string;
  readonly slot: string;
  readonly branchName?: string;
  readonly deploymentStrategy: string;
  readonly rootDirectory?: string;
  readonly dockerContext?: string | null;
  readonly dockerfilePath?: string | null;
  readonly imageName?: string | null;
  readonly secretNames?: Readonly<Record<string, string>>;
}

export interface WorkflowTargetExpansionInput {
  readonly provider: string;
  readonly slot: string;
  readonly ownershipMode?: string;
  readonly branchName?: string;
  readonly projectName?: string;
  readonly rootDirectory?: string;
  readonly dockerContext?: string;
  readonly dockerfilePath?: string;
  readonly providerData?: Readonly<Record<string, unknown>>;
}

export interface WorkflowTargetExpansionContext {
  readonly fallbackRootDirectory?: string;
}

export interface WorkflowFragmentContext {
  readonly serviceName: string;
  readonly servicePath: string;
  readonly centralWorkflowRef: string;
}

export interface WorkflowFragmentResult {
  readonly jobs: Record<string, unknown>;
  readonly jobIds: string[];
  readonly promotionNeeds: string[];
}
/** One environment target, named by IDs, for an environments-mode pipeline. */
export interface EnvironmentDeployInput {
  readonly environment: {
    readonly id: string;
    readonly slug: string;
    readonly sourceBranch: string;
    readonly role: 'production' | 'non_production';
  };
  readonly targetId: string;
  readonly needs: string[];
  readonly if: string;
  /** Full commit SHA expression to deploy. */
  readonly commitSha: string;
  /** image@sha256 reference expression, for providers that deploy a built image. */
  readonly artifact: string | undefined;
}

/**
 * The legacy `environment` input the reusable deploy workflows still require.
 * Environment and target identity travel in environment-id and target-id.
 */
export function legacyEnvironmentLabel(
  role: EnvironmentDeployInput['environment']['role'],
): 'production' | 'uat' {
  return role === 'production' ? 'production' : 'uat';
}

export interface WorkflowFragment {
  readonly provider: string;
  /** True when this provider deploys a container image the pipeline builds. */
  readonly deploysBuiltImage?: boolean;
  expandTargets?(
    target: WorkflowTargetExpansionInput,
    context: WorkflowTargetExpansionContext,
  ): readonly WorkflowFragmentTarget[];
  build(
    target: WorkflowFragmentTarget,
    branch: WorkflowFragmentBranch,
    context: WorkflowFragmentContext,
  ): WorkflowFragmentResult | undefined;
  /** The deploy job for one environment target in an environments-mode pipeline. */
  environmentDeployJob?(
    input: EnvironmentDeployInput,
    context: WorkflowFragmentContext,
  ): Record<string, unknown>;
}

export const WORKFLOW_FRAGMENTS = Symbol('WorkflowFragments');

export class WorkflowFragmentRegistry {
  private readonly fragmentsByProvider = new Map<string, WorkflowFragment>();

  constructor(fragments: readonly WorkflowFragment[] = []) {
    fragments.forEach((fragment) => this.register(fragment));
  }

  register(fragment: WorkflowFragment): void {
    if (!fragment.provider.trim()) {
      throw new Error('Workflow fragments must register a non-empty provider');
    }
    if (this.fragmentsByProvider.has(fragment.provider)) {
      throw new Error(
        `Duplicate workflow fragment provider: ${fragment.provider}`,
      );
    }
    this.fragmentsByProvider.set(fragment.provider, fragment);
  }

  get(provider: string): WorkflowFragment | undefined {
    return this.fragmentsByProvider.get(provider);
  }

  expandTargets(
    target: WorkflowTargetExpansionInput,
    context: WorkflowTargetExpansionContext,
  ): WorkflowFragmentTarget[] {
    const fragment = this.fragmentsByProvider.get(target.provider);
    if (!fragment) {
      throw new Error(
        `No workflow fragment registered for provider: ${target.provider}`,
      );
    }
    if (!fragment.expandTargets) {
      throw new Error(
        `Workflow fragment for provider '${target.provider}' does not implement target expansion`,
      );
    }

    return [...fragment.expandTargets(target, context)];
  }

  build(
    target: WorkflowFragmentTarget,
    branch: WorkflowFragmentBranch,
    context: WorkflowFragmentContext,
  ): WorkflowFragmentResult | undefined {
    return this.fragmentsByProvider
      .get(target.provider)
      ?.build(target, branch, context);
  }

  list(): WorkflowFragment[] {
    return [...this.fragmentsByProvider.values()];
  }

  deploysBuiltImage(provider: string): boolean {
    return this.fragmentsByProvider.get(provider)?.deploysBuiltImage === true;
  }

  environmentDeployJob(
    provider: string,
    input: EnvironmentDeployInput,
    context: WorkflowFragmentContext,
  ): Record<string, unknown> {
    const fragment = this.fragmentsByProvider.get(provider);
    if (!fragment?.environmentDeployJob) {
      throw new Error(
        `No environment deploy job is registered for provider: ${provider}`,
      );
    }
    return fragment.environmentDeployJob(input, context);
  }
}

/**
 * Repository VARIABLE holding the project's Vercel production hostname, from
 * which every branch's alias is derived.
 *
 * One variable rather than one per branch, and installed by provisioning
 * rather than by hand: the platform already knows the Vercel project name, so
 * asking someone to paste three hostnames was asking them to re-enter a value
 * the system had. It is a variable and not a secret because a `workflow_run`
 * stage can be handed a variable and never a secret, and because a hostname is
 * public by construction.
 *
 * A derived name carries one risk worth recording: `<branch>-<project>` has to
 * be free across all of Vercel, and `vercel alias set` only warns when it is
 * not. That warning is the signal to give this project an explicit hostname —
 * the variable is still a variable, so overriding it needs no code change.
 */
export const VERCEL_ALIAS_VARIABLE = 'VERCEL_ALIAS';

/**
 * The value written into {@link VERCEL_ALIAS_VARIABLE}.
 *
 * `<project>.vercel.app` is the domain Vercel assigns a project when it is
 * created, so it is already proven unique and already what `--prod` lands on.
 */
export function vercelAliasHost(projectName: string): string {
  return `${projectName.trim()}.vercel.app`;
}

/**
 * The hostname a given branch answers on.
 *
 * `main` needs no alias at all: a production deploy already lands on the base
 * host. Every other branch gets it as a prefix. Taking the stem as an argument
 * is what lets the deploy job, the verify stage and the provisioning writer
 * share one derivation while spelling the stem three different ways — an
 * Actions expression, a shell variable, and a literal hostname.
 */
export function vercelBranchAlias(branch: string, aliasStem: string): string {
  return branch === 'main' ? aliasStem : `${branch}-${aliasStem}`;
}
