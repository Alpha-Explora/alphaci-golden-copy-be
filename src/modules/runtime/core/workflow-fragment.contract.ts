export type WorkflowFragmentBranch = 'uat' | 'main';

export interface WorkflowFragmentTarget {
  readonly provider: string;
  readonly slot: string;
  readonly branchName?: string;
  readonly deploymentStrategy: string;
  readonly rootDirectory?: string;
  readonly dockerContext?: string | null;
  readonly dockerfilePath?: string | null;
  readonly imageName?: string | null;
  /** Provider-owned secret names; keys are intentionally open-ended. */
  readonly secretNames?: Readonly<Record<string, string>>;
}

/** Provider-neutral input for expanding a provisioning request into targets. */
export interface WorkflowTargetExpansionInput {
  readonly provider: string;
  readonly slot: string;
  readonly ownershipMode?: string;
  readonly branchName?: string;
  readonly projectName?: string;
  readonly rootDirectory?: string;
  readonly dockerContext?: string;
  readonly dockerfilePath?: string;
  /** Provider-owned request fields; the core contract stays open-ended. */
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

/**
 * Provider-owned workflow contribution. Projects composes this result but
 * does not know provider job names, reusable workflow refs, or secret maps.
 */
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

/**
 * Nest composition token for provider-owned workflow fragments. Provider
 * modules contribute their fragments; the registry implementation never
 * imports a vendor adapter.
 */
export const WORKFLOW_FRAGMENTS = Symbol('WorkflowFragments');

/**
 * Generic plugin registry used by the workflow builder. It deliberately has
 * no vendor branches; provider modules contribute fragments at composition
 * time and duplicate ids fail fast.
 */
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

  list(): WorkflowFragment[] {
    return [...this.fragmentsByProvider.values()];
  }
}
