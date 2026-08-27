export type WorkflowFragmentBranch = 'uat' | 'main';

export interface WorkflowFragmentTarget {
  readonly provider: string;
  readonly slot: string;
  readonly deploymentStrategy: string;
  readonly rootDirectory?: string;
  readonly dockerContext?: string | null;
  readonly dockerfilePath?: string | null;
  readonly imageName?: string | null;
  /** Provider-owned secret names; keys are intentionally open-ended. */
  readonly secretNames?: Readonly<Record<string, string>>;
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
  build(
    target: WorkflowFragmentTarget,
    branch: WorkflowFragmentBranch,
    context: WorkflowFragmentContext,
  ): WorkflowFragmentResult | undefined;
}

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

  list(): WorkflowFragment[] {
    return [...this.fragmentsByProvider.values()];
  }
}
