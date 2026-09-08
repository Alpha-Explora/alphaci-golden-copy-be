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

export interface WorkflowFragment {
  readonly provider: string;
  expandTargets?(
    target: WorkflowTargetExpansionInput,
    context: WorkflowTargetExpansionContext,
  ): readonly WorkflowFragmentTarget[];
  build(
    target: WorkflowFragmentTarget,
    branch: WorkflowFragmentBranch,
    context: WorkflowFragmentContext,
  ): WorkflowFragmentResult | undefined;
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
}
